import fs from "node:fs";
import path from "node:path";

import { ConfigError, normalizeFlightPlan, type CtcConfig, type FlightPlan, type PlanCanary, type PlanInvariant } from "../config/schema.js";
import { loadConfig } from "../config/load.js";
import {
  anyCircuitOpen,
  fileStrikes,
  loadState,
  noteRejection,
  noteSuccess,
  saveState,
  type GroundCrewState,
} from "./circuit-breaker.js";
import { flightPlanPatternViolation, loadFlightPlan, saveFlightPlan } from "./flight-plan.js";
import { hasGlob } from "./match.js";
import { FLIGHTPLAN_PROTOCOL, HOLD_PROTOCOL, clearedPayload, holdPayload, type CtcWritePayload } from "./payload.js";
import { appendRadar } from "./radar-memory.js";
import { writeHandoff } from "./handoff.js";
import { rememberUtility } from "./hash/utility-index.js";
import { applyLiteralPatch, type PatchHunk } from "./patch.js";
import { runPhantomCheck } from "./phantom-check.js";
import { noteFileLanded, noteGateViolations, readZoneLocked, resetReadZone } from "./read-zone.js";
import { readRadar } from "../radar/state.js";
import { lockViolation, matchedLock } from "./rules/lock.js";
import { runRules } from "./rules/index.js";
import { simulateSource } from "./simulate.js";
import { remember, rememberFeedback } from "../memory/sync.js";
import { PathEscapeError, normalizeRelative } from "../paths.js";
import { violation, type RadarSource, type Violation } from "./types.js";

export interface ReviewRequest {
  root: string;
  path: string;
  content: string;
  rationale?: string;
  source: RadarSource;
  /** When true, a cleared proposal is written to disk. Hooks leave this false. */
  land: boolean;
}

export interface FlightPlanCheckRequest {
  root: string;
  paths: string[];
  milestone?: string;
  intent?: string;
  persist?: boolean;
  sessionId?: string;
  invariants?: PlanInvariant[];
  canaries?: PlanCanary[];
}

export interface FlightPlanPayload extends Omit<CtcWritePayload, "protocol"> {
  protocol: typeof HOLD_PROTOCOL | typeof FLIGHTPLAN_PROTOCOL;
  flightPlan: FlightPlan | null;
  persisted: boolean;
}

function configViolation(error: unknown): Violation {
  const message = error instanceof Error ? error.message : String(error);
  return violation({
    code: "CONFIG_INVALID",
    rule: "config",
    gate: "config",
    file: "ctc.config.json",
    line: null,
    column: null,
    message,
    fix: "Fix ctc.config.json, or run `ctc init` / `ctc scan --write` in the project root.",
    useInstead: "ctc init",
  });
}

function circuitViolation(file: string, strikes: number, maxStrikes: number): Violation {
  return violation({
    code: "CIRCUIT_OPEN",
    rule: "circuitBreaker",
    gate: "circuit",
    file,
    line: null,
    column: null,
    message: `Circuit breaker is open after ${strikes} consecutive rejections of ${file} (limit ${maxStrikes}).`,
    fix: 'Ask a human to waive the breaker with ctc_log_decision decision "waived" before proposing this file again.',
    useInstead: 'ctc_log_decision decision "waived"',
  });
}

function pathViolation(inputPath: string): Violation {
  return violation({
    code: "PATH_ESCAPE",
    rule: "flightPlan",
    gate: "scope",
    file: inputPath,
    line: null,
    column: null,
    message: `Path "${inputPath}" escapes the project root.`,
    fix: "Use a repo-relative path inside the project. Parent-directory traversal is grounded.",
  });
}

function parseViolation(relativePath: string, error: unknown): Violation {
  const message = error instanceof Error ? error.message : String(error);
  return violation({
    code: "PARSE_ERROR",
    rule: "ast",
    gate: "ast",
    file: relativePath,
    line: null,
    column: null,
    message: `CTC could not parse ${relativePath}: ${message}`,
    fix: "Submit valid TypeScript or JavaScript source for this extension.",
  });
}

