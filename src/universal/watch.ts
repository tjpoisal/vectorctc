import fs from "node:fs";
import path from "node:path";

import { ensureDir, toPosix } from "../paths.js";
import { checkContent } from "./check.js";

const IGNORE = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next"]);

export interface WatchEvent {
  ts: string;
  file: string;
  reverted: boolean;
  violations: string[];
}

function snapshotPath(root: string, relative: string): string {
  return path.join(root, ".ctc", "snapshots", relative);
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORE.has(entry.name) || entry.name === "ctc.config.json") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(toPosix(path.relative(root, absolute)));
  }
}

function remember(root: string, relative: string, content: string): void {
  const file = snapshotPath(root, relative);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

export function startWatch(rootInput: string, options: { revert?: boolean; debounceMs?: number; onEvent?: (event: WatchEvent) => void } = {}): { stop: () => void } {
  const root = path.resolve(rootInput);
  const log = path.join(root, ".ctc", "violations.jsonl");
  ensureDir(path.dirname(log));
  const reverting = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const debounce = options.debounceMs ?? 80;

  const inspect = (relative: string): void => {
    if (reverting.has(relative)) return;
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
    let content = "";
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      return;
    }
    if (content.includes("\0")) return;
    // Diff-aware rules compare with the last good snapshot; with none yet, everything counts as new.
    const snapPath = snapshotPath(root, relative);
    const outcome = checkContent(root, relative, content, { baseline: fs.existsSync(snapPath) ? fs.readFileSync(snapPath, "utf8") : null });
    if (outcome.exitCode === 0) {
      remember(root, relative, content);
      return;
    }
    if (outcome.exitCode === 1) return;
    const violations = "violations" in outcome.payload ? outcome.payload.violations.map((item) => `${item.code}: ${item.message}`) : ["message" in outcome.payload ? outcome.payload.message : "hold"];
    const snap = snapshotPath(root, relative);
    let reverted = false;
    if (options.revert && fs.existsSync(snap)) {
      reverting.add(relative);
      fs.writeFileSync(absolute, fs.readFileSync(snap));
      reverted = true;
      setTimeout(() => reverting.delete(relative), debounce + 50);
    }
    const event: WatchEvent = { ts: new Date().toISOString(), file: relative, reverted, violations };
    fs.appendFileSync(log, `${JSON.stringify(event)}\n`, "utf8");
    options.onEvent?.(event);
    process.stderr.write(`CTC watch ${relative}: ${violations[0] ?? "hold"}${reverted ? " (reverted)" : ""}\n`);
  };

  const files: string[] = [];
  walk(root, root, files);
  for (const relative of files) inspect(relative);

  const watcher = fs.watch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const relative = toPosix(name.toString());
    if (relative === "ctc.config.json" || relative.split("/").some((part) => part.startsWith(".") || IGNORE.has(part))) return;
    const pending = timers.get(relative);
    if (pending) clearTimeout(pending);
    timers.set(relative, setTimeout(() => {
      timers.delete(relative);
      inspect(relative);
    }, debounce));
  });

  return {
    stop: () => {
      watcher.close();
      for (const timer of timers.values()) clearTimeout(timer);
    },
  };
}
