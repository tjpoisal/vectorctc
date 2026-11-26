import path from "node:path";

import { ledgerSummary } from "../explain/ledger.js";
import { reportCard, type ReportCardRow } from "../insights/report-card.js";
import { listReplays } from "../replay/store.js";
import { readFindings, verifyChain, type FindingRecord } from "../telemetry/findings-log.js";

/**
 * Team dashboard data (v0.4 item 12): aggregates the hash-chained findings logs of one or more repos.
 * Everything is computed locally from .ctc/findings.jsonl and .ctc/fix-ledger.json; nothing leaves the machine.
 */

export interface DashboardData {
  generatedAt: string;
  windowDays: number;
  repos: Array<{ name: string; root: string; records: number; chain: { ok: boolean; brokenAt: number | null; reason: string | null } }>;
  totals: { decisions: number; held: number; cleared: number; observed: number; holdRate: number; medianMs: number | null; p95Ms: number | null };
  daily: Array<{ day: string; held: number; cleared: number; observed: number }>;
  codes: Array<{ code: string; rule: string; blocks: number; observes: number; warns: number; files: number }>;
  /** What enforce mode would add: observe-mode findings by code. */
  rollout: Array<{ code: string; wouldBlock: number; files: string[] }>;
  surfaces: Array<{ name: string; decisions: number; held: number }>;
  actors: Array<{ name: string; decisions: number; held: number }>;
  hotspots: Array<{ repo: string; file: string; holds: number; lastHeld: string }>;
  fixLoop: { recovered: number; medianAttempts: number | null; stillHeld: number; stuckFiles: number; openFindings: number; resolvedFindings: number };
  /** v0.5: hold rate, top rules and attempts to clear per agent and model. */
  reportCard: ReportCardRow[];
  /** v0.5: newest local replays ("why it held"); `repo` is the index into `repos`. */
  replays: Array<{ repo: number; id: string; ts: string; file: string; decision: "held" | "observed"; agent: string | null; codes: string[] }>;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

const bump = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

export function aggregate(roots: readonly string[], options: { days?: number; now?: Date } = {}): DashboardData {
  const days = options.days ?? 30;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const repos: DashboardData["repos"] = [];
  const all: Array<FindingRecord & { repo: string }> = [];
  let stuckFiles = 0;
  let openFindings = 0;
  let resolvedFindings = 0;
  for (const rootInput of roots) {
    const root = path.resolve(rootInput);
    const name = path.basename(root);
    const records = readFindings(root);
    const chain = verifyChain(root);
    repos.push({ name, root, records: records.length, chain: { ok: chain.ok, brokenAt: chain.brokenAt, reason: chain.reason } });
    for (const record of records) if (new Date(record.ts) >= since) all.push({ ...record, repo: name });
    for (const entry of ledgerSummary(root)) {
      if (entry.stuck > 0) stuckFiles += 1;
      openFindings += entry.open;
      resolvedFindings += entry.resolved;
    }
  }
  all.sort((a, b) => a.ts.localeCompare(b.ts));
  const replays: DashboardData["replays"] = [];
  roots.forEach((rootInput, index) => {
    for (const replay of listReplays(path.resolve(rootInput), 20)) {
      if (new Date(replay.ts) < since) continue;
      replays.push({ repo: index, id: replay.id, ts: replay.ts, file: replay.file, decision: replay.decision, agent: replay.agent, codes: [...new Set(replay.explanations.map((item) => item.code))] });
    }
  });
  replays.sort((a, b) => b.ts.localeCompare(a.ts));
  const held = all.filter((item) => item.decision === "held").length;
  const cleared = all.filter((item) => item.decision === "cleared").length;
  const observed = all.filter((item) => item.decision === "observed").length;
  const ms = all.map((item) => item.ms).filter((value): value is number => typeof value === "number");

  const daily = new Map<string, { held: number; cleared: number; observed: number }>();
  for (let index = days - 1; index >= 0; index -= 1) daily.set(new Date(now.getTime() - index * 86_400_000).toISOString().slice(0, 10), { held: 0, cleared: 0, observed: 0 });
  for (const item of all) {
    const bucket = daily.get(item.ts.slice(0, 10));
    if (bucket) bucket[item.decision] += 1;
  }

  const codeStats = new Map<string, { rule: string; blocks: number; observes: number; warns: number; files: Set<string> }>();
  const rollout = new Map<string, Set<string>>();
  const rolloutCount = new Map<string, number>();
  for (const item of all) {
    for (const finding of item.findings) {
      const stat = codeStats.get(finding.code) ?? { rule: finding.rule, blocks: 0, observes: 0, warns: 0, files: new Set<string>() };
      if (finding.severity === "block") stat.blocks += 1;
      else if (finding.severity === "observe") stat.observes += 1;
      else stat.warns += 1;
      stat.files.add(`${item.repo}/${item.file}`);
      codeStats.set(finding.code, stat);
      if (finding.severity === "observe") {
        const set = rollout.get(finding.code) ?? new Set<string>();
        set.add(`${item.repo}/${item.file}`);
        rollout.set(finding.code, set);
        bump(rolloutCount, finding.code);
      }
    }
  }

  const bySurface = new Map<string, { decisions: number; held: number }>();
  const byActor = new Map<string, { decisions: number; held: number }>();
  for (const item of all) {
    for (const [map, key] of [[bySurface, item.surface], [byActor, item.actor ?? "(unset)"]] as const) {
      const entry = map.get(key) ?? { decisions: 0, held: 0 };
      entry.decisions += 1;
      if (item.decision === "held") entry.held += 1;
      map.set(key, entry);
    }
  }

  // Fix loop from the log itself: a run of holds on one file followed by a clear is a recovered hold.
  const runs = new Map<string, number>();
  const attempts: number[] = [];
  const hot = new Map<string, { repo: string; file: string; holds: number; lastHeld: string }>();
  for (const item of all) {
    const key = `${item.repo}\u0000${item.file}`;
    if (item.decision === "held") {
      bump(runs, key);
      const spot = hot.get(key) ?? { repo: item.repo, file: item.file, holds: 0, lastHeld: item.ts };
      spot.holds += 1;
      spot.lastHeld = item.ts;
      hot.set(key, spot);
    } else if ((runs.get(key) ?? 0) > 0) {
      attempts.push((runs.get(key) ?? 0) + 1);
      runs.delete(key);
    }
  }

  const sortBy = <T>(items: T[], score: (item: T) => number): T[] => items.sort((a, b) => score(b) - score(a));
  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    repos,
    totals: { decisions: all.length, held, cleared, observed, holdRate: all.length ? held / all.length : 0, medianMs: percentile(ms, 50), p95Ms: percentile(ms, 95) },
    daily: [...daily.entries()].map(([day, value]) => ({ day, ...value })),
    codes: sortBy([...codeStats.entries()].map(([code, stat]) => ({ code, rule: stat.rule, blocks: stat.blocks, observes: stat.observes, warns: stat.warns, files: stat.files.size })), (item) => item.blocks * 2 + item.observes + item.warns).slice(0, 25),
    rollout: sortBy([...rollout.entries()].map(([code, files]) => ({ code, wouldBlock: rolloutCount.get(code) ?? 0, files: [...files].slice(0, 10) })), (item) => item.wouldBlock),
    surfaces: sortBy([...bySurface.entries()].map(([name, value]) => ({ name, ...value })), (item) => item.decisions),
    actors: sortBy([...byActor.entries()].map(([name, value]) => ({ name, ...value })), (item) => item.decisions),
    hotspots: sortBy([...hot.values()], (item) => item.holds).slice(0, 15),
    fixLoop: { recovered: attempts.length, medianAttempts: percentile(attempts, 50), stillHeld: [...runs.values()].filter((value) => value > 0).length, stuckFiles, openFindings, resolvedFindings },
    reportCard: reportCard(roots, { days, now }).rows,
    replays: replays.slice(0, 25),
  };
}
