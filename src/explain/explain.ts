import crypto from "node:crypto";

import type { PatchHunk } from "../engine/patch.js";
import { simulateSource } from "../engine/simulate.js";
import { diffLines, unifiedDiff, type Hunk } from "../gate/diff.js";
import type { GateViolation } from "../schemas/gate.js";

/**
 * Explain-the-block (v0.4). Every held write carries a machine-readable explanation per finding:
 * the rule, the exact lines, why the rule exists, and — where the gate can compute one — a fix the
 * agent can apply verbatim (literal search/replace hunks against its own proposal, plus the same fix
 * as a unified diff). Competitor "fix with agent" buttons hand a comment to a model and hope; here the
 * suggested patch is itself re-checked by the gate before anything lands (see ctc_apply_fix).
 */

export const EXPLAIN_PROTOCOL = "ctc.explain.v1";

export type FixKind = "revert-hunk" | "remove-lines" | "replace-literal" | "manual";
export type FixConfidence = "exact" | "suggested" | "none";

export interface FixSuggestion {
  /** True when the hunks contain a secret: never shown in comments, logs or the ledger. */
  sensitive?: boolean;
  kind: FixKind;
  confidence: FixConfidence;
  summary: string;
  /** Literal hunks against the proposed content (ctc_patch_file / ctc_apply_fix format). Empty for manual fixes. */
  hunks: PatchHunk[];
  /** The same change as a unified diff of proposal → fixed proposal, or null. */
  patch: string | null;
}

export interface Explanation {
  id: string;
  rule: string;
  code: string;
  file: string;
  severity: "block" | "warn" | "observe";
  lines: { start: number; end: number } | null;
  /** The offending lines, numbered, from the proposal. */
  snippet: string[];
  message: string;
  why: string;
  fix: FixSuggestion;
}

export interface ExplainReport {
  protocol: typeof EXPLAIN_PROTOCOL;
  file: string;
  explanations: Explanation[];
  /** One instruction a model can follow without parsing prose. */
  nextAction: string;
}

const RATIONALE: Array<[RegExp, string]> = [
  [/^PHANTOM|^TS\d+/, "The proposal calls or imports something that does not exist in this project. Code like this fails to compile or crashes at runtime; AI agents produce it when they guess an API."],
  [/^DUPLICATE_LOGIC/, "An equivalent helper already exists. A second copy drifts from the first and doubles the places a bug has to be fixed."],
  [/^DEAD_CODE|^UNUSED/, "The edit adds code nothing uses. Dead code hides intent, rots, and is usually a sign the task was half-finished."],
  [/^FUNCTION_TOO_LONG|^COMPLEXITY/, "The edit makes a function longer or more complex than the project allows. Long, branchy functions are where defects concentrate."],
  [/^NAMING_DRIFT/, "The new name does not follow the project's naming convention, so the codebase stops reading consistently."],
  [/^BOUNDARY_VIOLATION|^BANNED_PACKAGE|^BANNED_IMPORT/, "The import crosses an architecture boundary or uses a dependency the project's policy forbids."],
  [/^BREAKING_CHANGE/, "An exported API changed shape and existing callers no longer type-check. Breaking changes need to be planned and the callers updated in the same change."],
  [/^EXPORT_NOT_IN_PLAN/, "The edit adds a public export the plan did not ask for. Every export is API surface someone has to support."],
  [/^EDIT_OUTSIDE_PLAN_SCOPE|^OUTSIDE_FLIGHT_PLAN/, "The edit changes code outside what the task is about. Drive-by changes alter behaviour nobody reviewed or asked for."],
  [/^UNIT_|^BOUNDARY_FLIP/, "The edit changes a unit (cents/dollars, ms/s) or a boundary (< vs <=) that callers depend on. These are silent off-by-one and off-by-100 bugs."],
  [/^SECRET/, "A credential appears in source. Once written it is in the working tree, editor history and usually git; it has to be treated as leaked and rotated."],
  [/^SAST_/, "The pattern is a known source of security vulnerabilities (injection, unsafe evaluation, weak crypto, disabled TLS checks)."],
  [/^VULNERABLE_DEPENDENCY|^SCA_/, "The dependency version has a published security advisory."],
  [/^POLICY_/, "The project's own written rules (AGENTS.md, Cursor rules, CLAUDE.md, Copilot instructions) forbid this, and CTC enforces them."],
  [/^WIREFRAME_/, "The UI no longer matches the wireframe the agent agreed to before writing UI code."],
  [/^CROSS_REPO/, "A sibling repository that consumes this package would break."],
  [/^INTENT_/, "The diff does not match the ticket or plan objective it is supposed to implement."],
  [/^CANARY|^INVARIANT/, "A project invariant or canary the plan declared would be violated."],
];

function rationale(code: string): string {
  for (const [pattern, text] of RATIONALE) if (pattern.test(code)) return text;
  return "The project's gate policy holds this change.";
}

