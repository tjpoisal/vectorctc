import path from "node:path";

import { readFindings, type FindingRecord } from "../telemetry/findings-log.js";

/** Findings-log records from one or more repos inside a time window, oldest first. */
export function windowRecords(roots: readonly string[], options: { days?: number; now?: Date } = {}): Array<FindingRecord & { repo: string }> {
  const days = options.days ?? 30;
  const now = options.now ?? new Date();
  const since = now.getTime() - days * 86_400_000;
  const out: Array<FindingRecord & { repo: string }> = [];
  for (const rootInput of roots) {
    const root = path.resolve(rootInput);
    for (const record of readFindings(root)) if (Date.parse(record.ts) >= since) out.push({ ...record, repo: path.basename(root) });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}
