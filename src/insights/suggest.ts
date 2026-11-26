import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isSafeRegExp } from "../engine/safe-regex.js";
import { PolicyFileSchema } from "../policy/policy.js";
import { listReplays } from "../replay/store.js";
import { windowRecords } from "./records.js";

/**
 * Rule suggestions (v0.5): read the local hold history (.ctc/findings.jsonl and .ctc/replays) and propose
 * repo-specific policy entries. Deterministic heuristics, no model:
 *   graduate — a code that keeps firing in observe mode is ready to enforce;
 *   lock     — holds for one code concentrate in one directory: enforce and lock it there so a directory
 *              policy cannot weaken it;
 *   forbid   — agents keep reaching for the same missing or banned module: a forbid rule with a repo-specific
 *              message stops it earlier and tells the agent why.
 * Nothing is written until `ctc suggest-rules --accept <id>`, which merges the entry into .ctc/policy.json.
 */

export const SUGGEST_PROTOCOL = "ctc.suggest-rules.v1";

export interface RuleSuggestion {
  id: string;
  kind: "graduate" | "lock" | "forbid";
  title: string;
  reason: string;
  evidence: { count: number; files: string[] };
  policy: { rules?: Record<string, { mode?: "enforce" | "observe" | "off"; locked?: boolean; paths?: string[] }>; forbid?: Array<{ id: string; pattern: string; message: string; fix?: string; paths?: string[] }> };
}

const MIN_OBSERVED = 3;
const MIN_HOLDS = 3;
const CONCENTRATION = 0.8;
const MIN_MODULE_REPEATS = 2;

function suggestionId(kind: string, key: string): string {
  return `s-${crypto.createHash("sha256").update(`${kind}\u0000${key}`).digest("hex").slice(0, 8)}`;
}

