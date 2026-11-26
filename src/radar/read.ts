import fs from "node:fs";
import path from "node:path";

import { PathEscapeError, normalizeRelative } from "../paths.js";
import { distillSignatures, estimateTokens } from "../engine/read-zone.js";
import { loadActiveFlightPlan } from "../blueprint/store.js";
import { CONTEXT_WINDOW_TOKENS, zoneFor, type RadarTelemetry, type RadarZone } from "../schemas/radar.js";
import { lockSession, readRadar, unlockSession, writeRadar, type RadarDisk } from "./state.js";

export interface GuardedReadResult {
  protocol: "ctc.read.v1";
  cleared: boolean;
  file: string;
  content: string;
  zone: RadarZone;
  estimatedTokens: number;
  tokenEstimate: true;
  distilled: boolean;
  locked: boolean;
  unlocked: boolean;
  warning: string | null;
  bootstrapPrompt: string | null;
  telemetry: RadarTelemetry;
  message?: string;
}

function telemetry(radar: RadarDisk, filePath: string, lineRange: string, consecutive: number, zone: RadarZone): RadarTelemetry {
  return {
    zone,
    utilization: Number((radar.estimatedTokensUsed / CONTEXT_WINDOW_TOKENS).toFixed(4)),
    estimatedTokensUsed: radar.estimatedTokensUsed,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    consecutiveFailures: radar.consecutiveFailures,
    consecutiveIdenticalReads: consecutive,
    filePath,
    lineRange,
    tokenEstimate: true,
  };
}

function failed(file: string, radar: RadarDisk, message: string, locked: boolean): GuardedReadResult {
  const zone: RadarZone = locked ? "RED" : "GREEN";
  return {
    protocol: "ctc.read.v1",
    cleared: false,
    file,
    content: "",
    zone,
    estimatedTokens: 0,
    tokenEstimate: true,
    distilled: false,
    locked,
    unlocked: false,
    warning: message,
    bootstrapPrompt: locked ? radar.handoff?.bootstrapPrompt ?? null : null,
    telemetry: telemetry(radar, file, "FULL", locked ? 3 : 0, zone),
    message,
  };
}

export function readFile(rootInput: string, request: { path: string; startLine?: number; endLine?: number; forceFull?: boolean; sessionId?: string }): GuardedReadResult {
  const root = path.resolve(rootInput);
  let relative: string;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    const radar = readRadar(root);
    return failed(request.path, radar, `Path "${request.path}" escapes the project root.`, false);
  }

  let radar = readRadar(root);
  const sessionId = request.sessionId ?? radar.sessionId ?? "local";
  if (radar.locked) {
    const freshSession = request.sessionId != null && request.sessionId !== radar.lockedSessionId;
    const readingHandoff = relative === ".ctc/state.json";
    if (freshSession || readingHandoff) {
      const prompt = radar.handoff?.bootstrapPrompt ?? null;
      radar = unlockSession(root, freshSession ? request.sessionId! : sessionId);
      if (readingHandoff) {
        const content = fs.existsSync(path.join(root, relative)) ? fs.readFileSync(path.join(root, relative), "utf8") : "";
        return {
          protocol: "ctc.read.v1",
          cleared: true,
          file: relative,
          content,
          zone: "GREEN",
          estimatedTokens: estimateTokens(content),
          tokenEstimate: true,
          distilled: false,
          locked: false,
          unlocked: true,
          warning: "RED lock cleared because this session read .ctc/state.json.",
          bootstrapPrompt: prompt,
          telemetry: telemetry(radar, relative, "FULL", 1, "GREEN"),
        };
      }
    } else {
      return failed(relative, radar, "RED lock. Read .ctc/state.json, pass a new sessionId, or run `ctc reset`.", true);
    }
  }

  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    const current = readRadar(root);
    return {
      protocol: "ctc.read.v1",
      cleared: false,
      file: relative,
      content: "",
      zone: current.locked ? "RED" : "GREEN",
      estimatedTokens: 0,
      tokenEstimate: true,
      distilled: false,
      locked: current.locked,
      unlocked: false,
      warning: null,
      bootstrapPrompt: current.handoff?.bootstrapPrompt ?? null,
      telemetry: telemetry(current, relative, "FULL", 0, current.locked ? "RED" : "GREEN"),
      message: `${relative} is not a file.`,
    };
  }

  const raw = fs.readFileSync(absolute, "utf8");
  const lines = raw.split("\n");
  const start = request.startLine ?? 1;
  const end = request.endLine ?? lines.length;
  const ranged = request.startLine !== undefined || request.endLine !== undefined;
  const sliced = ranged ? lines.slice(Math.max(0, start - 1), Math.max(0, end)).join("\n") : raw;
  const rangeKey = ranged ? `L${start}-L${end}` : "FULL";
  radar = readRadar(root);
  const previous = radar.reads[relative];
  const consecutive = previous && previous.rangeKey === rangeKey ? previous.consecutive + 1 : 1;
  const wholeFile = !ranged;
  const shouldDistill = wholeFile && !request.forceFull && consecutive >= 2;
  const distilled = shouldDistill ? distillSignatures(relative, raw) : { content: sliced, distilled: false };
  const content = shouldDistill ? distilled.content : sliced;
  const tokens = estimateTokens(content);
  radar.estimatedTokensUsed += tokens;
  radar.sessionId = sessionId;
  radar.reads[relative] = { rangeKey, consecutive };
  const utilization = radar.estimatedTokensUsed / CONTEXT_WINDOW_TOKENS;
  const zone = zoneFor({ utilization, consecutiveIdenticalReads: consecutive, consecutiveFailures: radar.consecutiveFailures });
  let warning: string | null = null;
  if (consecutive >= 2 && zone !== "RED") {
    warning = `Re-read ${consecutive} of ${relative} (${rangeKey}). Yellow reads of a whole TypeScript file return signatures. Token counts are estimates (characters / 4).`;
  }
  if (zone === "RED") {
    const reason = consecutive >= 3 ? "RED_ZONE_LOCK" : radar.consecutiveFailures >= 3 ? "CONSECUTIVE_GATE_FAILURES" : "CONTEXT_SATURATION";
    warning = `RED lock after ${reason}. Token counts are estimates (characters / 4), not a model tokenizer.`;
    writeRadar(root, radar);
    radar = lockSession(root, {
      sessionId,
      reason,
      plan: loadActiveFlightPlan(root),
      violations: radar.lastViolations,
      zone,
    });
  } else {
    writeRadar(root, radar);
  }
  return {
    protocol: "ctc.read.v1",
    cleared: zone !== "RED",
    file: relative,
    content: zone === "RED" ? "" : content,
    zone,
    estimatedTokens: tokens,
    tokenEstimate: true,
    distilled: zone === "RED" ? false : distilled.distilled,
    locked: zone === "RED",
    unlocked: false,
    warning,
    bootstrapPrompt: radar.handoff?.bootstrapPrompt ?? null,
    telemetry: telemetry(radar, relative, rangeKey, consecutive, zone),
  };
}
