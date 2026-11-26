import fs from "node:fs";
import path from "node:path";

import { ConfigError, normalizeFlightPlan, type FlightPlan } from "../config/schema.js";
import { ensureDir } from "../paths.js";
import { hasGlob, pathMatches, patternWithinCeiling } from "./match.js";
import { violation, type Rule, type Violation } from "./types.js";

export function flightPlanPath(root: string): string {
  return path.join(root, ".ctc", "flightplan.json");
}

export function loadFlightPlan(root: string): FlightPlan | null {
  const file = flightPlanPath(root);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`.ctc/flightplan.json is not valid JSON: ${message}`);
  }
  return normalizeFlightPlan(raw);
}

export function saveFlightPlan(root: string, plan: FlightPlan): void {
  const file = flightPlanPath(root);
  ensureDir(path.dirname(file));
  const normalized = normalizeFlightPlan(plan);
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export function scopeViolations(
  relativePath: string,
  milestoneId: string,
  milestoneStatus: "active" | "locked",
  ceiling: readonly string[] | null,
  planPaths: readonly string[] | null,
  staleMilestone: string | null,
): Violation[] {
  if (milestoneStatus === "locked") {
    return [
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: relativePath,
        line: null,
        column: null,
        message: `RUNWAY INCURSION: milestone "${milestoneId}" is locked. All writes are rejected.`,
        fix: `Set activeMilestone.status to "active" before landing ${relativePath}.`,
        useInstead: `Set activeMilestone.status to "active" before landing writes.`,
      }),
    ];
  }
  if (staleMilestone) {
    return [
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: relativePath,
        line: null,
        column: null,
        message: `RUNWAY INCURSION: the saved flight plan is for milestone "${staleMilestone}", but the active milestone is "${milestoneId}".`,
        fix: `Call ctc_check_flightplan with milestone "${milestoneId}" and persist:true.`,
        useInstead: `Call ctc_check_flightplan with milestone "${milestoneId}" and persist:true.`,
      }),
    ];
  }
  if (!ceiling && !planPaths) {
    return [
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: relativePath,
        line: null,
        column: null,
        message: `RUNWAY INCURSION: milestone "${milestoneId}" has no allowedPaths and no flight plan.`,
        fix: "Add allowedPaths on activeMilestone, or call ctc_check_flightplan with the paths this task will touch.",
        useInstead: "Add allowedPaths on activeMilestone.",
      }),
    ];
  }
  const inCeiling = !ceiling || ceiling.some((pattern) => pathMatches(relativePath, pattern));
  const inPlan = !planPaths || planPaths.some((pattern) => pathMatches(relativePath, pattern));
  if (inCeiling && inPlan) return [];
  const allowed = [...(planPaths ?? ceiling ?? [])];
  return [
    violation({
      code: "RUNWAY_INCURSION",
      rule: "flightPlan",
      gate: "scope",
      file: relativePath,
      line: null,
      column: null,
      message: `RUNWAY INCURSION: ${relativePath} is outside allowedPaths for milestone "${milestoneId}".`,
      fix: `Keep this write inside: ${allowed.join(", ")}.`,
      useInstead: allowed.join(", "),
    }),
  ];
}

export function flightPlanPatternViolation(
  pattern: string,
  milestoneId: string,
  ceiling: readonly string[] | null,
): Violation | null {
  if (pattern.split("/").includes("..")) {
    return violation({
      code: "PATH_ESCAPE",
      rule: "flightPlan",
      gate: "scope",
      file: pattern,
      line: null,
      column: null,
      message: `Flight-plan pattern "${pattern}" escapes the project root.`,
      fix: "Use a pattern inside the project, with forward slashes, and no .. segments.",
    });
  }
  if (ceiling && !patternWithinCeiling(pattern, ceiling)) {
    return violation({
      code: "RUNWAY_INCURSION",
      rule: "flightPlan",
      gate: "scope",
      file: pattern,
      line: null,
      column: null,
      message: `RUNWAY INCURSION: flight-plan pattern "${pattern}" is wider than milestone "${milestoneId}".`,
      fix: `Stay inside allowedPaths: ${ceiling.join(", ")}.`,
      useInstead: ceiling.join(", "),
    });
  }
  if (!hasGlob(pattern) && pattern.startsWith("/")) {
    return violation({
      code: "PATH_ESCAPE",
      rule: "flightPlan",
      gate: "scope",
      file: pattern,
      line: null,
      column: null,
      message: `Flight-plan pattern "${pattern}" must be repo-relative.`,
      fix: "Drop the leading slash and pass a path relative to the project root.",
    });
  }
  return null;
}

export const scopeRule: Rule = {
  id: "flightPlan",
  gate: "scope",
  order: 20,
  check(ctx) {
    const milestone = ctx.config.activeMilestone;
    const plan = ctx.flightPlan;
    const stale = plan && plan.milestone !== milestone.id ? plan.milestone : null;
    const planPaths = plan && !stale ? plan.paths : null;
    return scopeViolations(ctx.relativePath, milestone.id, milestone.status, milestone.allowedPaths, stale ? null : planPaths, stale);
  },
};