function summaryFor(payload: CtcWritePayload): string {
  const target = payload.file ?? "(no file)";
  if (payload.cleared) {
    return payload.written ? `Cleared ${target} (${payload.bytesWritten ?? 0} bytes).` : `Cleared ${target} without writing.`;
  }
  const first = payload.violations.find((item) => item.code !== "CIRCUIT_OPEN") ?? payload.violations[0];
  const why = first ? `${first.code}: ${first.message}` : "rejected";
  return `Rejected ${target} at gate ${payload.gate}. ${why}`;
}

function reject(root: string, input: {
  config: CtcConfig | null;
  state: GroundCrewState;
  file: string | null;
  violations: Violation[];
  source: RadarSource;
  countStrike: boolean;
  summary?: string;
}): CtcWritePayload {
  const maxStrikes = input.config?.circuitBreaker.maxStrikes ?? 3;
  const summary = input.summary ?? input.violations[0]?.message ?? "Rejected.";
  const next = input.countStrike && input.file
    ? noteRejection(input.state, input.file, maxStrikes, summary)
    : { ...input.state, lastDecision: "rejected" as const, lastSummary: summary, updatedAt: new Date().toISOString() };
  if (input.countStrike && input.file) saveState(root, next);
  const breaker = input.file ? fileStrikes(next, input.file) : { consecutiveRejections: 0, circuitOpen: false };
  const withCircuit =
    breaker.circuitOpen && input.countStrike
      ? [circuitViolation(input.file ?? "ctc.config.json", breaker.consecutiveRejections, maxStrikes), ...input.violations]
      : input.violations;
  const payload = holdPayload({
    file: input.file,
    strikes: breaker.consecutiveRejections,
    maxStrikes,
    circuitOpen: breaker.circuitOpen,
    violations: withCircuit,
  });
  appendRadar(root, {
    source: input.source,
    decision: "rejected",
    gate: payload.gate,
    path: payload.file,
    summary: summaryFor(payload),
    strikes: payload.strikes,
    circuitOpen: payload.circuit === "open",
    violations: payload.violations,
  });
  if (input.config) {
    noteGateViolations(root, payload.violations);
    const lesson = payload.violations[0];
    remember(root, input.config, {
      content: lesson ? `${lesson.code} in ${payload.file ?? "unknown"}: ${lesson.message} Action: ${lesson.useInstead ?? lesson.fix}` : summaryFor(payload),
      tags: ["ctc", "gate-failure", lesson?.code ?? "hold"],
      file: payload.file,
    });
    if (payload.circuit === "open") {
      rememberFeedback(input.config, payload.file ?? "ctc", summaryFor(payload));
    }
    if (payload.violations.some((item) => item.code === "CANARY_AMNESIA" || item.code === "INVARIANT_VIOLATION")) {
      try {
        const plan = loadFlightPlan(root);
        if (plan) {
          writeHandoff(root, {
            plan,
            reason: "CANARY_AMNESIA",
            completedFiles: [],
            violations: payload.violations,
          });
          remember(root, input.config, {
            content: `Ground crew handoff ${plan.planId}: ${payload.violations.map((item) => item.message).join(" ")}`,
            tags: ["ctc", "invariant", "handoff"],
            file: payload.file,
          });
        }
      } catch {
        // A bad flight-plan file should not hide the original hold.
      }
    }
  }
  return payload;
}

function readConfig(root: string): { config: CtcConfig } | { error: Violation } {
  try {
    return { config: loadConfig(root) };
  } catch (error) {
    return { error: configViolation(error) };
  }
}

/**
 * Run every Runway Gate rule against an in-memory copy of `content`.
 * The real file is created only when `land` is set and every rule passes.
 * A file whose breaker is already open stays grounded until a human waiver.
 */
