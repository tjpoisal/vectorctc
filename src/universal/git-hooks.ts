import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { checkContent } from "./check.js";

const SKIP = new Set(["node_modules", "dist", "coverage", ".git", ".ctc"]);

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function listed(root: string, args: string[]): string[] {
  try {
    const output = git(root, args);
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.split("/").some((part) => SKIP.has(part)));
  } catch {
    return [];
  }
}

export function stagedFiles(root: string): string[] {
  return listed(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
}

export function pushFiles(root: string, stdin: string): Array<{ file: string; sha: string; base: string }> {
  const files = new Map<string, { sha: string; base: string }>();
  const lines = stdin.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const local = parts[1];
    const remote = parts[3];
    if (!local || !remote) continue;
    const names = /^0+$/.test(remote)
      ? listed(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", local])
      : listed(root, ["diff", "--name-only", remote, local]);
    const base = /^0+$/.test(remote) ? `${local}~1` : remote;
    for (const file of names) files.set(file, { sha: local, base });
  }
  return [...files.entries()].map(([file, item]) => ({ file, ...item }));
}

function stagedContent(root: string, relative: string): string | null {
  try {
    return git(root, ["show", `:${relative}`]);
  } catch {
    return null;
  }
}

function commitContent(root: string, sha: string, relative: string): string | null {
  try {
    return git(root, ["show", `${sha}:${relative}`]);
  } catch {
    return null;
  }
}

export interface GuardOptions {
  /** Also hold files outside the milestone's allowed paths. Off by default, as in `ctc ci`: scope is an agent-session concept. */
  scope?: boolean;
}

const SCOPE_CODES = new Set(["OUTSIDE_FLIGHT_PLAN", "NO_FLIGHT_PLAN"]);

export function guardFiles(root: string, files: readonly string[], options: GuardOptions = {}): { exitCode: 0 | 2; holds: Array<{ file: string; message: string }> } {
  // Diff-aware rules compare the staged file with HEAD (a new file has no baseline).
  const pairs = files.map((file) => ({ file, content: stagedContent(root, file), baseline: commitContent(root, "HEAD", file) }));
  return guardContents(root, pairs, options);
}

export function guardPush(root: string, stdin: string, options: GuardOptions = {}): { exitCode: 0 | 2; holds: Array<{ file: string; message: string }> } {
  const pairs = pushFiles(root, stdin).map((item) => ({ file: item.file, content: commitContent(root, item.sha, item.file), baseline: commitContent(root, item.base, item.file) }));
  return guardContents(root, pairs, options);
}

function guardContents(root: string, files: readonly { file: string; content: string | null; baseline: string | null }[], options: GuardOptions): { exitCode: 0 | 2; holds: Array<{ file: string; message: string }> } {
  const holds: Array<{ file: string; message: string }> = [];
  for (const item of files) {
    if (item.file.includes("\0") || item.content === null || item.content.includes("\0")) continue;
    const outcome = checkContent(root, item.file, item.content, { baseline: item.baseline });
    if (outcome.exitCode === 0) continue;
    const violations = "violations" in outcome.payload && Array.isArray(outcome.payload.violations) ? (outcome.payload.violations as Array<{ code?: string; severity?: string }>) : null;
    if (!options.scope && violations && violations.length > 0 && violations.filter((v) => v.severity !== "warn").every((v) => SCOPE_CODES.has(v.code ?? ""))) continue;
    const message = "message" in outcome.payload ? outcome.payload.message : outcome.payload.selfCorrection ?? "CTC hold.";
    holds.push({ file: item.file, message });
  }
  return { exitCode: holds.length > 0 ? 2 : 0, holds };
}

export function installGitHooks(root: string, command: readonly string[]): { preCommit: string; prePush: string } {
  const hooks = path.join(root, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const quoted = command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
  const write = (name: string, kind: "pre-commit" | "pre-push"): string => {
    const file = path.join(hooks, name);
    const body = `#!/bin/sh\nexec ${quoted} git-guard ${kind} --root '${root.replaceAll("'", `'\\''`)}'\n`;
    fs.writeFileSync(file, body, "utf8");
    fs.chmodSync(file, 0o755);
    return file;
  };
  return { preCommit: write("pre-commit", "pre-commit"), prePush: write("pre-push", "pre-push") };
}
