import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { statePath } from "../engine/circuit-breaker.js";
import { filesMatching } from "../engine/handoff.js";
import { ensureDir } from "../paths.js";
import type { GateViolation } from "../schemas/gate.js";
import type { FlightPlanContract } from "../schemas/flightPlan.js";
import { CONTEXT_WINDOW_TOKENS, type GroundCrewHandoff, type HandoffReason, type RadarZone } from "../schemas/radar.js";

export interface RadarDisk {
  sessionId: string;
  locked: boolean;
  lockedSessionId: string | null;
  consecutiveFailures: number;
  estimatedTokensUsed: number;
  reads: Record<string, { rangeKey: string; consecutive: number }>;
  completedFiles: string[];
  lastViolations: string[];
  handoff: GroundCrewHandoff | null;
}

const HANDOFF_KEYS = [
  "handoffId",
  "generatedAt",
  "previousSessionId",
  "triggerReason",
  "activePlanId",
  "objective",
  "invariants",
  "completedFiles",
  "pendingFiles",
  "unresolvedViolations",
  "bootstrapPrompt",
] as const;

function emptyRadar(): RadarDisk {
  return {
    sessionId: "local",
    locked: false,
    lockedSessionId: null,
    consecutiveFailures: 0,
    estimatedTokensUsed: 0,
    reads: {},
    completedFiles: [],
    lastViolations: [],
    handoff: null,
  };
}

export function readRawState(root: string): Record<string, unknown> {
  const file = statePath(root);
  if (!fs.existsSync(file)) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, files: {} };
    return parsed as Record<string, unknown>;
  } catch {
    return { version: 1, files: {} };
  }
}

export function writeRawState(root: string, raw: Record<string, unknown>): void {
  const file = statePath(root);
  ensureDir(path.dirname(file));
  if (raw.version !== 1) raw.version = 1;
  if (!raw.files || typeof raw.files !== "object") raw.files = {};
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export function readRadar(root: string): RadarDisk {
  const raw = readRawState(root);
  const radar = raw.radar;
  if (!radar || typeof radar !== "object" || Array.isArray(radar)) return emptyRadar();
  const body = radar as Partial<RadarDisk>;
  const base = emptyRadar();
  return {
    ...base,
    sessionId: typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "local",
    locked: body.locked === true,
    lockedSessionId: typeof body.lockedSessionId === "string" ? body.lockedSessionId : null,
    consecutiveFailures: typeof body.consecutiveFailures === "number" ? body.consecutiveFailures : 0,
    estimatedTokensUsed: typeof body.estimatedTokensUsed === "number" ? body.estimatedTokensUsed : 0,
    reads: body.reads && typeof body.reads === "object" ? body.reads : {},
    completedFiles: Array.isArray(body.completedFiles) ? body.completedFiles.filter((item) => typeof item === "string") : [],
    lastViolations: Array.isArray(body.lastViolations) ? body.lastViolations.filter((item) => typeof item === "string") : [],
    handoff: body.handoff && typeof body.handoff === "object" ? (body.handoff as GroundCrewHandoff) : null,
  };
}

export function writeRadar(root: string, radar: RadarDisk): void {
  const raw = readRawState(root);
  raw.radar = radar;
  if (radar.handoff) {
    for (const key of HANDOFF_KEYS) raw[key] = radar.handoff[key];
  }
  writeRawState(root, raw);
}

export function sessionLockedFor(root: string, sessionId: string | undefined): boolean {
  const radar = readRadar(root);
  if (!radar.locked) return false;
  if (sessionId && radar.lockedSessionId && sessionId !== radar.lockedSessionId) return false;
  return true;
}

export function buildHandoff(input: {
  root: string;
  plan: FlightPlanContract | null;
  sessionId: string;
  reason: HandoffReason;
  violations: readonly string[];
  completedFiles: readonly string[];
}): GroundCrewHandoff {
  const completed = [...input.completedFiles];
  const pendingFiles = input.plan ? filesMatching(input.root, input.plan.allowedFileGlobs).filter((file) => !completed.includes(file)) : [];
  const invariants = input.plan?.invariants.map((item) => item.text) ?? [];
  const objective = input.plan?.objective || "No active flight plan.";
  const violations = input.violations.length > 0 ? input.violations : ["none"];
  const bootstrapPrompt = [
    "CTC GROUND CREW HANDOFF — clean slate.",
    `Reason: ${input.reason}.`,
    `Objective: ${objective}`,
    `Invariants: ${invariants.join(" | ") || "none"}.`,
    `Completed files: ${completed.join(", ") || "none"}.`,
    `Pending files: ${pendingFiles.join(", ") || "none"}.`,
    "Violations:",
    ...violations.map((line) => `- ${line}`),
    "Stop the previous thread. Read this handoff, then continue from the pending files.",
    "A different sessionId, a read of .ctc/state.json, or `ctc reset` clears the RED lock.",
  ].join("\n");
  return {
    handoffId: randomUUID(),
    generatedAt: new Date().toISOString(),
    previousSessionId: input.sessionId,
    triggerReason: input.reason,
    activePlanId: input.plan?.planId ?? "none",
    objective,
    invariants,
    completedFiles: completed,
    pendingFiles,
    unresolvedViolations: [...input.violations],
    bootstrapPrompt,
  };
}

export function lockSession(root: string, input: { sessionId: string; reason: HandoffReason; plan: FlightPlanContract | null; violations: readonly string[]; zone: RadarZone }): RadarDisk {
  const radar = readRadar(root);
  radar.sessionId = input.sessionId;
  radar.locked = true;
  radar.lockedSessionId = input.sessionId;
  radar.handoff = buildHandoff({
    root,
    plan: input.plan,
    sessionId: input.sessionId,
    reason: input.reason,
    violations: input.violations.length > 0 ? input.violations : radar.lastViolations,
    completedFiles: radar.completedFiles,
  });
  writeRadar(root, radar);
  return radar;
}

export function unlockSession(root: string, sessionId: string): RadarDisk {
  const radar = readRadar(root);
  radar.locked = false;
  radar.lockedSessionId = null;
  radar.sessionId = sessionId;
  radar.consecutiveFailures = 0;
  radar.estimatedTokensUsed = 0;
  radar.reads = {};
  writeRadar(root, radar);
  return radar;
}

export function resetRadar(root: string): { sessionId: string; bootstrapPrompt: string | null } {
  const previous = readRadar(root);
  const sessionId = randomUUID();
  unlockSession(root, sessionId);
  return { sessionId, bootstrapPrompt: previous.handoff?.bootstrapPrompt ?? null };
}

export function noteVerifiedFile(root: string, relativePath: string): void {
  const radar = readRadar(root);
  if (!radar.completedFiles.includes(relativePath)) radar.completedFiles.push(relativePath);
  delete radar.reads[relativePath];
  radar.consecutiveFailures = 0;
  writeRadar(root, radar);
}

export function noteFailure(root: string, sessionId: string, violations: readonly GateViolation[], plan: FlightPlanContract | null): RadarDisk {
  const radar = readRadar(root);
  radar.sessionId = sessionId;
  radar.consecutiveFailures += 1;
  radar.lastViolations = violations.map((item) => `[${item.code}] ${item.file}:${item.line ?? 1} ${item.message}`);
  writeRadar(root, radar);
  if (radar.consecutiveFailures >= 3) {
    return lockSession(root, { sessionId, reason: "CONSECUTIVE_GATE_FAILURES", plan, violations: radar.lastViolations, zone: "RED" });
  }
  return radar;
}

export { CONTEXT_WINDOW_TOKENS };