export function reviewWrite(request: ReviewRequest): CtcWritePayload {
  const root = path.resolve(request.root);
  const loaded = readConfig(root);
  const state = loadState(root);
  if ("error" in loaded) {
    return reject(root, {
      config: null,
      state,
      file: null,
      violations: [loaded.error],
      source: request.source,
      countStrike: false,
    });
  }
  const config = loaded.config;

  let relative: string;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return reject(root, {
      config,
      state,
      file: request.path,
      violations: [pathViolation(request.path)],
      source: request.source,
      countStrike: true,
    });
  }

  let flightPlan: FlightPlan | null;
  try {
    flightPlan = loadFlightPlan(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reject(root, {
      config,
      state,
      file: relative,
      violations: [configViolation(error)],
      source: request.source,
      countStrike: false,
    });
  }

  let sourceFile = null;
  try {
    sourceFile = simulateSource(relative, request.content);
  } catch (error) {
    return reject(root, {
      config,
      state,
      file: relative,
      violations: [parseViolation(relative, error)],
      source: request.source,
      countStrike: true,
    });
  }

  const radar = readRadar(root);
  if (radar.locked) {
    return reject(root, {
      config,
      state,
      file: relative,
      violations: [
        violation({
          code: "RADAR_RED_LOCK",
          rule: "readRadar",
          gate: "circuit",
          file: relative,
          line: null,
          column: null,
          message: radar.handoff?.bootstrapPrompt ?? "RED lock. Read .ctc/state.json or run ctc reset.",
          fix: "Start a fresh session by reading .ctc/state.json, or run `ctc reset`.",
          useInstead: "ctc reset",
        }),
      ],
      source: request.source,
      countStrike: false,
    });
  }

  if (readZoneLocked(root, config)) {
    return reject(root, {
      config,
      state,
      file: relative,
      violations: [
        violation({
          code: "RADAR_RED_LOCK",
          rule: "readZones",
          gate: "circuit",
          file: relative,
          line: null,
          column: null,
          message: "Writes are locked because read-zone locking is enabled and the zone is red or a re-read loop tripped.",
          fix: "Register a new flight plan to reset counters, or turn off rules.readZones.lockOnRed and lockOnReRead.",
          useInstead: "ctc_check_flightplan persist:true",
        }),
      ],
      source: request.source,
      countStrike: false,
    });
  }

  const findings = runRules({
    root,
    relativePath: relative,
    content: request.content,
    config,
    sourceFile,
    flightPlan,
  });
  const blocking = findings.filter((item) => item.severity !== "warn");
  if (blocking.length === 0 && config.rules.phantom.enabled && sourceFile) {
    findings.push(...runPhantomCheck(root, relative, request.content, config.rules.phantom));
  }
  const violations = findings.filter((item) => item.severity !== "warn");
  const warnings = findings.filter((item) => item.severity === "warn");
  const alreadyOpen = fileStrikes(state, relative).circuitOpen;

  if (alreadyOpen || violations.length > 0) {
    return reject(root, {
      config,
      state,
      file: relative,
      violations,
      source: request.source,
      countStrike: true,
      summary: request.rationale ? `${violations[0]?.message ?? "Rejected."} (${request.rationale})` : undefined,
    });
  }

  let bytesWritten: number | null = null;
  if (request.land) {
    try {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, request.content, "utf8");
      bytesWritten = Buffer.byteLength(request.content, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reject(root, {
        config,
        state,
        file: relative,
        violations: [
          violation({
            code: "IO_ERROR",
            rule: "write",
            gate: "config",
            file: relative,
            line: null,
            column: null,
            message: `CTC cleared the rules but could not write ${relative}: ${message}`,
            fix: "Fix the filesystem error and call ctc_propose_write again. The strike count was not increased.",
          }),
        ],
        source: request.source,
        countStrike: false,
      });
    }
  }

  if (request.land) {
    rememberUtility(root, relative, request.content, config.rules.duplicates.utilityGlobs, {
      minNodeCount: config.rules.duplicates.minAstNodes,
      shingleSize: config.rules.duplicates.shingleSize,
      permutations: config.rules.duplicates.minHashPermutations,
      warnThreshold: config.rules.duplicates.duplicateWarnThreshold,
    });
    noteFileLanded(root, relative);
  }
  const payload = clearedPayload({
    file: relative,
    maxStrikes: config.circuitBreaker.maxStrikes,
    written: request.land,
    bytesWritten,
    warnings,
  });
  const summary = request.rationale ? `${summaryFor(payload)} ${request.rationale}` : summaryFor(payload);
  saveState(root, noteSuccess(state, relative, config.activeMilestone.id, summary));
  appendRadar(root, {
    source: request.source,
    decision: "cleared",
    gate: "none",
    path: relative,
    summary,
    strikes: 0,
    circuitOpen: false,
    violations: [],
  });
  return payload;
}

