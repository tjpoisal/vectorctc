import fs from "node:fs";
import path from "node:path";

import { applyWrite, applyWriteReviewed, reviewPrepared, type ReviewOptions, type SpecWriteResult } from "../gate/apply.js";
import { analyzeProposal } from "../gate/analyzer.js";
import type { Baseline } from "../gate/baseline.js";
import { assertPlan } from "../blueprint/store.js";
import { loadConfig } from "../config/load.js";
import { holdPayload, clearedPayload, type CtcWritePayload } from "../engine/payload.js";
import { PathEscapeError, normalizeRelative } from "../paths.js";
import { readRadar } from "../radar/state.js";
import { violation, type Violation } from "../engine/types.js";
import type { GateViolation } from "../schemas/gate.js";
import { resolveContract } from "./contract.js";
import { ensureGrammarFor } from "../lang/treesitter.js";
import { applyPolicy, beforeText, extendedChecks, finalizeDecision } from "../gate/pipeline.js";

export interface CheckOutcome {
  exitCode: 0 | 1 | 2;
  payload: CtcWritePayload | { protocol: "ctc.error.v1"; cleared: false; message: string };
}

function asViolations(file: string, items: readonly GateViolation[]): Violation[] {
  return items.map((item) => ({
    ...violation({
      code: item.code,
      rule: item.rule,
      gate: item.rule === "FlightPlanScope" || item.rule === "CanaryAssertion" || item.rule === "InvariantCheck" ? "scope" : "ast",
      file: item.file || file,
      line: item.line,
      column: item.column,
      message: item.message,
      fix: item.fix,
      useInstead: item.fix,
      ...(item.severity === "warn" || item.severity === "observe" ? { severity: "warn" as const } : {}),
    }),
    ...(item.severity === "observe" ? { observed: true } : {}),
    ...(item.cwe ? { cwe: item.cwe } : {}),
  }));
}

function hold(root: string, file: string, items: readonly Violation[]): CheckOutcome {
  let maxStrikes = 3;
  try {
    maxStrikes = loadConfig(root).circuitBreaker.maxStrikes;
  } catch {
    maxStrikes = 3;
  }
  const radar = readRadar(root);
  return {
    exitCode: 2,
    payload: holdPayload({
      file,
      strikes: radar.consecutiveFailures,
      maxStrikes,
      circuitOpen: radar.locked,
      violations: [...items],
    }),
  };
}

export function checkContent(rootInput: string, filePath: string, content: string, options: { baseline?: Baseline; surface?: string; record?: boolean } = {}): CheckOutcome {
  const root = path.resolve(rootInput);
  let relative = filePath;
  try {
    relative = normalizeRelative(root, filePath);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return { exitCode: 1, payload: { protocol: "ctc.error.v1", cleared: false, message: `Path "${filePath}" escapes the project root.` } };
  }
  const contract = resolveContract(root);
  if (!contract.ok) return { exitCode: 1, payload: { protocol: "ctc.error.v1", cleared: false, message: contract.error } };
  const radar = readRadar(root);
  if (radar.locked) {
    return hold(root, relative, [
      violation({
        code: "RADAR_RED_LOCK",
        rule: "readRadar",
        gate: "circuit",
        file: relative,
        line: null,
        column: null,
        message: radar.handoff?.bootstrapPrompt ?? "RED lock. Read .ctc/state.json or run ctc reset.",
        fix: "Start a fresh session or run `ctc reset`.",
        useInstead: "ctc reset",
      }),
    ]);
  }
  const t0 = performance.now();
  const raw = [...assertPlan(contract.plan, relative, content), ...analyzeProposal(root, relative, content, contract.plan, { baseline: options.baseline }).violations];
  const before = options.baseline !== undefined ? options.baseline : beforeText(root, relative);
  raw.push(...extendedChecks(root, relative, before, content, contract.plan));
  const decision = applyPolicy(root, relative, raw);
  const final = finalizeDecision(root, relative, before, content, decision, { surface: options.surface ?? "check", plan: contract.plan, ms: Math.round(performance.now() - t0), record: options.record !== false });
  const violations = decision.blocking;
  const extras = { file: relative, ...(final.explain ? { explain: final.explain } : {}), ...(final.fixLoop && final.fixLoop.open + final.fixLoop.resolvedThisAttempt.length > 0 ? { fixLoop: final.fixLoop } : {}), ...(decision.observed.length ? { warnings: decision.observed } : {}) };
  if (violations.length > 0) return withReview(hold(root, relative, asViolations(relative, violations)), extras);
  let maxStrikes = 3;
  try {
    maxStrikes = loadConfig(root).circuitBreaker.maxStrikes;
  } catch {
    maxStrikes = 3;
  }
  return withReview({ exitCode: 0, payload: clearedPayload({ file: relative, maxStrikes, written: false, bytesWritten: null }) }, extras);
}

export function checkFile(rootInput: string, filePath: string, content?: string): CheckOutcome {
  if (content !== undefined) return checkContent(rootInput, filePath, content);
  const root = path.resolve(rootInput);
  let relative = filePath;
  try {
    relative = normalizeRelative(root, filePath);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return { exitCode: 1, payload: { protocol: "ctc.error.v1", cleared: false, message: `Path "${filePath}" escapes the project root.` } };
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return { exitCode: 1, payload: { protocol: "ctc.error.v1", cleared: false, message: `${relative} is not a file.` } };
  }
  return checkContent(root, relative, fs.readFileSync(absolute, "utf8"));
}

