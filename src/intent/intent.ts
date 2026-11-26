import path from "node:path";

import { minimatch } from "minimatch";

import type { ExtensionInput } from "../gate/extensions.js";
import { changedLines } from "../lang/lines.js";
import type { GateViolation } from "../schemas/gate.js";

/**
 * IntentCheck (v0.4 item 10): does the diff do what the ticket asks, and nothing it rules out?
 *
 * Deterministic, no model:
 *   - INTENT_OUT_OF_SCOPE (blocks): the ticket says "Out of scope / Do not change / Non-goals: X" and the write
 *     touches X — a path, or a code-shaped identifier on a changed line.
 *   - INTENT_UNRELATED (warns; `intent.unrelated: "enforce"` blocks): the changed lines and the path share no term
 *     with the ticket at all.
 *   - ticketCoverage(): per acceptance criterion, which changed files mention its terms (used by `ctc ci`).
 * The optional semantic step (BYOK) receives the ticket text too, for what string matching cannot judge.
 */

export interface ParsedTicket {
  outOfScope: { paths: string[]; identifiers: string[]; source: string[] };
  terms: Set<string>;
  criteria: Array<{ text: string; terms: Set<string> }>;
}

const STOP = new Set(
  "about above after again against also because been before being below between both cannot could does doing down during each every from further have having here into itself just more most must need needs only other over same should some such than that their them then there these they this those through under until very want were what when where which while will with would your make makes made sure able ticket issue task change changes update updated using used user users code file files".split(" "),
);

function stem(word: string): string {
  return word.toLowerCase().replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "");
}

/** Split identifiers and words into comparable stems: parseInvoiceTotal → parse, invoice, total. */
export function termsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    for (const part of raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").split(/\s+/)) {
      if (part.length < 4 || STOP.has(part.toLowerCase())) continue;
      out.add(stem(part));
    }
  }
  return out;
}

