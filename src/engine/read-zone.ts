import fs from "node:fs";
import path from "node:path";

import { PathEscapeError, normalizeRelative } from "../paths.js";
import { Node, Project, ScriptKind, SyntaxKind } from "ts-morph";

import type { CtcConfig, FlightPlan } from "../config/schema.js";
import { loadFlightPlan } from "./flight-plan.js";
import { writeHandoff, type HandoffReason } from "./handoff.js";
import { ensureDir } from "../paths.js";
import type { Violation } from "./types.js";

export type RadarZone = "GREEN" | "YELLOW" | "RED";

interface ReadTracker {
  rangeKey: string;
  consecutive: number;
  total: number;
}

interface ReadSession {
  version: 1;
  planId: string | null;
  estimatedTokensUsed: number;
  zone: RadarZone;
  reads: Record<string, ReadTracker>;
  completedFiles: string[];
  lastViolations: Violation[];
}

export interface ReadOutcome {
  zone: RadarZone;
  estimatedTokens: number;
  utilization: number;
  warning: string | null;
  reRead: boolean;
  consecutiveReads: number;
  locked: boolean;
  handoffReason: HandoffReason | null;
}

function sessionPath(root: string): string {
  return path.join(root, ".ctc", "read-zone.json");
}

function emptySession(): ReadSession {
  return { version: 1, planId: null, estimatedTokensUsed: 0, zone: "GREEN", reads: {}, completedFiles: [], lastViolations: [] };
}

export function loadReadSession(root: string): ReadSession {
  const file = sessionPath(root);
  if (!fs.existsSync(file)) return emptySession();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ReadSession>;
    const base = emptySession();
    return {
      ...base,
      planId: typeof raw.planId === "string" ? raw.planId : null,
      estimatedTokensUsed: typeof raw.estimatedTokensUsed === "number" ? raw.estimatedTokensUsed : 0,
      zone: raw.zone === "YELLOW" || raw.zone === "RED" ? raw.zone : "GREEN",
      reads: raw.reads && typeof raw.reads === "object" ? raw.reads : {},
      completedFiles: Array.isArray(raw.completedFiles) ? raw.completedFiles.filter((item) => typeof item === "string") : [],
      lastViolations: Array.isArray(raw.lastViolations) ? raw.lastViolations : [],
    };
  } catch {
    return emptySession();
  }
}

function saveReadSession(root: string, session: ReadSession): void {
  const file = sessionPath(root);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function resetReadZone(root: string, planId: string): void {
  const next = emptySession();
  next.planId = planId;
  saveReadSession(root, next);
}

export function noteFileLanded(root: string, relativePath: string): void {
  const session = loadReadSession(root);
  delete session.reads[relativePath];
  if (!session.completedFiles.includes(relativePath)) session.completedFiles.push(relativePath);
  saveReadSession(root, session);
}

export function noteGateViolations(root: string, violations: readonly Violation[]): void {
  const session = loadReadSession(root);
  session.lastViolations = [...violations];
  saveReadSession(root, session);
}

/** Rough token estimate: 1 token per 4 characters. This is not a model tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function recordRead(root: string, config: CtcConfig, filePath: string, rangeKey: string, deliveredTokens: number): ReadOutcome {
  const settings = config.rules.readZones;
  const session = loadReadSession(root);
  if (!settings.enabled) {
    return {
      zone: "GREEN",
      estimatedTokens: deliveredTokens,
      utilization: 0,
      warning: null,
      reRead: false,
      consecutiveReads: 1,
      locked: false,
      handoffReason: null,
    };
  }
  session.estimatedTokensUsed += deliveredTokens;
  const utilization = session.estimatedTokensUsed / settings.contextWindowTokens;
  let warning: string | null = null;
  let handoffReason: HandoffReason | null = null;
  if (utilization >= settings.redAt) {
    if (session.zone !== "RED") handoffReason = "CONTEXT_SATURATION";
    session.zone = "RED";
    warning = `Estimated context use is ${Math.round(utilization * 100)}% of the configured window. Token counts are estimates (characters / 4), not model tokens.`;
  } else if (utilization >= settings.yellowAt && session.zone === "GREEN") {
    session.zone = "YELLOW";
    warning = `Estimated context use entered the yellow zone at ${Math.round(utilization * 100)}%. Later reads of whole TypeScript files return signatures unless forceFull is set.`;
  }

  const tracker = session.reads[filePath] ?? { rangeKey: "", consecutive: 0, total: 0 };
  tracker.total += 1;
  tracker.consecutive = tracker.rangeKey === rangeKey ? tracker.consecutive + 1 : 1;
  tracker.rangeKey = rangeKey;
  session.reads[filePath] = tracker;
  const reRead = tracker.consecutive >= 2;
  if (reRead) {
    warning = `Re-read warning: ${filePath} (${rangeKey}) was read ${tracker.consecutive} times with no intervening landing.`;
    if (session.zone === "GREEN") session.zone = "YELLOW";
  }
  const locked = (settings.lockOnRed && session.zone === "RED") || (settings.lockOnReRead && tracker.consecutive >= 3);
  if (handoffReason || (reRead && tracker.consecutive >= 3 && settings.lockOnReRead)) {
    const plan = safePlan(root);
    if (plan) {
      writeHandoff(root, {
        plan,
        reason: handoffReason ?? "RETRY_THRASHING",
        completedFiles: session.completedFiles,
        violations: session.lastViolations,
      });
    }
  }
  saveReadSession(root, session);
  return {
    zone: session.zone,
    estimatedTokens: deliveredTokens,
    utilization: Number(utilization.toFixed(3)),
    warning,
    reRead,
    consecutiveReads: tracker.consecutive,
    locked,
    handoffReason,
  };
}

function safePlan(root: string): FlightPlan | null {
  try {
    return loadFlightPlan(root);
  } catch {
    return null;
  }
}

export function readZoneLocked(root: string, config: CtcConfig): boolean {
  if (!config.rules.readZones.lockOnRed && !config.rules.readZones.lockOnReRead) return false;
  const session = loadReadSession(root);
  if (config.rules.readZones.lockOnRed && session.zone === "RED") return true;
  if (!config.rules.readZones.lockOnReRead) return false;
  return Object.values(session.reads).some((tracker) => tracker.consecutive >= 3);
}

const distiller = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });

export interface GuardedRead {
  protocol: "ctc.read.v1";
  cleared: boolean;
  file: string;
  content: string;
  zone: RadarZone;
  estimatedTokens: number;
  /** Always true: counts are characters/4, not a model tokenizer. */
  tokenEstimate: true;
  distilled: boolean;
  warning: string | null;
  locked: boolean;
  message?: string;
}