export function proposeWrite(request: Omit<ReviewRequest, "land" | "source"> & { source?: RadarSource }): CtcWritePayload {
  return reviewWrite({ ...request, land: true, source: request.source ?? "ctc_propose_write" });
}

export function proposePatch(request: { root: string; path: string; hunks: PatchHunk[]; rationale?: string }): CtcWritePayload {
  const root = path.resolve(request.root);
  let relative = request.path;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    const loaded = readConfig(root);
    return reject(root, {
      config: "config" in loaded ? loaded.config : null,
      state: loadState(root),
      file: request.path,
      violations: [pathViolation(request.path)],
      source: "ctc_propose_patch",
      countStrike: false,
    });
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    const loaded = readConfig(root);
    return reject(root, {
      config: "config" in loaded ? loaded.config : null,
      state: loadState(root),
      file: relative,
      violations: [
        violation({
          code: "PATCH_NOT_FOUND",
          rule: "patch",
          gate: "config",
          file: relative,
          line: null,
          column: null,
          message: `Cannot patch ${relative} because the file is not on disk.`,
          fix: "Create the file with ctc_propose_write, or re-read the path.",
          useInstead: "ctc_propose_write",
        }),
      ],
      source: "ctc_propose_patch",
      countStrike: false,
    });
  }
  const applied = applyLiteralPatch(fs.readFileSync(absolute, "utf8"), request.hunks);
  if ("code" in applied) {
    const loaded = readConfig(root);
    return reject(root, {
      config: "config" in loaded ? loaded.config : null,
      state: loadState(root),
      file: relative,
      violations: [
        violation({
          code: applied.code,
          rule: "patch",
          gate: "config",
          file: relative,
          line: null,
          column: null,
          message: applied.message,
          fix: "Re-read the file and send one unique literal search string.",
          useInstead: "ctc_read_file",
        }),
      ],
      source: "ctc_propose_patch",
      countStrike: false,
    });
  }
  return reviewWrite({
    root,
    path: relative,
    content: applied.content,
    ...(request.rationale ? { rationale: request.rationale } : {}),
    source: "ctc_propose_patch",
    land: true,
  });
}