function withReview(outcome: CheckOutcome, result: Pick<SpecWriteResult, "semanticReview" | "warnings" | "file" | "explain" | "fixLoop">): CheckOutcome {
  if (!("strikes" in outcome.payload)) return outcome;
  const payload = { ...outcome.payload };
  if (result.explain) payload.explain = result.explain;
  if (result.fixLoop) payload.fixLoop = result.fixLoop;
  if (result.semanticReview) payload.semanticReview = result.semanticReview;
  if (result.warnings?.length) payload.warnings = [...payload.warnings, ...asViolations(result.file, result.warnings)];
  return { ...outcome, payload };
}

export function presentWrite(rootInput: string, result: SpecWriteResult & { exitCode: 0 | 1 | 2 }): CheckOutcome {
  return withReview(presentWriteBase(rootInput, result), result);
}

function presentWriteBase(rootInput: string, result: SpecWriteResult & { exitCode: 0 | 1 | 2 }): CheckOutcome {
  if (result.exitCode === 0) {
    return { exitCode: 0, payload: clearedPayload({ file: result.file, maxStrikes: strikesFor(rootInput), written: result.written, bytesWritten: null }) };
  }
  if (result.exitCode === 1) {
    return {
      exitCode: 1,
      payload: { protocol: "ctc.error.v1", cleared: false, message: result.message ?? result.violations.map((item) => item.message).join(" ") },
    };
  }
  return hold(rootInput, result.file, asViolations(result.file, result.violations));
}

function strikesFor(root: string): number {
  try {
    return loadConfig(root).circuitBreaker.maxStrikes;
  } catch {
    return 3;
  }
}

function exitFor(result: SpecWriteResult): SpecWriteResult & { exitCode: 0 | 1 | 2 } {
  if (result.cleared) return { ...result, exitCode: 0 };
  if (result.violations.some((item) => item.code === "PATH_ESCAPE") || (result.violations.length === 0 && !result.locked && result.message)) {
    return { ...result, exitCode: 1 };
  }
  return { ...result, exitCode: 2 };
}

/** `applyContent` plus the optional semantic review (v0.3). Identical to applyContent when no key is configured. */
export async function applyContentReviewed(rootInput: string, filePath: string, content: string, sessionId?: string, options: ReviewOptions = {}): Promise<SpecWriteResult & { exitCode: 0 | 1 | 2 }> {
  const root = path.resolve(rootInput);
  const contract = resolveContract(root);
  if (!contract.ok) return applyContent(root, filePath, content, sessionId);
  return exitFor(await applyWriteReviewed(root, { path: filePath, content, plan: contract.plan, ...(sessionId ? { sessionId } : {}) }, options));
}

/** `checkContent` plus the optional semantic review (v0.3). Never writes. */
export async function checkContentReviewed(rootInput: string, filePath: string, content: string, options: ReviewOptions & { baseline?: Baseline } = {}): Promise<CheckOutcome> {
  await ensureGrammarFor(filePath);
  const outcome = checkContent(rootInput, filePath, content, { baseline: options.baseline });
  if (outcome.exitCode !== 0) return outcome;
  const root = path.resolve(rootInput);
  const contract = resolveContract(root);
  if (!contract.ok) return outcome;
  let relative = filePath;
  try {
    relative = normalizeRelative(root, filePath);
  } catch {
    return outcome;
  }
  const review = await reviewPrepared(root, relative, content, contract.plan, [], options);
  if (!review) return outcome;
  if (review.mode === "block" && review.findings.length > 0) {
    return withReview(hold(root, relative, asViolations(relative, review.findings)), { file: relative, semanticReview: review.summary });
  }
  return withReview(outcome, { file: relative, semanticReview: review.summary, ...(review.mode === "warn" ? { warnings: review.findings } : {}) });
}

export async function checkFileReviewed(rootInput: string, filePath: string, content?: string, options: ReviewOptions = {}): Promise<CheckOutcome> {
  await ensureGrammarFor(filePath);
  if (content !== undefined) return checkContentReviewed(rootInput, filePath, content, options);
  const root = path.resolve(rootInput);
  let relative = filePath;
  try {
    relative = normalizeRelative(root, filePath);
  } catch {
    return checkFile(rootInput, filePath);
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return checkFile(rootInput, filePath);
  return checkContentReviewed(root, relative, fs.readFileSync(absolute, "utf8"), options);
}

export function applyContent(rootInput: string, filePath: string, content: string, sessionId?: string): SpecWriteResult & { exitCode: 0 | 1 | 2 } {
  const root = path.resolve(rootInput);
  const contract = resolveContract(root);
  if (!contract.ok) {
    return {
      protocol: "ctc.write.v1",
      cleared: false,
      written: false,
      file: filePath,
      violations: [],
      locked: false,
      consecutiveFailures: 0,
      bootstrapPrompt: null,
      message: contract.error,
      exitCode: 1,
    };
  }
  return exitFor(applyWrite(root, { path: filePath, content, plan: contract.plan, ...(sessionId ? { sessionId } : {}) }));
}