export function explanationId(item: Pick<GateViolation, "rule" | "code" | "file" | "message">): string {
  return crypto.createHash("sha1").update(`${item.rule}|${item.code}|${item.file}|${item.message.replace(/:\d+/g, ":#")}`).digest("hex").slice(0, 12);
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Start/end lines of the top-level statement or class member that contains `line`. */
function enclosingRange(file: string, content: string, line: number): { start: number; end: number } | null {
  const source = simulateSource(file, content);
  if (!source) return null;
  let best: { start: number; end: number } | null = null;
  source.forEachDescendant((node, traversal) => {
    const start = node.getStartLineNumber();
    const end = node.getEndLineNumber();
    if (line < start || line > end) {
      traversal.skip();
      return;
    }
    const kind = node.getKindName();
    if (/Declaration$|VariableStatement|ImportDeclaration|ExportAssignment/.test(kind) && kind !== "VariableDeclaration" && kind !== "ParameterDeclaration") {
      if (!best || end - start <= best.end - best.start) best = { start, end };
    }
  });
  return best;
}

function hunksIn(hunks: readonly Hunk[], range: { start: number; end: number }): Hunk[] {
  return hunks.filter((hunk) => {
    if (hunk.added.length === 0) return hunk.newStart >= range.start && hunk.newStart <= range.end + 1;
    return hunk.added.some((item) => item.line >= range.start && item.line <= range.end);
  });
}

/** Literal hunks that undo the given diff hunks in `after`, with enough context to be unique. */
function revertHunks(after: string, hunks: readonly Hunk[]): PatchHunk[] {
  const lines = splitLines(after);
  const out: PatchHunk[] = [];
  for (const hunk of hunks) {
    const first = hunk.added[0]?.line ?? hunk.newStart;
    const last = hunk.added.length > 0 ? (hunk.added[hunk.added.length - 1]?.line ?? first) : first - 1;
    for (let context = 0; context <= 3; context += 1) {
      const from = Math.max(1, first - context);
      const to = Math.min(lines.length, last + context);
      const lead = lines.slice(from - 1, first - 1);
      const trail = lines.slice(last, to);
      const search = [...lead, ...hunk.added.map((item) => item.text), ...trail].join("\n");
      const replace = [...lead, ...hunk.removed.map((item) => item.text), ...trail].join("\n");
      if (search === "") continue;
      if (after.indexOf(search) === after.lastIndexOf(search)) {
        out.push({ search, replace });
        break;
      }
    }
  }
  return out;
}

function applyHunks(content: string, hunks: readonly PatchHunk[]): string | null {
  let next = content;
  for (const hunk of hunks) {
    const at = next.indexOf(hunk.search);
    if (at < 0 || next.indexOf(hunk.search, at + hunk.search.length) >= 0) return null;
    next = next.slice(0, at) + hunk.replace + next.slice(at + hunk.search.length);
  }
  return next;
}

function withPatch(file: string, after: string, base: Omit<FixSuggestion, "patch">): FixSuggestion {
  if (base.hunks.length === 0) return { ...base, patch: null };
  const fixed = applyHunks(after, base.hunks);
  if (fixed === null) return { ...base, hunks: [], confidence: "none", kind: "manual", patch: null };
  return { ...base, patch: unifiedDiff(file, after, fixed, 1) || null };
}

const DIFF_AWARE = /^(EDIT_OUTSIDE_PLAN_SCOPE|BOUNDARY_FLIP|UNIT_CHANGE|UNIT_MISMATCH|BREAKING_CHANGE|NAMING_DRIFT|POLICY_|SAST_|INTENT_)/;

function suggestFix(item: GateViolation, file: string, before: string | null, after: string): FixSuggestion {
  const lines = splitLines(after);
  const line = item.line ?? null;
  // 1. Literal replacements the rule already knows (banned import → allowed module, secret → env var).
  if (line !== null && /^(BANNED_IMPORT|BOUNDARY_VIOLATION|BANNED_PACKAGE)/.test(item.code)) {
    const text = lines[line - 1] ?? "";
    const moduleMatch = item.fix.match(/(?:use|Use|import from|Import from)\s+['"`]?([@\w./-]+)['"`]?/);
    const spec = text.match(/from\s+(['"])([^'"]+)\1|require\((['"])([^'"]+)\3\)/);
    const current = spec?.[2] ?? spec?.[4];
    if (moduleMatch?.[1] && current && moduleMatch[1] !== current) {
      return withPatch(file, after, {
        kind: "replace-literal",
        confidence: "suggested",
        summary: `Import from '${moduleMatch[1]}' instead of '${current}'.`,
        hunks: [{ search: text, replace: text.replace(current, moduleMatch[1]) }],
      });
    }
  }
  if (line !== null && /^SECRET/.test(item.code)) {
    const text = lines[line - 1] ?? "";
    const literal = text.match(/(['"`])([^'"`]{8,})\1/);
    const envName = (item.fix.match(/process\.env\.([A-Z0-9_]+)/)?.[1]) ?? "CTC_SECRET";
    if (literal?.[0]) {
      return withPatch(file, after, {
        kind: "replace-literal",
        confidence: "suggested",
        summary: `Read the credential from process.env.${envName} and rotate the leaked value.`,
        hunks: [{ search: text, replace: text.replace(literal[0], `process.env.${envName} ?? ""`) }],
      });
    }
  }
  // 2. Remove code nothing uses.
  if (line !== null && /^(DEAD_CODE_REGRESSION|UNUSED_IMPORT|UNUSED_PRIVATE)/.test(item.code)) {
    const range = enclosingRange(file, after, line);
    if (range) {
      const search = lines.slice(range.start - 1, range.end).join("\n") + "\n";
      return withPatch(file, after, { kind: "remove-lines", confidence: "exact", summary: `Delete lines ${range.start}-${range.end}, which nothing uses.`, hunks: [{ search, replace: "" }] });
    }
  }
  // 3. Diff-aware findings: undo the hunk(s) of this edit that introduced the finding.
  if (before !== null && line !== null && DIFF_AWARE.test(item.code)) {
    const range = enclosingRange(file, after, line) ?? { start: line, end: line };
    const { hunks } = diffLines(before, after);
    const relevant = hunksIn(hunks, range);
    const literal = revertHunks(after, relevant);
    if (literal.length > 0 && literal.length === relevant.length) {
      return withPatch(file, after, {
        kind: "revert-hunk",
        confidence: /^(EDIT_OUTSIDE_PLAN_SCOPE|BOUNDARY_FLIP|UNIT_)/.test(item.code) ? "exact" : "suggested",
        summary: `Restore lines ${range.start}-${range.end} to their pre-edit text. ${item.fix}`,
        hunks: literal,
      });
    }
  }
  return { kind: "manual", confidence: "none", summary: item.fix, hunks: [], patch: null };
}

function snippetFor(lines: readonly string[], range: { start: number; end: number } | null): string[] {
  if (!range) return [];
  const out: string[] = [];
  const end = Math.min(range.end, range.start + 11);
  for (let line = range.start; line <= end; line += 1) out.push(`${String(line).padStart(4)} | ${lines[line - 1] ?? ""}`);
  if (end < range.end) out.push(`     | … ${range.end - end} more line(s)`);
  return out;
}

export function redactLine(text: string): string {
  return text.replace(/(['"`])[^'"`]{8,}\1/g, "$1«redacted»$1").replace(/[A-Za-z0-9_+/=-]{20,}/g, "«redacted»");
}

export function explainViolations(
  file: string,
  before: string | null,
  after: string,
  violations: readonly GateViolation[],
): ExplainReport {
  const lines = splitLines(after);
  const explanations: Explanation[] = violations.map((item): Explanation => {
    const line = item.line && item.line > 0 && item.line <= Math.max(1, lines.length) ? item.line : null;
    const range = line === null ? null : ((/^(DUPLICATE|DEAD|FUNCTION_TOO_LONG|COMPLEXITY|EDIT_OUTSIDE)/.test(item.code) ? enclosingRange(item.file || file, after, line) : null) ?? { start: line, end: line });
    const severity = item.severity === "warn" ? "warn" : item.severity === "observe" ? "observe" : "block";
    return {
      id: explanationId(item),
      rule: item.rule,
      code: item.code,
      file: item.file || file,
      severity,
      lines: range,
      snippet: (item.file || file) === file ? snippetFor(lines, range) : [],
      message: item.message,
      why: rationale(item.code),
      fix: (item.file || file) === file ? suggestFix(item, file, before, after) : { kind: "manual", confidence: "none", summary: item.fix, hunks: [], patch: null },
    };
  }).map((item): Explanation => (item.rule === "SecretScan" ? { ...item, snippet: item.snippet.map(redactLine), fix: { ...item.fix, patch: null, sensitive: true } } : item));
  const applicable = explanations.filter((item) => item.fix.hunks.length > 0);
  const nextAction =
    explanations.length === 0
      ? "Nothing to fix."
      : applicable.length === explanations.length
        ? `Call ctc_apply_fix with path "${file}" to apply all ${applicable.length} suggested fix(es); the gate re-checks the result before writing.`
        : applicable.length > 0
          ? `Call ctc_apply_fix with path "${file}" and ids ${JSON.stringify(applicable.map((item) => item.id))} for the mechanical fixes, then fix the rest by hand and resubmit the full file.`
          : `Fix each finding by hand (see fix.summary) and resubmit the full file to the same tool.`;
  return { protocol: EXPLAIN_PROTOCOL, file, explanations, nextAction };
}

export function applyExplainedFixes(content: string, explanations: readonly Explanation[], ids?: readonly string[]): { content: string; applied: string[]; skipped: Array<{ id: string; reason: string }> } {
  let next = content;
  const applied: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const item of explanations) {
    if (ids && ids.length > 0 && !ids.includes(item.id)) continue;
    if (item.fix.hunks.length === 0) {
      skipped.push({ id: item.id, reason: "no mechanical fix" });
      continue;
    }
    const fixed = applyHunks(next, item.fix.hunks);
    if (fixed === null) {
      skipped.push({ id: item.id, reason: "fix no longer applies (overlaps an earlier fix)" });
      continue;
    }
    next = fixed;
    applied.push(item.id);
  }
  return { content: next, applied, skipped };
}