function topDir(file: string): string | null {
  const parts = file.split("/");
  if (parts.length < 2) return null;
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function suggestRules(root: string, options: { days?: number; now?: Date } = {}): { protocol: typeof SUGGEST_PROTOCOL; windowDays: number; decisions: number; suggestions: RuleSuggestion[] } {
  const days = options.days ?? 90;
  const records = windowRecords([root], { days, ...(options.now ? { now: options.now } : {}) });
  const suggestions: RuleSuggestion[] = [];

  const observed = new Map<string, Set<string>>();
  const observedCount = new Map<string, number>();
  const holds = new Map<string, string[]>();
  for (const record of records) {
    for (const finding of record.findings) {
      if (finding.severity === "observe") {
        observed.set(finding.code, (observed.get(finding.code) ?? new Set()).add(record.file));
        observedCount.set(finding.code, (observedCount.get(finding.code) ?? 0) + 1);
      } else if (finding.severity === "block" && record.decision === "held") {
        holds.set(finding.code, [...(holds.get(finding.code) ?? []), record.file]);
      }
    }
  }

  for (const [code, files] of observed) {
    const count = observedCount.get(code) ?? 0;
    if (count < MIN_OBSERVED) continue;
    suggestions.push({
      id: suggestionId("graduate", code),
      kind: "graduate",
      title: `Enforce ${code}`,
      reason: `${code} fired ${count} times in observe mode across ${files.size} file(s) in the last ${days} days. Each of those writes would have been held under enforce.`,
      evidence: { count, files: [...files].slice(0, 10) },
      policy: { rules: { [code]: { mode: "enforce" } } },
    });
  }

  for (const [code, files] of holds) {
    if (files.length < MIN_HOLDS) continue;
    const dirs = new Map<string, number>();
    for (const file of files) {
      const dir = topDir(file);
      if (dir) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    const [dir, inDir] = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (!dir || inDir / files.length < CONCENTRATION) continue;
    suggestions.push({
      id: suggestionId("lock", `${code}\u0000${dir}`),
      kind: "lock",
      title: `Lock ${code} in ${dir}/`,
      reason: `${inDir} of ${files.length} ${code} holds were in ${dir}/. Locking the rule there means a .ctc-policy.json in that directory can make it stricter but never switch it to observe or off.`,
      evidence: { count: inDir, files: [...new Set(files.filter((file) => file.startsWith(`${dir}/`)))].slice(0, 10) },
      policy: { rules: { [code]: { mode: "enforce", locked: true, paths: [`${dir}/**`] } } },
    });
  }

  const modules = new Map<string, { codes: Set<string>; files: Set<string>; count: number }>();
  for (const replay of listReplays(root, 200)) {
    if (Date.parse(replay.ts) < (options.now ?? new Date()).getTime() - days * 86_400_000) continue;
    for (const item of replay.explanations) {
      if (!/IMPORT|PACKAGE/.test(item.code)) continue;
      const match = /(?:Module|module|package|Package|import)?\s*['"`]([@\w./-]{1,100})['"`]/.exec(item.message);
      const name = match?.[1];
      if (!name || name.startsWith(".")) continue;
      const entry = modules.get(name) ?? { codes: new Set(), files: new Set(), count: 0 };
      entry.codes.add(item.code);
      entry.files.add(replay.file);
      entry.count += 1;
      modules.set(name, entry);
    }
  }
  for (const [name, entry] of modules) {
    if (entry.count < MIN_MODULE_REPEATS) continue;
    const pattern = `(?:from\\s+|require\\(\\s*|import\\s+)['"]${escapeRegExp(name)}(?:/[^'"]*)?['"]`;
    if (!isSafeRegExp(pattern)) continue;
    const slug = name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "module";
    suggestions.push({
      id: suggestionId("forbid", name),
      kind: "forbid",
      title: `Forbid imports of '${name}'`,
      reason: `Agents tried to use '${name}' ${entry.count} times (${[...entry.codes].join(", ")}) in the stored replays. A forbid rule holds it at the first line with a message written for this repo.`,
      evidence: { count: entry.count, files: [...entry.files].slice(0, 10) },
      policy: { forbid: [{ id: `no-${slug}`, pattern, message: `'${name}' is not used in this repository; agents have repeatedly tried to import it.`, fix: "Use the project's existing module for this, or add the dependency in a planned change first." }] },
    });
  }

  const order = { graduate: 0, lock: 1, forbid: 2 } as const;
  suggestions.sort((a, b) => order[a.kind] - order[b.kind] || b.evidence.count - a.evidence.count || a.id.localeCompare(b.id));
  return { protocol: SUGGEST_PROTOCOL, windowDays: days, decisions: records.length, suggestions };
}

/** Merge one suggestion into .ctc/policy.json (created if missing). Throws if the result would not validate. */
export function acceptSuggestion(root: string, suggestion: RuleSuggestion): { file: string; changed: boolean } {
  const file = path.join(root, ".ctc", "policy.json");
  const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : { version: 1 };
  const rules = { ...((current.rules as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  const forbid = [...((current.forbid as Array<{ id: string }> | undefined) ?? [])];
  let changed = false;
  for (const [key, setting] of Object.entries(suggestion.policy.rules ?? {})) {
    const merged = { ...(rules[key] ?? {}), ...setting };
    if (JSON.stringify(merged) !== JSON.stringify(rules[key])) changed = true;
    rules[key] = merged;
  }
  for (const entry of suggestion.policy.forbid ?? []) {
    if (forbid.some((item) => item.id === entry.id)) continue;
    forbid.push(entry);
    changed = true;
  }
  const next = { ...current, version: 1, rules, forbid };
  const parsed = PolicyFileSchema.safeParse(next);
  if (!parsed.success) throw new Error(`the merged policy would be invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return { file, changed };
}

export function renderSuggestionsText(result: ReturnType<typeof suggestRules>): string {
  if (result.suggestions.length === 0) return `No rule suggestions from ${result.decisions} decisions in the last ${result.windowDays} days. Suggestions need repeated holds or observe-mode findings.\n`;
  const lines = [`${result.suggestions.length} rule suggestion(s) from ${result.decisions} decisions in the last ${result.windowDays} days:`, ""];
  for (const item of result.suggestions) {
    lines.push(`${item.id}  [${item.kind}] ${item.title}`);
    lines.push(`  ${item.reason}`);
    lines.push(`  policy: ${JSON.stringify(item.policy)}`);
    lines.push("");
  }
  lines.push("Accept one with: ctc suggest-rules --accept <id>   (writes .ctc/policy.json)");
  return `${lines.join("\n")}\n`;
}
