import { z } from "zod";

import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { SEMANTIC_CATEGORIES } from "./prompt.js";

/**
 * Deterministic filter between the model and the gate. A model finding becomes a violation only if it
 * survives every check below; everything else is dropped with a recorded reason. This is what keeps the
 * semantic step's false positives near zero: the model can only narrow down, never invent, a location.
 */
const RawFinding = z.object({
  line: z.coerce.number().int(),
  category: z.string(),
  confidence: z.coerce.number().min(0).max(1).default(0),
  evidence: z.string().default(""),
  message: z.string().default(""),
});
export type RawFinding = z.infer<typeof RawFinding>;

const SPECULATIVE = /\b(might|may|could|consider|perhaps|possibly|potentially|style|naming|readab|nit|prefer|cleaner|for clarity|documentation|comment)\b/i;
const LINE_SLACK = 2;

export interface FilterOptions {
  relativePath: string;
  after: string;
  changedLines: Set<number>;
  deterministic: readonly GateViolation[];
  minConfidence: number;
  maxFindings: number;
}

export interface FilterResult {
  kept: GateViolation[];
  dropped: Array<{ reason: string; finding: unknown }>;
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Pull the JSON object out of the reply (models sometimes wrap it in a code fence). */
export function parseReply(reply: string): { findings: unknown[] } | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const findings = (parsed as { findings?: unknown }).findings;
    return { findings: Array.isArray(findings) ? findings : [] };
  } catch {
    return null;
  }
}

export function filterFindings(raw: readonly unknown[], options: FilterOptions): FilterResult {
  const lines = options.after.split("\n");
  const kept: GateViolation[] = [];
  const dropped: FilterResult["dropped"] = [];
  const near = (line: number): boolean => {
    for (let k = line - LINE_SLACK; k <= line + LINE_SLACK; k += 1) if (options.changedLines.has(k)) return true;
    return false;
  };
  for (const item of raw) {
    const parsed = RawFinding.safeParse(item);
    if (!parsed.success) {
      dropped.push({ reason: "malformed finding", finding: item });
      continue;
    }
    const finding = parsed.data;
    const drop = (reason: string): void => {
      dropped.push({ reason, finding });
    };
    if (!(SEMANTIC_CATEGORIES as readonly string[]).includes(finding.category)) {
      drop(`category '${finding.category}' is not reportable`);
      continue;
    }
    if (finding.confidence < options.minConfidence) {
      drop(`confidence ${finding.confidence} below ${options.minConfidence}`);
      continue;
    }
    if (finding.line < 1 || finding.line > lines.length) {
      drop("line is outside the file");
      continue;
    }
    if (!near(finding.line)) {
      drop("line is not part of this edit");
      continue;
    }
    const evidence = squash(finding.evidence);
    if (evidence.length < 3) {
      drop("no code evidence");
      continue;
    }
    const window = squash(lines.slice(Math.max(0, finding.line - 1 - LINE_SLACK), finding.line + LINE_SLACK).join("\n"));
    if (!window.includes(evidence)) {
      drop("evidence is not on the reported line");
      continue;
    }
    if (!finding.message.trim() || SPECULATIVE.test(finding.message)) {
      drop("speculative or style-only message");
      continue;
    }
    if (options.deterministic.some((item) => item.line !== null && Math.abs(item.line - finding.line) <= LINE_SLACK)) {
      drop("already reported by a deterministic rule");
      continue;
    }
    if (kept.some((item) => item.line === finding.line)) {
      drop("duplicate line");
      continue;
    }
    if (kept.length >= options.maxFindings) {
      drop("over the per-file limit");
      continue;
    }
    kept.push(
      gateViolation({
        rule: "SemanticReview",
        code: `SEMANTIC_${finding.category.toUpperCase()}`,
        file: options.relativePath,
        line: finding.line,
        column: 1,
        message: `${finding.message.trim()} (model review, confidence ${finding.confidence.toFixed(2)}; evidence: ${finding.evidence.trim().slice(0, 120)})`,
        fix: "Fix the change, or if it is intended, say so in the flight plan objective.",
      }),
    );
  }
  return { kept, dropped };
}
