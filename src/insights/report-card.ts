import { agentLabel } from "../telemetry/client.js";
import { median, pct, windowRecords } from "./records.js";

/**
 * Agent report card (v0.5): how each agent and model fares against the gate, from the local findings log.
 * Agent = MCP clientInfo name, else CTC_AGENT, else the CTC_ACTOR identity; model = CTC_MODEL when set.
 * Decisions recorded before v0.5 carry no client, so they group under their actor or "unknown (<surface>)".
 */

export const REPORT_CARD_PROTOCOL = "ctc.report-card.v1";

export interface ReportCardRow {
  agent: string;
  model: string | null;
  versions: string[];
  decisions: number;
  held: number;
  cleared: number;
  observed: number;
  holdRate: number;
  topRules: Array<{ code: string; rule: string; holds: number }>;
  /** Median attempts (held writes + the clearing one) before a held file cleared. Null with no recovered holds. */
  medianAttemptsToClear: number | null;
  recovered: number;
  stillHeld: number;
}

export interface ReportCard {
  protocol: typeof REPORT_CARD_PROTOCOL;
  generatedAt: string;
  windowDays: number;
  decisions: number;
  rows: ReportCardRow[];
}

export function reportCard(roots: readonly string[], options: { days?: number; now?: Date } = {}): ReportCard {
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  const records = windowRecords(roots, { days, now });
  const groups = new Map<string, { agent: string; model: string | null; versions: Set<string>; records: typeof records }>();
  for (const record of records) {
    const agent = agentLabel(record);
    const model = record.model ?? null;
    const key = `${agent}\u0000${model ?? ""}`;
    const group = groups.get(key) ?? { agent, model, versions: new Set<string>(), records: [] };
    if (record.client?.version) group.versions.add(record.client.version);
    group.records.push(record);
    groups.set(key, group);
  }
  const rows: ReportCardRow[] = [];
  for (const group of groups.values()) {
    const held = group.records.filter((item) => item.decision === "held").length;
    const cleared = group.records.filter((item) => item.decision === "cleared").length;
    const observed = group.records.filter((item) => item.decision === "observed").length;
    const codes = new Map<string, { rule: string; holds: number }>();
    for (const record of group.records) {
      if (record.decision !== "held") continue;
      for (const finding of record.findings) {
        if (finding.severity !== "block") continue;
        const entry = codes.get(finding.code) ?? { rule: finding.rule, holds: 0 };
        entry.holds += 1;
        codes.set(finding.code, entry);
      }
    }
    const runs = new Map<string, number>();
    const attempts: number[] = [];
    for (const record of group.records) {
      const key = `${record.repo}\u0000${record.file}`;
      if (record.decision === "held") runs.set(key, (runs.get(key) ?? 0) + 1);
      else if ((runs.get(key) ?? 0) > 0) {
        attempts.push((runs.get(key) ?? 0) + 1);
        runs.delete(key);
      }
    }
    rows.push({
      agent: group.agent,
      model: group.model,
      versions: [...group.versions].sort(),
      decisions: group.records.length,
      held,
      cleared,
      observed,
      holdRate: group.records.length ? held / group.records.length : 0,
      topRules: [...codes.entries()].map(([code, value]) => ({ code, ...value })).sort((a, b) => b.holds - a.holds || a.code.localeCompare(b.code)).slice(0, 5),
      medianAttemptsToClear: median(attempts),
      recovered: attempts.length,
      stillHeld: runs.size,
    });
  }
  rows.sort((a, b) => b.decisions - a.decisions || a.agent.localeCompare(b.agent));
  return { protocol: REPORT_CARD_PROTOCOL, generatedAt: now.toISOString(), windowDays: days, decisions: records.length, rows };
}

export function renderReportCardText(card: ReportCard): string {
  if (card.rows.length === 0) return `No gate decisions in the last ${card.windowDays} days (.ctc/findings.jsonl is empty or missing).\n`;
  const lines = [`Agent report card — last ${card.windowDays} days, ${card.decisions} decisions`, ""];
  for (const row of card.rows) {
    lines.push(`${row.agent}${row.versions.length ? ` ${row.versions.join(", ")}` : ""}${row.model ? ` · model ${row.model}` : ""}`);
    lines.push(`  decisions ${row.decisions}  held ${row.held}  cleared ${row.cleared}  observed ${row.observed}  hold rate ${pct(row.holdRate)}`);
    lines.push(`  median attempts to clear: ${row.medianAttemptsToClear ?? "n/a"} (${row.recovered} recovered, ${row.stillHeld} still held)`);
    lines.push(`  top rules: ${row.topRules.length ? row.topRules.map((item) => `${item.code} ×${item.holds}`).join(", ") : "none"}`);
    lines.push("");
  }
  lines.push("Agent comes from the MCP client's clientInfo, CTC_AGENT or CTC_ACTOR; model only from CTC_MODEL.");
  return `${lines.join("\n")}\n`;
}
