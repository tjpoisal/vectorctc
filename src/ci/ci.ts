import { execFileSync } from "node:child_process";
import path from "node:path";
import { minimatch } from "minimatch";

import type { Violation } from "../engine/types.js";
import type { Explanation } from "../explain/explain.js";
import { ticketCoverage, type CriterionCoverage } from "../intent/intent.js";
import { isDependencyFile } from "../security/lockfiles.js";
import { resolveContract } from "../universal/contract.js";
import { checkContent } from "../universal/check.js";

/**
 * `ctc ci` (v0.4): the same gate as a required PR check. Every file the PR changes is judged against its
 * merge-base text (so only the PR's own lines count), the result is a ctc.ci.v1 report, GitHub
 * annotations, and one sticky PR comment. Opt-in auto-approve is explainable: every risk factor is
 * listed with its value, and any single failing factor withholds approval.
 */

export const CI_PROTOCOL = "ctc.ci.v1";
export const COMMENT_MARKER = "<!-- vectorctc:report -->";

export const DEFAULT_SENSITIVE = [
  "**/auth/**",
  "**/security/**",
  "**/payments/**",
  "**/billing/**",
  "**/migrations/**",
  "**/*.sql",
  ".github/**",
  "**/Dockerfile",
  "**/*.tf",
  "**/.env*",
  "**/package.json",
  "**/go.mod",
  "**/requirements*.txt",
  "ctc.config.json",
  ".ctc/**",
  "**/.ctc-policy.json",
];

export interface CiOptions {
  base: string;
  head?: string;
  /** Hold findings outside the milestone's allowed paths. Off by default: scope is an agent-session concept. */
  scope?: boolean;
  autoApprove?: boolean;
  maxChangedLines?: number;
  maxFiles?: number;
  sensitive?: string[];
  /** Ticket / PR body the diff should implement: acceptance-criteria coverage goes in the report. */
  ticket?: string | null;
}

export interface CiFile {
  file: string;
  status: "added" | "modified" | "renamed" | "deleted";
  changedLines: number;
  holds: Violation[];
  observed: Violation[];
  explanations: Explanation[];
}

export interface RiskFactor {
  id: string;
  ok: boolean;
  detail: string;
}

