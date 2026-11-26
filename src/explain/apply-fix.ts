import path from "node:path";

import { applyWriteReviewed, type SpecWriteResult } from "../gate/apply.js";
import { normalizeRelative } from "../paths.js";
import { resolveContract } from "../universal/contract.js";
import { applyExplainedFixes } from "./explain.js";
import { lastHeld } from "./ledger.js";

export interface ApplyFixResult {
  protocol: "ctc.fix.v1";
  file: string;
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  /** The gate decision on the fixed proposal. Nothing is written unless it cleared. */
  result: SpecWriteResult | null;
  message: string;
}

/**
 * Close the loop: take the last held proposal for `file`, apply the suggested patches (all, or `ids`),
 * and send the result through the same gate. The fix only lands if the gate clears it; otherwise the
 * agent gets the next explain report for the remaining findings.
 */
export async function applyFix(rootInput: string, filePath: string, ids?: readonly string[], sessionId?: string): Promise<ApplyFixResult> {
  const root = path.resolve(rootInput);
  const file = normalizeRelative(root, filePath);
  const last = lastHeld(root, file);
  if (!last) return { protocol: "ctc.fix.v1", file, applied: [], skipped: [], result: null, message: `No held proposal is on record for ${file}. Submit the file first.` };
  const fixed = applyExplainedFixes(last.proposal, last.explanations, ids);
  if (fixed.applied.length === 0) return { protocol: "ctc.fix.v1", file, applied: [], skipped: fixed.skipped, result: null, message: "None of the selected findings has a mechanical fix. Fix them by hand and resubmit." };
  const contract = resolveContract(root);
  const result = await applyWriteReviewed(root, { path: file, content: fixed.content, via: "ctc_apply_fix", ...(contract.ok ? { plan: contract.plan } : {}), ...(sessionId ? { sessionId } : {}) });
  return {
    protocol: "ctc.fix.v1",
    file,
    applied: fixed.applied,
    skipped: fixed.skipped,
    result,
    message: result.cleared ? `Applied ${fixed.applied.length} fix(es); the gate cleared the result and wrote ${file}.` : `Applied ${fixed.applied.length} fix(es); ${result.violations.length} finding(s) remain. See result.explain.`,
  };
}