export function readGuarded(
  rootInput: string,
  config: CtcConfig,
  request: { path: string; startLine?: number; endLine?: number; forceFull?: boolean },
): GuardedRead {
  const root = path.resolve(rootInput);
  let relative: string;
  try {
    relative = normalizeRelative(root, request.path);
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error;
    return {
      protocol: "ctc.read.v1",
      cleared: false,
      file: request.path,
      content: "",
      zone: "GREEN",
      estimatedTokens: 0,
      tokenEstimate: true,
      distilled: false,
      warning: null,
      locked: false,
      message: `Path "${request.path}" escapes the project root.`,
    };
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return {
      protocol: "ctc.read.v1",
      cleared: false,
      file: relative,
      content: "",
      zone: "GREEN",
      estimatedTokens: 0,
      tokenEstimate: true,
      distilled: false,
      warning: null,
      locked: false,
      message: `${relative} is not a file.`,
    };
  }
  const raw = fs.readFileSync(absolute, "utf8");
  const lines = raw.split("\n");
  const start = request.startLine ?? 1;
  const end = request.endLine ?? lines.length;
  const sliced = request.startLine !== undefined || request.endLine !== undefined ? lines.slice(Math.max(0, start - 1), Math.max(0, end)).join("\n") : raw;
  const narrow = request.startLine !== undefined && request.endLine !== undefined && end - start <= 80;
  const session = loadReadSession(root);
  const shouldDistill = config.rules.readZones.signatureOnlyInYellow && session.zone !== "GREEN" && !request.forceFull && !narrow;
  const distilled = shouldDistill ? distillSignatures(relative, raw) : { content: sliced, distilled: false };
  const content = shouldDistill ? distilled.content : sliced;
  const outcome = recordRead(root, config, relative, request.startLine || request.endLine ? `L${start}-L${end}` : "FULL", estimateTokens(content));
  return {
    protocol: "ctc.read.v1",
    cleared: true,
    file: relative,
    content,
    zone: outcome.zone,
    estimatedTokens: outcome.estimatedTokens,
    tokenEstimate: true,
    distilled: distilled.distilled,
    warning: outcome.warning,
    locked: outcome.locked,
  };
}

export function distillSignatures(relativePath: string, content: string): { content: string; distilled: boolean } {
  if (!/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/i.test(relativePath)) return { content, distilled: false };
  const kind = relativePath.endsWith("x") ? ScriptKind.TSX : ScriptKind.TS;
  const source = distiller.createSourceFile(relativePath, content, { overwrite: true, scriptKind: kind });
  try {
    for (const fn of source.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
      if (fn.getBody()) fn.setBodyText("/* body elided */");
    }
    for (const method of source.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
      if (method.getBody()) method.setBodyText("/* body elided */");
    }
    for (const ctor of source.getDescendantsOfKind(SyntaxKind.Constructor)) {
      if (ctor.getBody()) ctor.setBodyText("/* body elided */");
    }
    for (const statement of source.getVariableStatements()) {
      for (const decl of statement.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init || (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init))) continue;
        const body = init.getBody();
        if (Node.isBlock(body)) init.setBodyText("/* body elided */");
        else body.replaceWithText("{ /* body elided */ }");
      }
    }
    return { content: source.getFullText(), distilled: true };
  } finally {
    distiller.removeSourceFile(source);
  }
}
