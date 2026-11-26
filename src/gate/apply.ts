import fs from "node:fs";
import path from "node:path";

import { applyLiteralPatch, type PatchHunk } from "../engine/patch.js";
import { PathEscapeError, normalizeRelative } from "../paths.js";
import { analyzeProposal } from "./analyzer.js";
import { assertPlan, loadActiveFlightPlan } from "../blueprint/store.js";
import { withConfigToggles } from "../universal/contract.js";
import type { FlightPlanContract } from "../schemas/flightPlan.js";
import type { GateViolation } from "../schemas/gate.js";
import { noteFailure, noteVerifiedFile, readRadar, unlockSession } from "../radar/state.js";
import { loadConfig } from "../config/load.js";
import { semanticReview, DEFAULT_SEMANTIC_CONFIG, type SemanticSummary } from "./semantic/review.js";
import type { ModelClient } from "./semantic/provider.js";
import { ensureGrammarFor } from "../lang/treesitter.js";
import { applyPolicy, beforeText, extendedChecks, finalizeDecision } from "./pipeline.js";
import type { ExplainReport } from "../explain/explain.js";
import type { FixLoopStatus } from "../explain/ledger.js";

export interface SpecWriteResult {
  protocol: "ctc.write.v1";
  cleared: boolean;
  written: boolean;
  file: string;
  violations: GateViolation[];
  locked: boolean;
  consecutiveFailures: number;
  bootstrapPrompt: string | null;
  message?: string;
  /** Advisory findings (semantic review in "warn" mode). They never block. */
  warnings?: GateViolation[];
  /** What the optional semantic review step did for this write (v0.3). */
  semanticReview?: SemanticSummary;
  /** v0.4: machine-readable explain-the-block report (rule, lines, why, fix patch) for held or observed findings. */
  explain?: ExplainReport;
  /** v0.4: fix handoff loop status for this file. */
  fixLoop?: FixLoopStatus;
  /** v0.4: findings a policy runs in observe mode — logged as would-have-blocked; the write proceeded. */
  observed?: GateViolation[];
}

function held(file: string, violations: GateViolation[], extra: Partial<SpecWriteResult> = {}): SpecWriteResult {
  return {
    protocol: "ctc.write.v1",
    cleared: false,
    written: false,
    file,
    violations,
    locked: false,
    consecutiveFailures: 0,
    bootstrapPrompt: null,
    ...extra,
  };
}

interface WriteRequest {
  path: string;
  content: string;
  sessionId?: string;
  plan?: FlightPlanContract;
  /** v0.4: who produced the content (fix-loop bookkeeping). */
  via?: "agent" | "ctc_apply_fix";
}

type Prepared =
  | { done: SpecWriteResult }
  | { root: string; relative: string; plan: FlightPlanContract; sessionId: string; violations: GateViolation[]; content: string; before: string | null; observed: GateViolation[]; t0: number; via?: "agent" | "ctc_apply_fix" };

