import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDir } from "../paths.js";
import { hasGlob, pathMatches } from "../engine/match.js";
import { compileSafeRegExp, safeTest } from "../engine/safe-regex.js";
import { analyzeProposal } from "../gate/analyzer.js";
import {
  FlightPlanSchema,
  PreFlightBlueprintSchema,
  graphErrors,
  type FlightPlanCanary,
  type FlightPlanContract,
  type PreFlightBlueprint,
} from "../schemas/index.js";
import type { GateViolation } from "../schemas/gate.js";

export const BLUEPRINT_PATH = ".ctc/blueprint.json";
export const ACTIVE_PLAN_PATH = ".ctc/flight-plan.json";

function writeJson(root: string, relative: string, value: unknown): void {
  const absolute = path.join(root, relative);
  ensureDir(path.dirname(absolute));
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function loadBlueprint(root: string): PreFlightBlueprint | null {
  const absolute = path.join(root, BLUEPRINT_PATH);
  if (!fs.existsSync(absolute)) return null;
  return PreFlightBlueprintSchema.parse(JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown);
}

export function saveBlueprint(root: string, blueprint: PreFlightBlueprint): void {
  writeJson(root, BLUEPRINT_PATH, blueprint);
}

export function loadActiveFlightPlan(root: string): FlightPlanContract | null {
  const absolute = path.join(root, ACTIVE_PLAN_PATH);
  if (!fs.existsSync(absolute)) return null;
  return FlightPlanSchema.parse(JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown);
}

export function saveActiveFlightPlan(root: string, plan: FlightPlanContract): void {
  writeJson(root, ACTIVE_PLAN_PATH, plan);
}

export interface OnboardInput {
  projectName?: string;
  rawIdea: string;
  architectureSummary?: string;
  components?: PreFlightBlueprint["components"];
  globalInvariants?: string[];
  boundaries?: PreFlightBlueprint["boundaries"];
  globalBannedPackages?: string[];
  tasks?: PreFlightBlueprint["tasks"];
}

export function onboardTemplate(input: OnboardInput, projectName: string): PreFlightBlueprint {
  return {
    projectName,
    rawIdea: input.rawIdea,
    architectureSummary: input.architectureSummary ?? "",
    components: input.components ?? [],
    globalInvariants: input.globalInvariants ?? [],
    boundaries: input.boundaries ?? [],
    globalBannedPackages: input.globalBannedPackages ?? [],
    tasks: [],
  };
}

export function onboardIdea(root: string, input: OnboardInput, projectName: string):
  | { persisted: false; questions: string[]; template: PreFlightBlueprint }
  | { persisted: false; errors: string[] }
  | { persisted: true; blueprint: PreFlightBlueprint } {
  const tasks = input.tasks ?? [];
  if (tasks.length === 0) {
    return {
      persisted: false,
      questions: [
        "Which architectural components own this idea, and which files belong to each one?",
        "Split the idea into atomic tasks. Each task needs a taskId, targetFiles, acceptanceCriteria, and dependsOn.",
        "Which packages are banned for the whole blueprint?",
        "Which import boundaries should the gate enforce, as sourcePattern plus forbiddenImports?",
        "Which invariants must stay true across every task?",
      ],
      template: onboardTemplate(input, projectName),
    };
  }
  const parsed = PreFlightBlueprintSchema.safeParse({
    projectName,
    rawIdea: input.rawIdea,
    architectureSummary: input.architectureSummary ?? "",
    components: input.components ?? [],
    globalInvariants: input.globalInvariants ?? [],
    boundaries: input.boundaries ?? [],
    globalBannedPackages: input.globalBannedPackages ?? [],
    tasks: tasks.map((task) => ({ ...task, verifiedByGate: false, status: task.status === "DONE" ? "TODO" : task.status })),
  });
  if (!parsed.success) {
    return { persisted: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "blueprint"}: ${issue.message}`) };
  }
  const errors = graphErrors(parsed.data.tasks);
  const inProgress = parsed.data.tasks.filter((task) => task.status === "IN_PROGRESS");
  if (inProgress.length > 1) errors.push("Only one task may be IN_PROGRESS. Promote a single task with ctc_promote_task_to_flight_plan.");
  if (tasks.some((task) => task.status === "DONE")) errors.push("Mark a task DONE with ctc_update_task so the runway gate can verify its files.");
  if (errors.length > 0) return { persisted: false, errors };
  saveBlueprint(root, parsed.data);
  return { persisted: true, blueprint: parsed.data };
}

export function promoteTask(
  root: string,
  taskId: string,
  sessionId: string,
  canaries: FlightPlanCanary[] = [],
): { ok: true; blueprint: PreFlightBlueprint; plan: FlightPlanContract } | { ok: false; errors: string[] } {
  const blueprint = loadBlueprint(root);
  if (!blueprint) return { ok: false, errors: ["No blueprint. Call ctc_onboard_idea with tasks first."] };
  const task = blueprint.tasks.find((item) => item.taskId === taskId);
  if (!task) return { ok: false, errors: [`Unknown task '${taskId}'.`] };
  if (task.status === "DONE") return { ok: false, errors: [`Task '${taskId}' is already DONE.`] };
  const blockers = task.dependsOn.filter((dep) => blueprint.tasks.find((item) => item.taskId === dep)?.status !== "DONE");
  if (blockers.length > 0) return { ok: false, errors: [`Task '${taskId}' is blocked until these dependencies are DONE: ${blockers.join(", ")}.`] };
  const other = blueprint.tasks.find((item) => item.status === "IN_PROGRESS" && item.taskId !== taskId);
  if (other) return { ok: false, errors: [`Task '${other.taskId}' is already IN_PROGRESS. Finish or block it before promoting '${taskId}'.`] };
  const planResult = FlightPlanSchema.safeParse({
    planId: randomUUID(),
    taskId,
    createdAt: new Date().toISOString(),
    sessionId,
    objective: task.summary || task.acceptanceCriteria.join("; ") || taskId,
    ...(task.acceptanceCriteria.length > 0 ? { ticket: [task.summary || taskId, "", "Acceptance criteria:", ...task.acceptanceCriteria.map((item) => `- ${item}`)].join("\n") } : {}),
    allowedFileGlobs: task.targetFiles,
    invariants: blueprint.globalInvariants.map((text, index) => ({ id: `inv-${index + 1}`, text })),
    boundaries: blueprint.boundaries,
    globalBannedPackages: blueprint.globalBannedPackages,
    canaries,
  });
  if (!planResult.success) {
    return { ok: false, errors: planResult.error.issues.map((issue) => `${issue.path.join(".") || "flightPlan"}: ${issue.message}`) };
  }
  for (const taskItem of blueprint.tasks) {
    if (taskItem.taskId === taskId) taskItem.status = "IN_PROGRESS";
  }
  saveBlueprint(root, blueprint);
  saveActiveFlightPlan(root, planResult.data);
  return { ok: true, blueprint, plan: planResult.data };
}

export function concreteTargets(taskFiles: readonly string[]): string[] {
  return taskFiles.filter((file) => !hasGlob(file));
}

export function updateTaskStatus(
  root: string,
  taskId: string,
  status: PreFlightBlueprint["tasks"][number]["status"],
): { ok: true; blueprint: PreFlightBlueprint; violations: GateViolation[] } | { ok: false; errors: string[]; violations: GateViolation[] } {
  const blueprint = loadBlueprint(root);
  if (!blueprint) return { ok: false, errors: ["No blueprint. Call ctc_onboard_idea with tasks first."], violations: [] };
  const task = blueprint.tasks.find((item) => item.taskId === taskId);
  if (!task) return { ok: false, errors: [`Unknown task '${taskId}'.`], violations: [] };
  if (status === "IN_PROGRESS") {
    const other = blueprint.tasks.find((item) => item.status === "IN_PROGRESS" && item.taskId !== taskId);
    if (other) return { ok: false, errors: [`Task '${other.taskId}' is already IN_PROGRESS.`], violations: [] };
  }
  if (status === "DONE") {
    const plan = loadActiveFlightPlan(root);
    if (!plan || plan.taskId !== taskId) {
      return { ok: false, errors: [`Promote '${taskId}' before marking it DONE.`], violations: [] };
    }
    const violations: GateViolation[] = [];
    for (const file of concreteTargets(task.targetFiles)) {
      const absolute = path.join(root, file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        violations.push({
          rule: "FlightPlanScope",
          code: "TARGET_MISSING",
          file,
          line: null,
          column: null,
          message: `Target '${file}' is not on disk, so the task cannot be marked DONE.`,
          fix: `Land '${file}' with ctc_write_file.`,
        });
        continue;
      }
      const content = fs.readFileSync(absolute, "utf8");
      // Verifying a landed file: no pre-edit baseline, so legacy findings still count here.
      const result = analyzeProposal(root, file, content, plan, { baseline: null });
      violations.push(...assertPlan(plan, file, content), ...result.violations);
    }
    if (violations.length > 0) return { ok: false, errors: ["RunwayGateAnalyzer rejected one or more target files."], violations };
    task.verifiedByGate = true;
  }
  task.status = status;
  if (status !== "DONE") task.verifiedByGate = false;
  saveBlueprint(root, blueprint);
  return { ok: true, blueprint, violations: [] };
}

export function assertPlan(plan: FlightPlanContract, relativePath: string, content: string): GateViolation[] {
  const violations: GateViolation[] = [];
  if (!plan.allowedFileGlobs.some((pattern) => pathMatches(relativePath, pattern))) {
    violations.push({
      rule: "FlightPlanScope",
      code: "OUTSIDE_FLIGHT_PLAN",
      file: relativePath,
      line: null,
      column: null,
      message: `'${relativePath}' is outside allowedFileGlobs: ${plan.allowedFileGlobs.join(", ")}.`,
      fix: "Stay inside the active task's targetFiles, or promote the task that owns this file.",
    });
  }
  for (const canary of plan.canaries) {
    if (!pathMatches(relativePath, canary.targetFileGlob)) continue;
    let pattern: RegExp;
    try {
      pattern = compileSafeRegExp(canary.requiredPattern);
    } catch (error) {
      violations.push({
        rule: "CanaryAssertion",
        code: "CANARY_AMNESIA",
        file: relativePath,
        line: 1,
        column: 1,
        message: error instanceof Error ? error.message : String(error),
        fix: "Replace the canary with a short pattern that has no nested quantifiers.",
      });
      continue;
    }
    if (!safeTest(pattern, content)) {
      violations.push({
        rule: "CanaryAssertion",
        code: "CANARY_AMNESIA",
        file: relativePath,
        line: 1,
        column: 1,
        message: `Canary '${canary.id}' failed. ${canary.description || canary.requiredPattern} is missing from ${relativePath}.`,
        fix: `Restore a match for /${canary.requiredPattern}/.`,
      });
    }
  }
  for (const invariant of plan.invariants) {
    const paths = invariant.inPaths ?? plan.allowedFileGlobs;
    if (!paths.some((pattern) => pathMatches(relativePath, pattern))) continue;
    if (invariant.forbiddenPattern) {
      try {
        const pattern = compileSafeRegExp(invariant.forbiddenPattern);
        if (safeTest(pattern, content)) {
          violations.push({
            rule: "InvariantCheck",
            code: "INVARIANT_VIOLATION",
            file: relativePath,
            line: 1,
            column: 1,
            message: `Invariant '${invariant.id}' forbids /${invariant.forbiddenPattern}/. ${invariant.text}`,
            fix: `Remove the forbidden pattern from ${relativePath}.`,
          });
        }
      } catch (error) {
        violations.push({
          rule: "InvariantCheck",
          code: "INVARIANT_VIOLATION",
          file: relativePath,
          line: 1,
          column: 1,
          message: error instanceof Error ? error.message : String(error),
          fix: "Replace the invariant pattern.",
        });
      }
    }
    if (invariant.requiredPattern) {
      try {
        const pattern = compileSafeRegExp(invariant.requiredPattern);
        if (!safeTest(pattern, content)) {
          violations.push({
            rule: "InvariantCheck",
            code: "INVARIANT_VIOLATION",
            file: relativePath,
            line: 1,
            column: 1,
            message: `Invariant '${invariant.id}' requires /${invariant.requiredPattern}/. ${invariant.text}`,
            fix: `Add the required pattern to ${relativePath}.`,
          });
        }
      } catch (error) {
        violations.push({
          rule: "InvariantCheck",
          code: "INVARIANT_VIOLATION",
          file: relativePath,
          line: 1,
          column: 1,
          message: error instanceof Error ? error.message : String(error),
          fix: "Replace the invariant pattern.",
        });
      }
    }
  }
  return violations;
}
