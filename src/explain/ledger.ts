import fs from "node:fs";
import path from "node:path";

import type { Explanation } from "./explain.js";

/**
 * Fix handoff loop (v0.4). The gate remembers, per file, which findings are open, how many times the
 * agent has resubmitted without fixing each, and which ones a later proposal resolved. The result is
 * returned with every gate decision so the agent (or a human) sees progress, and a finding that survives
 * two attempts is escalated with the exact patch to apply. Review bots resolve their own comment thread
 * once a fix lands; here the "thread" closes before the bad bytes ever land.
 */

export const LEDGER_FILE = ".ctc/fix-ledger.json";
const MAX_PROPOSAL_BYTES = 512 * 1024;
const STUCK_AFTER = 2;

interface OpenItem {
  code: string;
  rule: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  attempts: number;
}

interface FileLedger {
  open: Record<string, OpenItem>;
  resolved: Array<{ id: string; code: string; attempts: number; resolvedAt: string; via: "agent" | "ctc_apply_fix" }>;
  lastProposal: string | null;
  lastExplanations: Explanation[];
}

interface LedgerDisk {
  version: 1;
  files: Record<string, FileLedger>;
}

export interface FixLoopStatus {
  attempt: number;
  open: number;
  resolvedThisAttempt: string[];
  stuck: Array<{ id: string; code: string; attempts: number; action: string }>;
  totalResolved: number;
}

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_FILE);
}

export function readLedger(root: string): LedgerDisk {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8")) as LedgerDisk;
    if (raw && raw.version === 1 && raw.files) return raw;
  } catch {
    // missing or unreadable ledger starts empty
  }
  return { version: 1, files: {} };
}

function writeLedger(root: string, ledger: LedgerDisk): void {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/** Record one gate decision for `file`. `explanations` empty = the proposal cleared. */
export function recordAttempt(root: string, file: string, explanations: readonly Explanation[], proposal: string | null, via: "agent" | "ctc_apply_fix" = "agent", now = new Date()): FixLoopStatus {
  const ledger = readLedger(root);
  if (!ledger.files[file] && explanations.length === 0) return { attempt: 0, open: 0, resolvedThisAttempt: [], stuck: [], totalResolved: 0 };
  const entry: FileLedger = ledger.files[file] ?? { open: {}, resolved: [], lastProposal: null, lastExplanations: [] };
  const ts = now.toISOString();
  const seen = new Set(explanations.map((item) => item.id));
  const resolvedThisAttempt: string[] = [];
  for (const [id, item] of Object.entries(entry.open)) {
    if (seen.has(id)) continue;
    resolvedThisAttempt.push(id);
    entry.resolved.push({ id, code: item.code, attempts: item.attempts, resolvedAt: ts, via });
    delete entry.open[id];
  }
  entry.resolved = entry.resolved.slice(-200);
  for (const item of explanations) {
    const existing = entry.open[item.id];
    if (existing) {
      existing.attempts += 1;
      existing.lastSeen = ts;
    } else {
      entry.open[item.id] = { code: item.code, rule: item.rule, message: item.message, firstSeen: ts, lastSeen: ts, attempts: 1 };
    }
  }
  // Never persist a secret: a proposal with a secret finding is not stored, and sensitive hunks are dropped.
  const sensitive = explanations.some((item) => item.fix.sensitive);
  entry.lastExplanations = explanations.map((item) => (item.fix.sensitive ? { ...item, fix: { ...item.fix, hunks: [] } } : item));
  entry.lastProposal = !sensitive && explanations.length > 0 && proposal !== null && Buffer.byteLength(proposal) <= MAX_PROPOSAL_BYTES ? proposal : null;
  ledger.files[file] = entry;
  writeLedger(root, ledger);
  const attempt = Math.max(0, ...Object.values(entry.open).map((item) => item.attempts));
  const stuck = Object.entries(entry.open)
    .filter(([, item]) => item.attempts >= STUCK_AFTER)
    .map(([id, item]) => {
      const explained = explanations.find((candidate) => candidate.id === id);
      const action = explained && explained.fix.hunks.length > 0
        ? `Same finding ${item.attempts} times. Apply the suggested patch verbatim: ctc_apply_fix {"path":"${file}","ids":["${id}"]}.`
        : `Same finding ${item.attempts} times with no mechanical fix. Re-read the rule, re-plan, or ask a human to waive it.`;
      return { id, code: item.code, attempts: item.attempts, action };
    });
  return { attempt, open: Object.keys(entry.open).length, resolvedThisAttempt, stuck, totalResolved: entry.resolved.length };
}

export function lastHeld(root: string, file: string): { proposal: string; explanations: Explanation[] } | null {
  const entry = readLedger(root).files[file];
  if (!entry || entry.lastProposal === null || entry.lastExplanations.length === 0) return null;
  return { proposal: entry.lastProposal, explanations: entry.lastExplanations };
}

export function ledgerSummary(root: string): Array<{ file: string; open: number; resolved: number; stuck: number }> {
  const ledger = readLedger(root);
  return Object.entries(ledger.files).map(([file, entry]) => ({
    file,
    open: Object.keys(entry.open).length,
    resolved: entry.resolved.length,
    stuck: Object.values(entry.open).filter((item) => item.attempts >= STUCK_AFTER).length,
  }));
}
