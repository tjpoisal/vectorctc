import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config/load.js";
import { ACTIVE_PLAN_PATH, loadActiveFlightPlan } from "../blueprint/store.js";
import type { CtcConfig } from "../config/schema.js";
import { DEFAULT_NAMING, DEFAULT_THRESHOLDS, FlightPlanSchema, type FlightPlanContract, type GateRuleToggle } from "../schemas/flightPlan.js";

/** Rules the config switches off. Every `enabled: false` is honored on the gate path. */
export function disabledRulesFrom(config: CtcConfig, options: { degradationNullDisables: boolean }): GateRuleToggle[] {
  const off: GateRuleToggle[] = [];
  if (!config.rules.naming.enabled) off.push("naming");
  if (!config.rules.duplicates.enabled) off.push("duplicates");
  if (!config.rules.deadCode.enabled) off.push("deadCode");
  if (!config.rules.phantom.gate) off.push("phantom");
  if (!config.rules.conventions.enabled) off.push("conventions");
  if (!config.rules.semantic.enabled) off.push("semantic");
  if (options.degradationNullDisables) {
    // `ctc init` leaves degradation limits null, which the README documents as "off".
    if (config.degradation.maxFunctionLength == null) off.push("functionLength");
    if (config.degradation.maxCyclomaticComplexity == null) off.push("complexity");
  }
  return off;
}

function packageBans(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => !/[*?[\]]/.test(pattern) && !pattern.startsWith(".") && !pattern.startsWith("src/"));
}

export function planFromMilestone(root: string): FlightPlanContract {
  const config = loadConfig(root);
  const length = config.degradation.maxFunctionLength ?? DEFAULT_THRESHOLDS.maxFunctionLines;
  const complexity = config.degradation.maxCyclomaticComplexity ?? DEFAULT_THRESHOLDS.maxCyclomaticComplexity;
  return FlightPlanSchema.parse({
    planId: "milestone-ceiling",
    taskId: config.activeMilestone.id,
    createdAt: new Date().toISOString(),
    sessionId: "universal",
    objective: config.activeMilestone.title,
    allowedFileGlobs: config.activeMilestone.allowedPaths,
    globalBannedPackages: packageBans(config.bannedImports.map((item) => item.pattern)),
    naming: {
      functions: config.rules.naming.functions || DEFAULT_NAMING.functions,
      variables: config.rules.naming.variables || DEFAULT_NAMING.variables,
      typesAndInterfaces: config.rules.naming.typesAndInterfaces || DEFAULT_NAMING.typesAndInterfaces,
    },
    thresholds: {
      maxFunctionLines: length,
      maxCyclomaticComplexity: complexity,
      duplicateJaccard: config.rules.duplicates.duplicateBlockThreshold,
    },
    disabledRules: disabledRulesFrom(config, { degradationNullDisables: true }),
    utilityGlobs: config.rules.duplicates.utilityGlobs,
  });
}

/** A task plan carries its own thresholds; `enabled: false` switches in ctc.config.json still apply to it. */
export function withConfigToggles(root: string, plan: FlightPlanContract): FlightPlanContract {
  let configOff: GateRuleToggle[] = [];
  let utilityGlobs = plan.utilityGlobs;
  try {
    const config = loadConfig(root);
    configOff = disabledRulesFrom(config, { degradationNullDisables: false });
    utilityGlobs ??= config.rules.duplicates.utilityGlobs;
  } catch {
    configOff = [];
  }
  return { ...plan, disabledRules: [...new Set([...plan.disabledRules, ...configOff])], ...(utilityGlobs ? { utilityGlobs } : {}) };
}

/** Active task flight plan when one is saved. Otherwise the milestone ceiling, still checked by RunwayGateAnalyzer. */
export function resolveContract(rootInput: string): { ok: true; plan: FlightPlanContract; source: "blueprint" | "milestone" } | { ok: false; error: string } {
  const root = path.resolve(rootInput);
  const activePath = path.join(root, ACTIVE_PLAN_PATH);
  if (fs.existsSync(activePath)) {
    try {
      const plan = loadActiveFlightPlan(root);
      if (!plan) return { ok: false, error: `${ACTIVE_PLAN_PATH} is empty.` };
      return { ok: true, plan: withConfigToggles(root, plan), source: "blueprint" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Active flight plan is invalid: ${message}` };
    }
  }
  try {
    return { ok: true, plan: planFromMilestone(root), source: "milestone" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
