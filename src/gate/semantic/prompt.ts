import type { FlightPlanContract } from "../../schemas/flightPlan.js";
import type { GateViolation } from "../../schemas/gate.js";
import type { Reference } from "../references.js";

export const SEMANTIC_CATEGORIES = ["unit_change", "boundary_change", "behaviour_change", "scope_creep", "duplicate", "broken_caller", "missing_requirement"] as const;
export type SemanticCategory = (typeof SEMANTIC_CATEGORIES)[number];

export const SYSTEM_PROMPT = `You review ONE proposed file edit from an AI coding agent BEFORE it is written to disk.
Report only defects that are clearly real and that a compiler cannot see:
- unit_change: a value changes unit (cents<->dollars, ms<->seconds) while names/types stay the same
- boundary_change: a comparison or range bound changes (< vs <=, off-by-one) without the task asking for it
- behaviour_change: existing behaviour changes although the task says it must not, or a read gains a side effect
- scope_creep: the edit does something the task did not ask for
- duplicate: new code re-implements a helper that already exists in the shown context
- broken_caller: a shown call site or test now gets different behaviour
- missing_requirement: the task's stated requirement is not met
Do NOT report style, naming, formatting, documentation, performance, or hypothetical issues.
If you are not sure, report nothing. An empty list is the normal answer.
Answer with JSON only: {"findings":[{"line":<line number in the NEW file>,"category":"<one of the categories>","confidence":<0..1>,"evidence":"<exact code copied from that NEW line>","message":"<one sentence>"}]}`;

function numbered(text: string, lines: Set<number>, radius: number, maxLines: number): string {
  const all = text.split("\n");
  const keep = new Set<number>();
  for (const line of lines) for (let k = line - radius; k <= line + radius; k += 1) if (k >= 1 && k <= all.length) keep.add(k);
  if (keep.size === 0) for (let k = 1; k <= Math.min(all.length, maxLines); k += 1) keep.add(k);
  const out: string[] = [];
  let last = 0;
  for (const line of [...keep].sort((a, b) => a - b).slice(0, maxLines)) {
    if (last && line > last + 1) out.push("   ...");
    out.push(`${String(line).padStart(4)}| ${all[line - 1] ?? ""}`);
    last = line;
  }
  return out.join("\n");
}

export interface PromptInput {
  relativePath: string;
  after: string;
  diff: string;
  changedLines: Set<number>;
  plan: FlightPlanContract;
  references: Array<{ name: string; refs: Reference[] }>;
  deterministic: readonly GateViolation[];
}

export function buildUserPrompt(input: PromptInput): string {
  const sections = [
    `TASK (flight plan ${input.plan.taskId}): ${input.plan.objective || "(no objective)"}`,
    ...(input.plan.ticket ? [`TICKET (the diff must implement this, and nothing it rules out):\n${input.plan.ticket.slice(0, 4000)}`] : []),
    `Planned files: ${input.plan.allowedFileGlobs.join(", ")}`,
    input.plan.allowedNewExports ? `New exports the task allows: ${input.plan.allowedNewExports.join(", ") || "none"}` : "",
    input.plan.invariants.length ? `Invariants: ${input.plan.invariants.map((item) => item.text).join(" | ")}` : "",
    `FILE: ${input.relativePath}`,
    `DIFF:\n${input.diff.slice(0, 12_000)}`,
    `NEW FILE around the changes (line numbers are what you report):\n${numbered(input.after, input.changedLines, 25, 400)}`,
  ];
  const refs = input.references.filter((item) => item.refs.length > 0);
  if (refs.length) {
    sections.push(
      `CALL SITES AND TESTS of changed functions:\n${refs
        .map((item) => `${item.name}:\n${item.refs.map((ref) => `  ${ref.file}:${ref.line}${ref.test ? " (test)" : ""}: ${ref.text}`).join("\n")}`)
        .join("\n")}`,
    );
  }
  if (input.deterministic.length) {
    sections.push(`Already reported by deterministic checks (do not repeat):\n${input.deterministic.map((item) => `  line ${item.line ?? "-"}: ${item.code}`).join("\n")}`);
  }
  return sections.filter(Boolean).join("\n\n");
}