export function checkFlightPlan(request: FlightPlanCheckRequest): FlightPlanPayload {
  const root = path.resolve(request.root);
  const loaded = readConfig(root);
  const state = loadState(root);
  const maxStrikes = "config" in loaded ? loaded.config.circuitBreaker.maxStrikes : 3;
  if ("error" in loaded) {
    const payload = reject(root, {
      config: null,
      state,
      file: null,
      violations: [loaded.error],
      source: "ctc_check_flightplan",
      countStrike: false,
    });
    return { ...payload, protocol: HOLD_PROTOCOL, flightPlan: null, persisted: false };
  }
  const config = loaded.config;
  const milestone = config.activeMilestone;
  const requested = request.milestone ?? milestone.id;
  const violations: Violation[] = [];
  if (milestone.status === "locked") {
    violations.push(
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: requested,
        line: null,
        column: null,
        message: `RUNWAY INCURSION: milestone "${milestone.id}" is locked. All writes are rejected.`,
        fix: 'Set activeMilestone.status to "active" before checking a flight plan.',
        useInstead: 'Set activeMilestone.status to "active".',
      }),
    );
  }
  if (requested !== milestone.id) {
    violations.push(
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: requested,
        line: null,
        column: null,
        message: `RUNWAY INCURSION: flight plan milestone "${requested}" does not match activeMilestone "${milestone.id}".`,
        fix: `Use milestone "${milestone.id}", or change activeMilestone in ctc.config.json first.`,
        useInstead: milestone.id,
      }),
    );
  }
  if (request.paths.length === 0) {
    violations.push(
      violation({
        code: "RUNWAY_INCURSION",
        rule: "flightPlan",
        gate: "scope",
        file: requested,
        line: null,
        column: null,
        message: "RUNWAY INCURSION: a flight plan needs at least one path.",
        fix: "Pass the repo-relative files or globs this task will touch.",
        useInstead: milestone.allowedPaths.join(", "),
      }),
    );
  }
  const accepted: string[] = [];
  for (const pattern of request.paths) {
    const scopeIssue = flightPlanPatternViolation(pattern, milestone.id, milestone.allowedPaths);
    if (scopeIssue) {
      violations.push(scopeIssue);
      continue;
    }
    if (!hasGlob(pattern)) {
      let relative = pattern;
      try {
        relative = normalizeRelative(root, pattern);
      } catch (error) {
        if (error instanceof PathEscapeError) {
          violations.push(pathViolation(pattern));
          continue;
        }
        throw error;
      }
      const lock = matchedLock(relative, config);
      if (lock) {
        violations.push(lockViolation(relative, lock));
        continue;
      }
      accepted.push(relative);
      continue;
    }
    accepted.push(pattern.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  if (violations.length > 0) {
    const payload = reject(root, {
      config,
      state,
      file: null,
      violations,
      source: "ctc_check_flightplan",
      countStrike: false,
    });
    return { ...payload, protocol: HOLD_PROTOCOL, flightPlan: null, persisted: false };
  }

  const unique: string[] = [];
  for (const pattern of accepted) {
    if (!unique.includes(pattern)) unique.push(pattern);
  }
  let plan: FlightPlan;
  try {
    plan = normalizeFlightPlan({
      milestone: milestone.id,
      intent: request.intent ?? "",
      paths: unique,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      invariants: request.invariants ?? [],
      canaries: request.canaries ?? [],
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const payload = reject(root, {
      config,
      state,
      file: null,
      violations: [configViolation(error)],
      source: "ctc_check_flightplan",
      countStrike: false,
    });
    return { ...payload, protocol: HOLD_PROTOCOL, flightPlan: null, persisted: false };
  }
  const persist = request.persist === true;
  if (persist) {
    saveFlightPlan(root, plan);
    resetReadZone(root, plan.planId);
    remember(root, config, {
      content: `Flight plan ${plan.planId} (${plan.milestone}): ${plan.intent || "no objective"}. Invariants: ${plan.invariants.map((item) => item.text).join(" | ") || "none"}.`,
      tags: ["ctc", "invariant", "flight-plan"],
    });
  }
  const payload: FlightPlanPayload = {
    ...clearedPayload({
      file: null,
      maxStrikes,
      written: false,
      bytesWritten: null,
    }),
    protocol: FLIGHTPLAN_PROTOCOL,
    strikes: 0,
    circuit: anyCircuitOpen(state) ? "open" : "closed",
    flightPlan: plan,
    persisted: persist,
  };
  appendRadar(root, {
    source: "ctc_check_flightplan",
    decision: "cleared",
    gate: "none",
    path: null,
    summary: persist
      ? `Flight plan persisted for ${plan.milestone} (${plan.paths.length} paths).`
      : `Flight plan cleared for ${plan.milestone} (${plan.paths.length} paths) without persisting.`,
    strikes: 0,
    circuitOpen: anyCircuitOpen(state),
    violations: [],
  });
  return payload;
}