/** Everything before the disk write: path, RED lock, plan, scope and the deterministic analyzer. */
function prepareWrite(rootInput: string, request: WriteRequest): Prepared {
  const t0 = performance.now();
  const root = path.resolve(rootInput);
  let relative = request.path;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return {
      done: held(request.path, [
        {
          rule: "FlightPlanScope",
          code: "PATH_ESCAPE",
          file: request.path,
          line: null,
          column: null,
          message: `Path "${request.path}" escapes the project root.`,
          fix: "Use a repo-relative path.",
        },
      ]),
    };
  }
  let radar = readRadar(root);
  if (radar.locked) {
    if (request.sessionId && request.sessionId !== radar.lockedSessionId) {
      radar = unlockSession(root, request.sessionId);
    } else {
      return {
        done: held(relative, [], {
          locked: true,
          consecutiveFailures: radar.consecutiveFailures,
          bootstrapPrompt: radar.handoff?.bootstrapPrompt ?? null,
          message: "RED lock. Read .ctc/state.json, pass a new sessionId, or run `ctc reset`.",
        }),
      };
    }
  }
  const sessionId = request.sessionId ?? radar.sessionId;
  const loaded = request.plan ?? loadActiveFlightPlan(root);
  const plan = loaded ? withConfigToggles(root, loaded) : loaded;
  if (!plan) {
    return {
      done: held(relative, [
        {
          rule: "FlightPlanScope",
          code: "NO_FLIGHT_PLAN",
          file: relative,
          line: null,
          column: null,
          message: "No task flight plan is active.",
          fix: "Call ctc_promote_task_to_flight_plan before ctc_write_file.",
        },
      ]),
    };
  }
  const violations = [...assertPlan(plan, relative, request.content)];
  if (!relative.startsWith(".ctc/")) violations.push(...analyzeProposal(root, relative, request.content, plan).violations);
  else {
    violations.push({
      rule: "FlightPlanScope",
      code: "LOCKED_FILE",
      file: relative,
      line: null,
      column: null,
      message: `${relative} is a CTC control file.`,
      fix: "Write project source, not .ctc/**.",
    });
  }
  const before = relative.startsWith(".ctc/") ? null : beforeText(root, relative);
  if (!relative.startsWith(".ctc/")) violations.push(...extendedChecks(root, relative, before, request.content, plan));
  const decision = applyPolicy(root, relative, violations);
  return { root, relative, plan, sessionId, violations: decision.blocking, observed: decision.observed, before, content: request.content, t0, ...(request.via ? { via: request.via } : {}) };
}

function finishWrite(prepared: Exclude<Prepared, { done: SpecWriteResult }>, extraInput: Partial<SpecWriteResult> = {}): SpecWriteResult {
  const { root, relative, plan, sessionId, violations } = prepared;
  const final = finalizeDecision(root, relative, prepared.before, prepared.content, { blocking: violations, observed: prepared.observed, mode: "enforce", conflicts: [] }, {
    surface: "write",
    plan,
    sessionId,
    ms: Math.round(performance.now() - prepared.t0),
    ...(prepared.via ? { via: prepared.via } : {}),
  });
  const extra: Partial<SpecWriteResult> = {
    ...extraInput,
    ...(final.explain ? { explain: final.explain } : {}),
    ...(final.fixLoop && (final.fixLoop.open > 0 || final.fixLoop.resolvedThisAttempt.length > 0) ? { fixLoop: final.fixLoop } : {}),
    ...(prepared.observed.length > 0 ? { observed: prepared.observed, warnings: [...(extraInput.warnings ?? []), ...prepared.observed] } : {}),
  };
  if (violations.length > 0) {
    const radar = noteFailure(root, sessionId, violations, plan);
    return held(relative, violations, {
      locked: radar.locked,
      consecutiveFailures: radar.consecutiveFailures,
      bootstrapPrompt: radar.handoff?.bootstrapPrompt ?? null,
      ...extra,
    });
  }
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, prepared.content, "utf8");
  noteVerifiedFile(root, relative);
  return {
    protocol: "ctc.write.v1",
    cleared: true,
    written: true,
    file: relative,
    violations: [],
    locked: false,
    consecutiveFailures: 0,
    bootstrapPrompt: null,
    ...extra,
  };
}

/** Deterministic gate only (synchronous). This is the pre-v0.3 behaviour and latency. */
export function applyWrite(rootInput: string, request: WriteRequest): SpecWriteResult {
  const prepared = prepareWrite(rootInput, request);
  if ("done" in prepared) return prepared.done;
  return finishWrite(prepared);
}

export interface ReviewOptions {
  client?: ModelClient;
  env?: NodeJS.ProcessEnv;
}

/**
 * Deterministic gate, then the optional semantic review when the deterministic gate cleared the write and
 * a provider is configured. With no API key this is exactly `applyWrite` plus a "skipped" summary.
 */
