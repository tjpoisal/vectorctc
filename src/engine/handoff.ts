import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { FlightPlan } from "../config/schema.js";
import { pathMatches } from "./match.js";
import { ensureDir, toPosix } from "../paths.js";
import type { Violation } from "./types.js";

export type HandoffReason =
  | "CONTEXT_SATURATION"
  | "CONSECUTIVE_GATE_FAILURES"
  | "RETRY_THRASHING"
  | "CANARY_AMNESIA"
  | "MANUAL_HANDOFF";

export interface GroundCrewHandoff {
  handoffId: string;
  generatedAt: string;
  previousSessionId: string;
  triggerReason: HandoffReason;
  activePlanId: string;
  objective: string;
  invariants: string[];
  completedFiles: string[];
  pendingFiles: string[];
  unresolvedViolations: string[];
  bootstrapPrompt: string;
}

const IGNORE = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next"]);

export function filesMatching(root: string, patterns: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toPosix(path.relative(root, absolute));
      if (patterns.some((pattern) => pathMatches(relative, pattern))) found.push(relative);
    }
  };
  walk(root);
  return found.sort();
}

export function writeHandoff(
  root: string,
  input: {
    plan: FlightPlan;
    reason: HandoffReason;
    completedFiles: readonly string[];
    violations: readonly Violation[];
  },
): GroundCrewHandoff {
  const completed = new Set(input.completedFiles);
  const pendingFiles = filesMatching(root, input.plan.paths).filter((file) => !completed.has(file));
  const unresolved = input.violations.map((item) => `[${item.code}] ${item.file}:${item.line ?? 1} ${item.message}`);
  const handoff: GroundCrewHandoff = {
    handoffId: randomUUID(),
    generatedAt: new Date().toISOString(),
    previousSessionId: input.plan.sessionId,
    triggerReason: input.reason,
    activePlanId: input.plan.planId,
    objective: input.plan.intent,
    invariants: input.plan.invariants.map((item) => item.text),
    completedFiles: [...completed],
    pendingFiles,
    unresolvedViolations: unresolved,
    bootstrapPrompt: [
      `Resume flight plan ${input.plan.planId} for milestone ${input.plan.milestone}: ${input.plan.intent || "no objective recorded"}.`,
      `Invariants: ${input.plan.invariants.map((item) => item.text).join(" | ") || "none"}.`,
      `Completed files: ${[...completed].join(", ") || "none"}.`,
      `Pending files: ${pendingFiles.join(", ") || "none"}.`,
      "Violations:",
      ...(unresolved.length > 0 ? unresolved.map((line) => `- ${line}`) : ["- none"]),
    ].join("\n"),
  };
  const file = path.join(root, ".ctc", "handoff.json");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  return handoff;
}