export interface CiReport {
  protocol: typeof CI_PROTOCOL;
  base: string;
  head: string;
  cleared: boolean;
  files: CiFile[];
  holds: number;
  observed: number;
  risk: { level: "low" | "elevated"; factors: RiskFactor[]; approvable: boolean };
  /** Acceptance criteria from the ticket and whether the diff touches each (null when no ticket). */
  ticket: CriterionCoverage[] | null;
  ms: number;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function show(root: string, ref: string, file: string): string | null {
  try {
    return git(root, ["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

export function changedFiles(root: string, base: string, head: string): Array<{ file: string; status: CiFile["status"]; from?: string }> {
  const out: Array<{ file: string; status: CiFile["status"]; from?: string }> = [];
  for (const line of git(root, ["diff", "--name-status", "-M", `${base}...${head}`]).split("\n")) {
    if (!line.trim()) continue;
    const [code, a, b] = line.split("\t");
    if (!code || !a) continue;
    if (code.startsWith("R") && b) out.push({ file: b, status: "renamed", from: a });
    else if (code === "A") out.push({ file: a, status: "added" });
    else if (code === "D") out.push({ file: a, status: "deleted" });
    else out.push({ file: a, status: "modified" });
  }
  return out;
}

function numstat(root: string, base: string, head: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of git(root, ["diff", "--numstat", "-M", `${base}...${head}`]).split("\n")) {
    const [added, removed, file] = line.split("\t");
    if (!file) continue;
    const name = file.includes("=>") ? file.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/.* => /, "") : file;
    out.set(name, (Number(added) || 0) + (Number(removed) || 0));
  }
  return out;
}

export function runCi(rootInput: string, options: CiOptions): CiReport {
  const t0 = performance.now();
  const root = path.resolve(rootInput);
  const head = options.head ?? "HEAD";
  const mergeBase = git(root, ["merge-base", options.base, head]).trim();
  const changes = changedFiles(root, mergeBase, head);
  const sizes = numstat(root, mergeBase, head);
  const files: CiFile[] = [];
  const texts: Array<{ file: string; before: string | null; after: string }> = [];
  for (const change of changes.slice(0, options.maxFiles ?? 300)) {
    const changedLines = sizes.get(change.file) ?? 0;
    if (change.status === "deleted") {
      files.push({ file: change.file, status: change.status, changedLines, holds: [], observed: [], explanations: [] });
      continue;
    }
    const content = show(root, head, change.file);
    if (content === null || content.includes("\u0000")) continue;
    const baseline = show(root, mergeBase, change.from ?? change.file);
    texts.push({ file: change.file, before: baseline, after: content });
    const outcome = checkContent(root, change.file, content, { baseline, surface: "ci", record: false });
    if (!("violations" in outcome.payload)) {
      files.push({ file: change.file, status: change.status, changedLines, holds: [], observed: [], explanations: [] });
      continue;
    }
    const payload = outcome.payload;
    const holds = payload.violations.filter((item) => options.scope || (item.code !== "OUTSIDE_FLIGHT_PLAN" && item.code !== "NO_FLIGHT_PLAN"));
    const observed = payload.warnings ?? [];
    const explanations = (payload.explain?.explanations ?? []).filter((item) => options.scope || (item.code !== "OUTSIDE_FLIGHT_PLAN" && item.code !== "NO_FLIGHT_PLAN"));
    files.push({ file: change.file, status: change.status, changedLines, holds, observed, explanations: explanations.map((item) => (item.fix.sensitive ? { ...item, fix: { ...item.fix, hunks: [] } } : item)) });
  }
  const holds = files.reduce((sum, item) => sum + item.holds.length, 0);
  const observed = files.reduce((sum, item) => sum + item.observed.length, 0);
  const maxLines = options.maxChangedLines ?? 40;
  const totalLines = files.reduce((sum, item) => sum + item.changedLines, 0);
  const sensitive = options.sensitive ?? DEFAULT_SENSITIVE;
  const touchedSensitive = files.filter((item) => sensitive.some((glob) => minimatch(item.file, glob, { dot: true }))).map((item) => item.file);
  const factors: RiskFactor[] = [
    { id: "gate", ok: holds === 0, detail: holds === 0 ? "No gate holds." : `${holds} gate hold(s).` },
    { id: "observe", ok: observed === 0, detail: observed === 0 ? "No observe-mode findings." : `${observed} observe-mode finding(s) would block under enforce.` },
    { id: "size", ok: totalLines <= maxLines, detail: `${totalLines} changed line(s); limit ${maxLines}.` },
    { id: "files", ok: files.length <= 10, detail: `${files.length} file(s); limit 10.` },
    { id: "sensitive-paths", ok: touchedSensitive.length === 0, detail: touchedSensitive.length === 0 ? "No sensitive paths." : `Touches ${touchedSensitive.slice(0, 5).join(", ")}.` },
    { id: "dependencies", ok: !files.some((item) => isDependencyFile(item.file)), detail: files.some((item) => isDependencyFile(item.file)) ? "Changes a manifest or lockfile." : "No dependency changes." },
    { id: "deletions", ok: !files.some((item) => item.status === "deleted"), detail: files.some((item) => item.status === "deleted") ? "Deletes file(s)." : "No deleted files." },
    { id: "truncated", ok: changes.length <= (options.maxFiles ?? 300), detail: changes.length <= (options.maxFiles ?? 300) ? "Every changed file was checked." : `Only the first ${options.maxFiles ?? 300} of ${changes.length} files were checked.` },
  ];
  let ticketText = options.ticket ?? null;
  if (!ticketText) {
    const contract = resolveContract(root);
    ticketText = contract.ok ? contract.plan.ticket ?? null : null;
  }
  const coverage = ticketText ? ticketCoverage(ticketText, texts) : null;
  if (coverage && coverage.length > 0) {
    const missing = coverage.filter((item) => !item.covered);
    factors.push({ id: "ticket", ok: missing.length === 0, detail: missing.length === 0 ? `All ${coverage.length} acceptance criteria are touched by the diff.` : `${missing.length} of ${coverage.length} acceptance criteria have no matching change: ${missing.slice(0, 3).map((item) => `"${item.criterion.slice(0, 60)}"`).join(", ")}.` });
  }
  const low = factors.every((factor) => factor.ok);
  return {
    protocol: CI_PROTOCOL,
    base: mergeBase,
    head,
    cleared: holds === 0,
    files,
    holds,
    observed,
    risk: { level: low ? "low" : "elevated", factors, approvable: low && options.autoApprove === true },
    ticket: coverage,
    ms: Math.round(performance.now() - t0),
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function ciMarkdown(report: CiReport): string {
  const lines = [COMMENT_MARKER];
  lines.push(report.cleared ? `### ✅ VectorCTC gate: cleared` : `### ❌ VectorCTC gate: ${report.holds} hold(s)`);
  lines.push("", `Checked ${report.files.length} changed file(s) against the merge base \`${report.base.slice(0, 10)}\` in ${report.ms} ms. Deterministic: the same diff always gets the same result.`);
  const rows = report.files.flatMap((file) => file.holds.map((item) => `| \`${file.file}:${item.line ?? "-"}\` | \`${item.code}\` | ${escapeCell(item.message)} | ${escapeCell(item.fix)} |`));
  if (rows.length > 0) lines.push("", "| Where | Rule | What | Fix |", "|---|---|---|---|", ...rows);
  const observed = report.files.flatMap((file) => file.observed.map((item) => `- \`${file.file}:${item.line ?? "-"}\` \`${item.code}\`: ${item.message}`));
  if (observed.length > 0) lines.push("", `<details><summary>${observed.length} observe-mode finding(s) (would block under enforce)</summary>`, "", ...observed, "", "</details>");
  const patches = report.files.flatMap((file) => file.explanations.filter((item) => item.fix.patch && !item.fix.sensitive).map((item) => ({ file: file.file, item })));
  if (patches.length > 0) {
    lines.push("", "<details><summary>Suggested fixes (verified patches the agent can apply with <code>ctc fix</code>)</summary>", "");
    for (const { file, item } of patches.slice(0, 20)) lines.push(`**${item.code}** in \`${file}\` — ${item.fix.summary}`, "", "```diff", (item.fix.patch ?? "").trimEnd(), "```", "");
    lines.push("</details>");
  }
  if (report.ticket && report.ticket.length > 0) {
    lines.push("", "<details><summary>Ticket coverage (term match, not a judgement of correctness)</summary>", "", "| Criterion | Touched by |", "|---|---|");
    for (const item of report.ticket) lines.push(`| ${item.covered ? "✅" : "⬜"} ${escapeCell(item.criterion)} | ${item.files.map((file) => `\`${file}\``).join(", ") || "—"} |`);
    lines.push("", "</details>");
  }
  lines.push("", `<details><summary>Risk: ${report.risk.level}${report.risk.approvable ? " — auto-approved" : ""}</summary>`, "");
  for (const factor of report.risk.factors) lines.push(`- ${factor.ok ? "✅" : "⚠️"} **${factor.id}**: ${factor.detail}`);
  lines.push("", "</details>");
  return `${lines.join("\n")}\n`;
}

export function ciAnnotations(report: CiReport): string {
  const out: string[] = [];
  for (const file of report.files) {
    for (const item of file.holds) out.push(`::error file=${file.file},line=${item.line ?? 1},title=${item.code}::${item.message.replace(/\r?\n/g, " ")} Fix: ${item.fix.replace(/\r?\n/g, " ")}`);
    for (const item of file.observed) out.push(`::warning file=${file.file},line=${item.line ?? 1},title=${item.code} (observe)::${item.message.replace(/\r?\n/g, " ")}`);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