export async function applyWriteReviewed(rootInput: string, request: WriteRequest, options: ReviewOptions = {}): Promise<SpecWriteResult> {
  await ensureGrammarFor(request.path);
  const prepared = prepareWrite(rootInput, request);
  if ("done" in prepared) return prepared.done;
  const outcome = await reviewPrepared(prepared.root, prepared.relative, prepared.content, prepared.plan, prepared.violations, options);
  if (!outcome) return finishWrite(prepared);
  const blocking = outcome.mode === "block" ? outcome.findings : [];
  const warnings = outcome.mode === "warn" ? outcome.findings : [];
  return finishWrite({ ...prepared, violations: [...prepared.violations, ...blocking] }, { semanticReview: outcome.summary, ...(warnings.length ? { warnings } : {}) });
}

/** Shared by write and check paths. Returns null only for files the analyzer does not parse. */
export async function reviewPrepared(
  root: string,
  relative: string,
  content: string,
  plan: FlightPlanContract,
  deterministic: readonly GateViolation[],
  options: ReviewOptions = {},
): Promise<{ summary: SemanticSummary; findings: GateViolation[]; mode: "block" | "warn" } | null> {
  if (!/\.[cm]?[jt]sx?$/.test(relative) || relative.startsWith(".ctc/")) return null;
  let settings = DEFAULT_SEMANTIC_CONFIG;
  try {
    settings = loadConfig(root).rules.semantic;
  } catch {
    settings = DEFAULT_SEMANTIC_CONFIG;
  }
  if (deterministic.length > 0) {
    // The write is already held; a model call would add latency and cost without changing the decision.
    return { summary: { status: "skipped", reason: "deterministic gate already holds this write", kept: 0, dropped: [], ms: 0 }, findings: [], mode: settings.mode };
  }
  const absolute = path.join(root, relative);
  const before = fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8") : null;
  const outcome = await semanticReview({
    root,
    relativePath: relative,
    before,
    after: content,
    plan,
    deterministic,
    settings,
    ...(options.client ? { client: options.client } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  return { summary: outcome.summary, findings: outcome.findings, mode: settings.mode };
}

export function applyPatch(rootInput: string, request: { path: string; hunks: readonly PatchHunk[]; sessionId?: string; plan?: FlightPlanContract }): SpecWriteResult {
  const resolved = patchedRequest(rootInput, request);
  return "done" in resolved ? resolved.done : applyWrite(resolved.root, resolved.request);
}

export async function applyPatchReviewed(rootInput: string, request: { path: string; hunks: readonly PatchHunk[]; sessionId?: string; plan?: FlightPlanContract }, options: ReviewOptions = {}): Promise<SpecWriteResult> {
  const resolved = patchedRequest(rootInput, request);
  return "done" in resolved ? resolved.done : applyWriteReviewed(resolved.root, resolved.request, options);
}

function patchedRequest(rootInput: string, request: { path: string; hunks: readonly PatchHunk[]; sessionId?: string; plan?: FlightPlanContract }): { done: SpecWriteResult } | { root: string; request: WriteRequest } {
  const root = path.resolve(rootInput);
  let relative = request.path;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return { done: held(request.path, [
      {
        rule: "FlightPlanScope",
        code: "PATH_ESCAPE",
        file: request.path,
        line: null,
        column: null,
        message: `Path "${request.path}" escapes the project root.`,
        fix: "Use a repo-relative path.",
      },
    ]) };
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return { done: held(relative, [
      {
        rule: "FlightPlanScope",
        code: "PATCH_NOT_FOUND",
        file: relative,
        line: null,
        column: null,
        message: `Cannot patch ${relative} because the file is not on disk.`,
        fix: "Create the file with ctc_write_file.",
      },
    ]) };
  }
  const patched = applyLiteralPatch(fs.readFileSync(absolute, "utf8"), request.hunks);
  if ("code" in patched) {
    return { done: held(relative, [
      {
        rule: "FlightPlanScope",
        code: patched.code,
        file: relative,
        line: null,
        column: null,
        message: patched.message,
        fix: "Re-read the file and send one unique literal search.",
      },
    ]) };
  }
  return {
    root,
    request: {
      path: relative,
      content: patched.content,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.plan ? { plan: request.plan } : {}),
    },
  };
}
