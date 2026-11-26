import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "../paths.js";

export interface FileBreaker {
  consecutiveRejections: number;
  circuitOpen: boolean;
}

export interface GroundCrewState {
  version: 1;
  /** Strike counts are per file. Three consecutive rejections of one path open that file. */
  files: Record<string, FileBreaker>;
  activeMilestone: string | null;
  lastFile: string | null;
  lastDecision: "cleared" | "rejected" | "noted" | "waived" | null;
  lastSummary: string | null;
  updatedAt: string;
}

export function statePath(root: string): string {
  return path.join(root, ".ctc", "state.json");
}

export function defaultState(now = new Date().toISOString()): GroundCrewState {
  return {
    version: 1,
    files: {},
    activeMilestone: null,
    lastFile: null,
    lastDecision: null,
    lastSummary: null,
    updatedAt: now,
  };
}

export function fileStrikes(state: GroundCrewState, file: string): FileBreaker {
  return state.files[file] ?? { consecutiveRejections: 0, circuitOpen: false };
}

export function anyCircuitOpen(state: GroundCrewState): boolean {
  return Object.values(state.files).some((entry) => entry.circuitOpen);
}

export function loadState(root: string): GroundCrewState {
  const file = statePath(root);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GroundCrewState> & {
      files?: Record<string, Partial<FileBreaker>>;
    };
    if (raw.version !== 1) return defaultState();
    const base = defaultState(typeof raw.updatedAt === "string" ? raw.updatedAt : undefined);
    const files: Record<string, FileBreaker> = {};
    if (raw.files && typeof raw.files === "object") {
      for (const [key, value] of Object.entries(raw.files)) {
        if (!value || typeof value !== "object") continue;
        const count = typeof value.consecutiveRejections === "number" && value.consecutiveRejections >= 0
          ? value.consecutiveRejections
          : 0;
        files[key] = { consecutiveRejections: count, circuitOpen: value.circuitOpen === true };
      }
    }
    return {
      ...base,
      files,
      activeMilestone: typeof raw.activeMilestone === "string" ? raw.activeMilestone : null,
      lastFile: typeof raw.lastFile === "string" ? raw.lastFile : null,
      lastDecision: raw.lastDecision ?? null,
      lastSummary: typeof raw.lastSummary === "string" ? raw.lastSummary : null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(root: string, state: GroundCrewState): void {
  const file = statePath(root);
  ensureDir(path.dirname(file));
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...state }, null, 2)}\n`, "utf8");
}

export function noteRejection(state: GroundCrewState, file: string, maxStrikes: number, summary: string): GroundCrewState {
  const current = fileStrikes(state, file);
  const consecutive = Math.min(maxStrikes, current.consecutiveRejections + (current.circuitOpen ? 0 : 1));
  return {
    ...state,
    files: {
      ...state.files,
      [file]: { consecutiveRejections: consecutive, circuitOpen: consecutive >= maxStrikes },
    },
    lastFile: file,
    lastDecision: "rejected",
    lastSummary: summary,
    updatedAt: new Date().toISOString(),
  };
}

export function noteSuccess(state: GroundCrewState, file: string, milestoneId: string, summary: string): GroundCrewState {
  const files = { ...state.files };
  delete files[file];
  return {
    ...state,
    files,
    activeMilestone: milestoneId,
    lastFile: file,
    lastDecision: "cleared",
    lastSummary: summary,
    updatedAt: new Date().toISOString(),
  };
}

export function noteWaiver(state: GroundCrewState, summary: string): GroundCrewState {
  return {
    ...state,
    files: {},
    lastDecision: "waived",
    lastSummary: summary,
    updatedAt: new Date().toISOString(),
  };
}

export function noteLog(state: GroundCrewState, decision: GroundCrewState["lastDecision"], summary: string): GroundCrewState {
  return {
    ...state,
    lastDecision: decision,
    lastSummary: summary,
    updatedAt: new Date().toISOString(),
  };
}