const CODE_SHAPED = /^(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z0-9]+_[a-z0-9_]+|[A-Z][A-Z0-9_]{3,})$/;
const OUT_HEAD = /^\s*(?:#+\s*)?(?:out[- ]of[- ]scope|non[- ]goals?|not in scope|do not (?:change|touch|modify|edit)|don'?t (?:change|touch|modify|edit)|must not (?:change|touch|modify)|leave (?:\S+\s+)?(?:alone|untouched|as is))\b\s*:?/i;

export function parseTicket(text: string): ParsedTicket {
  const lines = text.split("\n");
  const outLines: string[] = [];
  const keepLines: string[] = [];
  let inOut = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (OUT_HEAD.test(trimmed)) {
      outLines.push(trimmed);
      inOut = /:\s*$/.test(trimmed) || /^#+/.test(trimmed) || trimmed.replace(OUT_HEAD, "").trim() === "";
      continue;
    }
    if (inOut && /^([-*+]|\d+\.)\s+/.test(trimmed)) {
      outLines.push(trimmed);
      continue;
    }
    if (inOut && trimmed === "") continue;
    inOut = false;
    // Inline "do not touch X" inside a sentence.
    const inline = trimmed.match(/\b(?:do not|don'?t|must not|never)\s+(?:change|touch|modify|edit)\s+(.+)$/i);
    if (inline?.[1]) outLines.push(inline[1]);
    keepLines.push(line);
  }
  const paths = new Set<string>();
  const identifiers = new Set<string>();
  for (const line of outLines) {
    const body = line.replace(OUT_HEAD, "");
    const ticks = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    const words = body.replace(/`[^`]*`/g, " ").split(/[\s,;()]+/);
    for (const token of [...ticks, ...words]) {
      const clean = token.replace(/^[^\w./*-]+|[^\w/*]+$/g, "");
      if (!clean) continue;
      if (clean.includes("/") || /\.\w{1,5}$/.test(clean)) paths.add(clean.replace(/^\.\//, ""));
      else if (ticks.includes(token) || CODE_SHAPED.test(clean)) identifiers.add(clean.replace(/\(\)$/, ""));
    }
  }
  const criteria: ParsedTicket["criteria"] = [];
  for (const line of keepLines) {
    const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.{6,})$/);
    if (match?.[1]) criteria.push({ text: match[1].trim(), terms: termsOf(match[1]) });
  }
  return { outOfScope: { paths: [...paths], identifiers: [...identifiers], source: outLines }, terms: termsOf(keepLines.join("\n")), criteria };
}

function pathMatches(relativePath: string, spec: string): boolean {
  if (/[*?]/.test(spec)) return minimatch(relativePath, spec, { dot: true }) || minimatch(relativePath, `**/${spec}`, { dot: true });
  const clean = spec.replace(/\/+$/, "");
  return relativePath === clean || relativePath.startsWith(`${clean}/`) || relativePath.endsWith(`/${clean}`) || path.posix.basename(relativePath) === clean;
}

export function ticketText(input: Pick<ExtensionInput, "plan">): string {
  return (input.plan?.ticket ?? "").trim() || (input.plan?.objective ?? "").trim();
}

export function intentViolations(input: ExtensionInput): GateViolation[] {
  const text = ticketText(input);
  if (!text || input.before === input.after) return [];
  const ticket = parseTicket(text);
  const out: GateViolation[] = [];
  const changed = changedLines(input.relativePath, input.before, input.after);
  const hit = ticket.outOfScope.paths.find((spec) => pathMatches(input.relativePath, spec));
  if (hit) {
    out.push({ rule: "IntentCheck", code: "INTENT_OUT_OF_SCOPE", file: input.relativePath, line: changed[0]?.line ?? null, column: null, message: `The ticket puts '${hit}' out of scope, and this write changes ${input.relativePath}.`, fix: "Leave this file alone for this ticket, or get the ticket's scope changed first." });
  }
  for (const id of ticket.outOfScope.identifiers) {
    const re = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const line = changed.find((item) => re.test(item.code));
    if (!line) continue;
    out.push({ rule: "IntentCheck", code: "INTENT_OUT_OF_SCOPE", file: input.relativePath, line: line.line, column: null, message: `The ticket rules out changes to '${id}', and this line changes code that uses it.`, fix: `Revert the change that touches '${id}', or get the ticket's scope changed first.` });
  }
  const mode = input.policy.intentUnrelated;
  if (mode !== "off" && ticket.terms.size >= 3 && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|\.ctc\/)/.test(input.relativePath)) {
    const mine = termsOf(`${input.relativePath.replace(/[/._-]/g, " ")} ${changed.map((item) => item.text).join("\n")}`);
    const shared = [...mine].some((term) => ticket.terms.has(term));
    if (!shared && changed.length > 0) {
      out.push({
        rule: "IntentCheck",
        code: "INTENT_UNRELATED",
        file: input.relativePath,
        line: changed[0]?.line ?? null,
        column: null,
        message: `Nothing in this change (path or changed lines) relates to the ticket ("${text.split("\n")[0]?.slice(0, 80)}").`,
        fix: "Keep the change to what the ticket asks, or update the ticket / plan objective if this is needed for it.",
        ...(mode === "enforce" ? {} : { severity: "warn" as const }),
      });
    }
  }
  return out;
}

export interface CriterionCoverage {
  criterion: string;
  covered: boolean;
  files: string[];
}

/** Which acceptance criteria the change set touches (term overlap ≥ 2, or ≥ 1 for one-term criteria). */
export function ticketCoverage(ticketTextValue: string, changes: ReadonlyArray<{ file: string; before: string | null; after: string }>): CriterionCoverage[] {
  const ticket = parseTicket(ticketTextValue);
  const perFile = changes.map((change) => ({ file: change.file, terms: termsOf(`${change.file.replace(/[/._-]/g, " ")} ${changedLines(change.file, change.before, change.after).map((item) => item.text).join("\n")}`) }));
  return ticket.criteria.map((criterion) => {
    const need = Math.min(2, criterion.terms.size);
    const files = need === 0 ? [] : perFile.filter((entry) => [...criterion.terms].filter((term) => entry.terms.has(term)).length >= need).map((entry) => entry.file);
    return { criterion: criterion.text, covered: files.length > 0, files };
  });
}
