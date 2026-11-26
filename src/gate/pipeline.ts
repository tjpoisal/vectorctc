import fs from "node:fs";
import path from "node:path";

import { explainViolations, type ExplainReport } from "../explain/explain.js";
import { recordAttempt, type FixLoopStatus } from "../explain/ledger.js";
import { policyViolations } from "../policy/check.js";
import { effectivePolicy, modeFor } from "../policy/policy.js";
import type { FlightPlanContract } from "../schemas/flightPlan.js";
import type { GateViolation } from "../schemas/gate.js";
import { scaViolations } from "../security/advisories.js";
import { sastViolations } from "../security/sast.js";
import { secretViolations } from "../security/secrets.js";
import { resolveIdentity } from "../enterprise/identity.js";
import { gateClient, gateModel } from "../telemetry/client.js";
import { logDecision } from "../telemetry/findings-log.js";
import { newReplayId, saveReplay } from "../replay/store.js";
import { BUILTIN_EXTENSIONS, type ExtensionCheck } from "./extensions.js";

export type { ExtensionCheck } from "./extensions.js";

/**
 * v0.4 gate pipeline around the v0.3 analyzer:
 *   1. extendedChecks  — secrets, SAST, SCA, imported rule files and policy-as-code, plus any registered
 *                        extension (language rules, wireframes, cross-repo, intent) — all diff-aware;
 *   2. applyPolicy     — org → repo → directory policy decides enforce / observe / off per finding;
 *   3. explain + fix loop + findings log for whatever still blocks.
 */

const extensions: Array<{ id: string; check: ExtensionCheck }> = [...BUILTIN_EXTENSIONS];

export function registerExtension(id: string, check: ExtensionCheck): void {
  if (!extensions.some((item) => item.id === id)) extensions.push({ id, check });
}

export function beforeText(root: string, relativePath: string): string | null {
  const absolute = path.join(root, relativePath);
  try {
    return fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : null;
  } catch {
    return null;
  }
}

export function extendedChecks(root: string, relativePath: string, before: string | null, after: string, plan: FlightPlanContract | null): GateViolation[] {
  if (relativePath.startsWith(".ctc/")) return [];
  const policy = effectivePolicy(root, relativePath);
  const out: GateViolation[] = [];
  for (const error of policy.errors) {
    out.push({ rule: "PolicyRule", code: "POLICY_FILE_INVALID", file: relativePath, line: null, column: null, message: `Policy file could not be loaded, so CTC fails closed: ${error}`, fix: "Fix the policy file (see `ctc policy explain`)." });
  }
  if (before === after) return out;
  out.push(...secretViolations(relativePath, before, after, policy.secretAllow));
  out.push(...sastViolations(relativePath, before, after));
  out.push(...scaViolations(root, relativePath, before, after, { minSeverity: policy.sca.minSeverity, advisoryFile: policy.sca.advisoryFile }));
  out.push(...policyViolations(root, relativePath, before, after, policy));
  for (const extension of extensions) {
    try {
      out.push(...extension.check({ root, relativePath, before, after, plan, policy }));
    } catch (error) {
      out.push({ rule: "LanguageRule", code: "EXTENSION_ERROR", file: relativePath, line: null, column: null, message: `${extension.id} failed: ${error instanceof Error ? error.message : String(error)}`, fix: "Report this; the check is skipped.", severity: "warn" });
    }
  }
  return out;
}

export interface PolicyDecision {
  blocking: GateViolation[];
  observed: GateViolation[];
  mode: "enforce" | "observe";
  conflicts: string[];
}

/** Gate-control findings (scope, lock, path) are never downgraded: observe mode is for rules, not for the gate's own safety rails. */
const ALWAYS_ENFORCED = new Set(["PATH_ESCAPE", "LOCKED_FILE", "NO_FLIGHT_PLAN", "PATCH_NOT_FOUND", "PATCH_AMBIGUOUS", "PATCH_EMPTY", "POLICY_FILE_INVALID"]);

export function applyPolicy(root: string, relativePath: string, violations: readonly GateViolation[]): PolicyDecision {
  const policy = effectivePolicy(root, relativePath);
  const blocking: GateViolation[] = [];
  const observed: GateViolation[] = [];
  for (const item of violations) {
    if (item.severity === "warn") {
      observed.push(item);
      continue;
    }
    if (ALWAYS_ENFORCED.has(item.code)) {
      blocking.push(item);
      continue;
    }
    const { mode } = modeFor(policy, item, relativePath);
    if (mode === "off") continue;
    if (mode === "observe") observed.push({ ...item, severity: "observe" });
    else blocking.push(item);
  }
  return { blocking, observed, mode: policy.mode, conflicts: policy.conflicts };
}

export interface Finalized {
  explain: ExplainReport | null;
  fixLoop: FixLoopStatus | null;
  /** Id of the local replay written for a held or observed decision (`ctc replay <id>`). */
  replay: string | null;
}

/** Explanations, fix-loop bookkeeping and the findings log for one decision. */
export function finalizeDecision(
  root: string,
  relativePath: string,
  before: string | null,
  after: string,
  decision: PolicyDecision,
  meta: { surface: string; plan: FlightPlanContract | null; sessionId?: string | null; ms?: number | null; via?: "agent" | "ctc_apply_fix"; record?: boolean },
): Finalized {
  const explain = decision.blocking.length > 0 || decision.observed.length > 0 ? explainViolations(relativePath, before, after, [...decision.blocking, ...decision.observed]) : null;
  let fixLoop: FixLoopStatus | null = null;
  let replay: string | null = null;
  if (meta.record !== false) {
    const blockingExplanations = explain ? explain.explanations.filter((_, index) => index < decision.blocking.length) : [];
    fixLoop = recordAttempt(root, relativePath, blockingExplanations, after, meta.via ?? "agent");
    const identity = resolveIdentity();
    const client = gateClient();
    const model = gateModel();
    const outcome = decision.blocking.length > 0 ? "held" : decision.observed.some((item) => item.severity === "observe") ? "observed" : "cleared";
    if (outcome !== "cleared" && explain) {
      const saved = saveReplay(root, {
        id: newReplayId(relativePath),
        file: relativePath,
        decision: outcome,
        surface: meta.surface,
        agent: client?.name ?? identity.actor,
        model,
        before,
        after,
        explanations: explain.explanations,
      });
      replay = saved?.id ?? null;
    }
    logDecision(root, {
      file: relativePath,
      decision: outcome,
      surface: meta.surface,
      taskId: meta.plan?.taskId ?? null,
      sessionId: meta.sessionId ?? null,
      actor: identity.actor,
      ...(identity.verified ? { idp: "oidc" as const } : {}),
      ...(client ? { client } : {}),
      ...(model ? { model } : {}),
      ...(replay ? { replay } : {}),
      ms: meta.ms ?? null,
      findings: [...decision.blocking.map((item) => ({ rule: item.rule, code: item.code, line: item.line, severity: "block" as const })), ...decision.observed.map((item) => ({ rule: item.rule, code: item.code, line: item.line, severity: (item.severity === "observe" ? "observe" : "warn") as "observe" | "warn" }))],
    });
  }
  return { explain, fixLoop, replay };
}
