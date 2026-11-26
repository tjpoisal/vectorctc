import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCi } from "../ci/ci.js";
import { scanProject, writeScan } from "../scanner/repo-scanner.js";

/**
 * Zero-setup trial (v0.5): `ctc try` replays the last N commits through the gate and prints what it would have
 * held, by rule. It never touches the user's repo: it makes a throwaway `git clone --shared --no-checkout` in the
 * OS temp dir (read-only use of the repo's objects, no worktree registered, no config written), checks out each
 * commit there, judges every changed file against its parent exactly like `ctc ci`, and deletes the clone. It
 * needs no ctc.config.json (a committed one is honoured). The run stops at a time limit and reports what it covered.
 */

export const TRY_PROTOCOL = "ctc.try.v1";

export interface TryOptions {
  commits?: number;
  timeoutSeconds?: number;
  maxFilesPerCommit?: number;
  ref?: string;
}

export interface TryHold {
  commit: string;
  subject: string;
  file: string;
  code: string;
  rule: string;
  line: number | null;
  message: string;
}

export interface TryReport {
  protocol: typeof TRY_PROTOCOL;
  requested: number;
  checked: number;
  skipped: Array<{ commit: string; reason: string }>;
  timedOut: boolean;
  /** True when the repo has no ctc.config.json and the trial inferred one (in the temp clone only). */
  inferredConfig: boolean;
  commitsHeld: number;
  filesChecked: number;
  holds: TryHold[];
  byRule: Array<{ code: string; rule: string; holds: number; commits: number }>;
  ms: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function runTry(rootInput: string, options: TryOptions = {}): TryReport {
  const t0 = performance.now();
  const requested = Math.max(1, Math.min(500, Math.floor(options.commits ?? 50)));
  const deadline = Date.now() + Math.max(5, options.timeoutSeconds ?? 60) * 1000;
  let root: string;
  try {
    root = git(path.resolve(rootInput), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("ctc try needs a git repository (run it inside one, or pass --root).");
  }
  const ref = options.ref ?? "HEAD";
  const log = git(root, ["log", "--first-parent", `--max-count=${requested}`, "--format=%H%x00%P%x00%s", ref]).split("\n").filter(Boolean);
  const commits = log.map((line) => {
    const [sha = "", parents = "", subject = ""] = line.split("\u0000");
    return { sha, parent: parents.split(" ")[0] || null, subject };
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vectorctc-try-"));
  const saved = { log: process.env.CTC_FINDINGS_LOG, replay: process.env.CTC_REPLAY };
  process.env.CTC_FINDINGS_LOG = "off";
  process.env.CTC_REPLAY = "off";
  const skipped: TryReport["skipped"] = [];
  const holds: TryHold[] = [];
  let checked = 0;
  let filesChecked = 0;
  let timedOut = false;
  const report = { inferredConfig: false };
  try {
    const clone = path.join(tmp, "repo");
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, clone], { stdio: ["ignore", "ignore", "pipe"] });
    // Reuse installed dependencies read-only so imports of real packages resolve.
    const modules = path.join(root, "node_modules");
    if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(clone, "node_modules"), "dir");
    // Zero setup: with no committed ctc.config.json, infer one in the throwaway clone the way `ctc scan` does.
    // Lockfile locks are left out: history edits to lockfiles are not agent writes and would only add noise.
    // Newest first, so a time limit cuts off the oldest history rather than the most relevant.
    const newest = commits[0];
    let inferredConfig = false;
    if (newest) {
      git(clone, ["checkout", "--quiet", "--force", "--detach", newest.sha]);
      if (!fs.existsSync(path.join(clone, "ctc.config.json"))) {
        const scan = scanProject(clone);
        scan.config.lockedFiles = [];
        writeScan(clone, scan, { force: true });
        fs.appendFileSync(path.join(clone, ".git", "info", "exclude"), "\n/ctc.config.json\n/.ctc/\n/node_modules\n");
        inferredConfig = true;
      }
    }
    report.inferredConfig = inferredConfig;
    for (const commit of commits) {
      if (Date.now() > deadline) {
        timedOut = true;
        skipped.push({ commit: commit.sha.slice(0, 7), reason: "time limit" });
        continue;
      }
      if (!commit.parent) {
        skipped.push({ commit: commit.sha.slice(0, 7), reason: "root commit (no parent to compare against)" });
        continue;
      }
      try {
        git(clone, ["checkout", "--quiet", "--force", "--detach", commit.sha]);
        const report = runCi(clone, { base: commit.parent, head: commit.sha, maxFiles: options.maxFilesPerCommit ?? 25 });
        checked += 1;
        filesChecked += report.files.length;
        for (const file of report.files) {
          for (const hold of file.holds) holds.push({ commit: commit.sha.slice(0, 7), subject: commit.subject.slice(0, 80), file: file.file, code: hold.code, rule: hold.rule, line: hold.line, message: hold.message });
        }
      } catch (error) {
        skipped.push({ commit: commit.sha.slice(0, 7), reason: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 120) : "error" });
      }
    }
  } finally {
    if (saved.log === undefined) delete process.env.CTC_FINDINGS_LOG;
    else process.env.CTC_FINDINGS_LOG = saved.log;
    if (saved.replay === undefined) delete process.env.CTC_REPLAY;
    else process.env.CTC_REPLAY = saved.replay;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const byCode = new Map<string, { rule: string; holds: number; commits: Set<string> }>();
  for (const hold of holds) {
    const entry = byCode.get(hold.code) ?? { rule: hold.rule, holds: 0, commits: new Set<string>() };
    entry.holds += 1;
    entry.commits.add(hold.commit);
    byCode.set(hold.code, entry);
  }
  return {
    protocol: TRY_PROTOCOL,
    requested,
    checked,
    skipped,
    timedOut,
    inferredConfig: report.inferredConfig,
    commitsHeld: new Set(holds.map((item) => item.commit)).size,
    filesChecked,
    holds,
    byRule: [...byCode.entries()].map(([code, value]) => ({ code, rule: value.rule, holds: value.holds, commits: value.commits.size })).sort((a, b) => b.holds - a.holds || a.code.localeCompare(b.code)),
    ms: Math.round(performance.now() - t0),
  };
}

export function renderTryText(report: TryReport): string {
  const lines = [`VectorCTC try: replayed ${report.checked} of the last ${report.requested} commits (${report.filesChecked} changed files) in ${(report.ms / 1000).toFixed(1)}s.`];
  if (report.timedOut) lines.push(`Stopped at the time limit; ${report.skipped.filter((item) => item.reason === "time limit").length} commits not checked (raise --timeout).`);
  lines.push(`Your repo was not modified: the replay ran in a temporary clone that has been deleted.${report.inferredConfig ? " No ctc.config.json was found, so one was inferred in that clone (as `ctc scan` would)." : ""}`, "");
  if (report.holds.length === 0) {
    lines.push("The gate would have held nothing in these commits.");
  } else {
    lines.push(`Would have held ${report.commitsHeld} commit(s), ${report.holds.length} finding(s). By rule:`);
    for (const item of report.byRule) lines.push(`  ${item.code.padEnd(28)} ${String(item.holds).padStart(4)} hold(s) in ${item.commits} commit(s)   (${item.rule})`);
    lines.push("", "Examples:");
    for (const hold of report.holds.slice(0, 10)) lines.push(`  ${hold.commit} ${hold.file}${hold.line ? `:${hold.line}` : ""}  ${hold.code}  ${hold.message.slice(0, 110)}`);
  }
  const other = report.skipped.filter((item) => item.reason !== "time limit");
  if (other.length) lines.push("", `Skipped ${other.length}: ${other.slice(0, 5).map((item) => `${item.commit} (${item.reason})`).join("; ")}`);
  lines.push("", "Next: `npx vectorctc init` to gate your agent's writes before they land.");
  return `${lines.join("\n")}\n`;
}
