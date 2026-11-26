import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDir } from "../paths.js";
import type { PrimaryGate, RadarDecision, RadarEntry, RadarSource, Violation } from "./types.js";

export function radarPath(root: string): string {
  return path.join(root, ".ctc", "radar.jsonl");
}

export function appendRadar(
  root: string,
  input: {
    source: RadarSource;
    decision: RadarDecision;
    gate: PrimaryGate | null;
    path: string | null;
    summary: string;
    strikes: number;
    circuitOpen: boolean;
    violations: Violation[];
    ts?: string;
  },
): RadarEntry {
  const entry: RadarEntry = {
    id: randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    source: input.source,
    decision: input.decision,
    gate: input.gate,
    path: input.path,
    summary: input.summary,
    strikes: input.strikes,
    circuitOpen: input.circuitOpen,
    violations: input.violations,
  };
  const file = radarPath(root);
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export interface RadarQuery {
  limit?: number;
  gate?: string;
  path?: string;
  decision?: RadarDecision;
  since?: string;
  source?: RadarSource;
}

export function queryRadar(root: string, query: RadarQuery = {}): RadarEntry[] {
  const file = radarPath(root);
  if (!fs.existsSync(file)) return [];
  const entries: RadarEntry[] = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as RadarEntry);
    } catch {
      continue;
    }
  }
  const limit = Math.min(500, Math.max(1, query.limit ?? 50));
  const indexed = entries.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    if (a.entry.ts !== b.entry.ts) return a.entry.ts < b.entry.ts ? 1 : -1;
    return b.index - a.index;
  });
  return indexed
    .map((item) => item.entry)
    .filter((entry) => (query.gate ? entry.gate === query.gate : true))
    .filter((entry) => (query.path ? entry.path === query.path : true))
    .filter((entry) => (query.decision ? entry.decision === query.decision : true))
    .filter((entry) => (query.source ? entry.source === query.source : true))
    .filter((entry) => (query.since ? entry.ts >= query.since : true))
    .slice(0, limit);
}
