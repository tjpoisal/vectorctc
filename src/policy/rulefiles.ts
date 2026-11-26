import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";

import { toPosix } from "../paths.js";

/**
 * Import the rule files teams already keep for their agents — AGENTS.md (nested, like Codex), CLAUDE.md,
 * .cursor/rules/*.mdc (+ legacy .cursorrules), .github/copilot-instructions.md and
 * .github/instructions/*.instructions.md — and compile the lines that state a checkable rule into
 * deterministic checks. Other tools paste these files into a model prompt and hope; CTC enforces the
 * checkable subset on every write, cites the exact file:line in the hold, and reports which lines it could
 * not compile (`ctc rules import`), so "the agent ignored AGENTS.md" stops being a thing.
 */

export type CompiledKind = "banned-import" | "forbidden-code" | "locked-path" | "max-function-lines" | "require-jsdoc-exports";

export interface CompiledRule {
  id: string;
  kind: CompiledKind;
  /** Source file and line, e.g. AGENTS.md:12 */
  source: string;
  text: string;
  /** Globs (repo-relative) the rule applies to. */
  scope: string[];
  /** banned-import: module; forbidden-code: literal token; locked-path: glob; max-function-lines: number as text. */
  target: string;
  useInstead?: string;
}

export interface RuleFileReport {
  files: string[];
  compiled: CompiledRule[];
  advisory: Array<{ source: string; text: string }>;
  coverage: { ruleLines: number; compiled: number };
}

const MAX_FILE_BYTES = 256 * 1024;

function read(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Nested AGENTS.md / CLAUDE.md up to depth 4, skipping vendored and generated trees. */
function nestedRuleFiles(root: string, dir = "", depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  for (const name of listDir(path.join(root, dir))) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "build" || name === "vendor" || name === ".ctc") continue;
    const relative = dir ? `${dir}/${name}` : name;
    if (name === "AGENTS.md" || name === "CLAUDE.md" || name === "AGENTS.override.md") out.push(relative);
    else if (!name.startsWith(".") && depth < 4) {
      try {
        if (fs.statSync(path.join(root, relative)).isDirectory()) nestedRuleFiles(root, relative, depth + 1, out);
      } catch {
        // unreadable entry
      }
    }
  }
  return out;
}

interface RuleSource {
  file: string;
  scope: string[];
  body: string;
  bodyOffset: number;
}

function frontmatter(text: string): { meta: Record<string, string>; body: string; offset: number } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: text, offset: 0 };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv?.[1]) meta[kv[1]] = (kv[2] ?? "").trim();
  }
  return { meta, body: text.slice(match[0].length), offset: (match[0].match(/\n/g) ?? []).length };
}

function globsFrom(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return items.length ? items : null;
}

const walkCache = new Map<string, { at: number; files: string[] }>();
const WALK_TTL_MS = 5_000;

function nestedCached(root: string): string[] {
  const hit = walkCache.get(root);
  if (hit && Date.now() - hit.at < WALK_TTL_MS) return hit.files;
  const files = nestedRuleFiles(root);
  walkCache.set(root, { at: Date.now(), files });
  return files;
}

export function discoverRuleSources(root: string): RuleSource[] {
  const out: RuleSource[] = [];
  for (const relative of nestedCached(root)) {
    const text = read(path.join(root, relative));
    if (text === null) continue;
    const dir = path.posix.dirname(relative);
    out.push({ file: relative, scope: [dir === "." ? "**" : `${dir}/**`], body: text, bodyOffset: 0 });
  }
  const legacy = read(path.join(root, ".cursorrules"));
  if (legacy !== null) out.push({ file: ".cursorrules", scope: ["**"], body: legacy, bodyOffset: 0 });
  for (const name of listDir(path.join(root, ".cursor", "rules")).sort()) {
    if (!/\.(mdc|md)$/.test(name)) continue;
    const text = read(path.join(root, ".cursor", "rules", name));
    if (text === null) continue;
    const { meta, body, offset } = frontmatter(text);
    // alwaysApply rules and rules with globs are enforced; "agent requested" rules without globs are advisory-only context.
    const globs = globsFrom(meta.globs);
    if (!globs && meta.alwaysApply !== "true") continue;
    out.push({ file: `.cursor/rules/${name}`, scope: globs ?? ["**"], body, bodyOffset: offset });
  }
  const copilot = read(path.join(root, ".github", "copilot-instructions.md"));
  if (copilot !== null) out.push({ file: ".github/copilot-instructions.md", scope: ["**"], body: copilot, bodyOffset: 0 });
  for (const name of listDir(path.join(root, ".github", "instructions")).sort()) {
    if (!name.endsWith(".instructions.md")) continue;
    const text = read(path.join(root, ".github", "instructions", name));
    if (text === null) continue;
    const { meta, body, offset } = frontmatter(text);
    out.push({ file: `.github/instructions/${name}`, scope: globsFrom(meta.applyTo) ?? ["**"], body, bodyOffset: offset });
  }
  return out;
}

const NEGATIVE = /\b(do not|don't|dont|never|must not|mustn't|should not|shouldn't|no longer|avoid|forbid(?:den)?|disallow(?:ed)?|ban(?:ned)?|not allowed)\b|^\s*(?:[-*]\s*)?no\s/i;
const IMPORT_WORD = /\b(import|imports|importing|require|depend on|dependency|package|library|lib|module|use|using)\b/i;
/** "use" alone is not enough to read a span as a module ("never use `console.log`" is code, not a package). */
const STRICT_IMPORT_WORD = /\b(import|imports|importing|require|depend on|dependency|dependencies|package|packages|library|libraries|module|modules)\b/i;
const EDIT_WORD = /\b(edit|modify|change|touch|write to|overwrite|update)\b/i;

function codeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

function looksLikeModule(token: string): boolean {
  return /^(@[\w.-]+\/)?[\w.-]+(\/[\w.-]+)*$/.test(token) && !/^\w+\(\)$/.test(token) && !token.includes(" ") && !/^[A-Z_]+$/.test(token) && !/\.(ts|tsx|js|py|go|md|json)$/.test(token);
}

function looksLikePath(token: string): boolean {
  return /[/*]/.test(token) || /\.(ts|tsx|js|jsx|py|go|json|ya?ml|lock|md|sql)$/.test(token);
}

const STOPWORDS = new Set(["runtime", "dependencies", "dependency", "new", "any", "the", "a", "an", "more", "extra", "external", "third-party", "unnecessary", "other", "copies", "code", "comments", "files", "packages", "libraries", "it", "them", "this", "that", "global", "globals", "state", "from"]);

/** Subject of a sentence like "Routes must never import from `src/db`" → files under a routes directory. */
function subjectScope(clause: string, fallback: string[]): string[] {
  const subject = clause.match(/^\s*(?:files in\s+)?`?([A-Za-z][\w/-]*)`?\s+(?:files\s+)?(?:must|should|may|can|do|does)\b/i)?.[1];
  if (!subject || /^(you|we|agents?|code|it|never|always|do|don't|files)$/i.test(subject)) return fallback;
  const dir = subject.toLowerCase().replace(/\/+$/, "");
  return [`**/${dir}/**`, `${dir}/**`];
}

function clausesOf(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|;\s*/).map((item) => item.trim()).filter(Boolean);
}

/** Explicit directives for precise rules: `ctc: ban-import axios`, `ctc: forbid-code console.log`, `ctc: lock-path db/migrations/**`. */
function directive(text: string, source: string, scope: string[]): CompiledRule[] | null {
  const match = text.match(/\bctc:\s*(ban-import|forbid-code|lock-path|max-function-lines)\s+(.+?)(?:\s+instead\s+(.+?))?\s*(?:-->)?$/i);
  if (!match?.[1] || !match[2]) return null;
  const kinds: Record<string, CompiledKind> = { "ban-import": "banned-import", "forbid-code": "forbidden-code", "lock-path": "locked-path", "max-function-lines": "max-function-lines" };
  const kind = kinds[match[1].toLowerCase()];
  if (!kind) return null;
  const target = match[2].trim().replace(/^`|`$/g, "");
  return [{ id: `${source}#${kind}:${target}`, kind, source, text, scope, target, ...(match[3] ? { useInstead: match[3].trim().replace(/^`|`$/g, "") } : {}) }];
}

function compileClause(clause: string, text: string, source: string, scope: string[]): CompiledRule[] {
  const rules: CompiledRule[] = [];
  const id = (kind: string, target: string): string => `${source}#${kind}:${target}`.replace(/\s+/g, "_");
  // "Use `x` instead of `y`" / "Prefer `x` over `y`"
  const instead = clause.match(/\b(?:use|prefer)\s+`([^`]+)`\s+(?:instead of|over|rather than)\s+`([^`]+)`/i);
  if (instead?.[1] && instead[2]) {
    const [good, bad] = [instead[1].trim(), instead[2].trim()];
    const moduleLike = looksLikeModule(bad) && !/[().]/.test(bad) && (IMPORT_WORD.test(clause.replace(/^\s*(use|prefer)\b/i, "")) || looksLikeModule(good));
    rules.push({ id: id(moduleLike ? "banned-import" : "forbidden-code", bad), kind: moduleLike ? "banned-import" : "forbidden-code", source, text, scope, target: bad, useInstead: good });
    return rules;
  }
  const limit = clause.match(/\bfunctions?\b[^.]*?\b(?:under|at most|no (?:more|longer) than|fewer than|max(?:imum)?(?: of)?)\s+(\d{1,4})\s+lines\b/i);
  if (limit?.[1]) return [{ id: id("max-function-lines", limit[1]), kind: "max-function-lines", source, text, scope, target: limit[1] }];
  if (/\bexported\b[^.]*\b(?:must|should|need to)\s+have\s+(?:a\s+)?(?:jsdoc|tsdoc|doc ?comments?|docstrings?)/i.test(clause)) {
    return [{ id: id("require-jsdoc-exports", "exports"), kind: "require-jsdoc-exports", source, text, scope, target: "exports" }];
  }
  const negative = clause.match(NEGATIVE);
  if (!negative) return rules;
  const tail = clause.slice((negative.index ?? 0) + negative[0].length);
  // Bare package list: "Do not add axios, lodash, moment or dayjs."
  const bare = tail.match(/^\s*(?:add|use|import(?: from)?|install|depend on|pull in)\s+([@\w./-]+(?:\s*,\s*[@\w./-]+)*(?:,?\s+(?:or|and|nor)\s+[@\w./-]+)?)/i);
  if (bare?.[1] && !tail.includes("`")) {
    const tokens = bare[1].split(/\s*,\s*|\s+(?:or|and|nor)\s+/).map((item) => item.replace(/[.]+$/, "").trim()).filter(Boolean);
    if (tokens.length > 0 && tokens.every((token) => /^(@[\w.-]+\/)?[a-z][\w.-]*$/.test(token) && !STOPWORDS.has(token))) {
      for (const token of tokens) rules.push({ id: id("banned-import", token), kind: "banned-import", source, text, scope, target: token });
      return rules;
    }
  }
  const spans = codeSpans(tail);
  if (spans.length === 0) return rules;
  const narrowed = subjectScope(clause, scope);
  for (const span of spans) {
    if (EDIT_WORD.test(tail) && looksLikePath(span)) {
      rules.push({ id: id("locked-path", span), kind: "locked-path", source, text, scope, target: span });
    } else if (STRICT_IMPORT_WORD.test(tail) && (looksLikeModule(span) || looksLikePath(span)) && !/[()]/.test(span)) {
      rules.push({ id: id("banned-import", span), kind: "banned-import", source, text, scope: narrowed, target: span });
    } else if (span.length >= 2 && span.length <= 80 && !looksLikePath(span)) {
      rules.push({ id: id("forbidden-code", span), kind: "forbidden-code", source, text, scope, target: span });
    }
  }
  return rules;
}

function compileLine(text: string, source: string, scope: string[]): CompiledRule[] {
  if (/ctc:\s*ignore/i.test(text)) return [];
  const explicit = directive(text, source, scope);
  if (explicit) return explicit;
  return clausesOf(text).flatMap((clause) => compileClause(clause, text, source, scope));
}

function isRuleLine(line: string): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith("#") || t.startsWith("```") || (t.startsWith("<!--") && !/ctc:/.test(t))) return false;
  return /^([-*+]|\d+[.)])\s+/.test(t) || /\b(must|never|always|do not|don't|avoid|prefer|use)\b/i.test(t) || /ctc:/.test(t);
}

const reportCache = new Map<string, { key: string; report: RuleFileReport }>();

export function importRuleFiles(root: string): RuleFileReport {
  const sources = discoverRuleSources(root);
  const key = sources.map((item) => `${item.file}:${item.body.length}:${item.body.slice(0, 64)}`).join("|");
  const hit = reportCache.get(root);
  if (hit && hit.key === key) return hit.report;
  const compiled: CompiledRule[] = [];
  const advisory: RuleFileReport["advisory"] = [];
  let ruleLines = 0;
  let compiledLines = 0;
  for (const item of sources) {
    let inFence = false;
    item.body.split("\n").forEach((raw, index) => {
      if (raw.trim().startsWith("```")) inFence = !inFence;
      if (inFence || !isRuleLine(raw)) return;
      ruleLines += 1;
      const text = raw.trim().replace(/^([-*+]|\d+[.)])\s+/, "");
      const source = `${item.file}:${index + 1 + item.bodyOffset}`;
      const rules = compileLine(text, source, item.scope);
      if (rules.length > 0) {
        compiledLines += 1;
        compiled.push(...rules);
      } else advisory.push({ source, text });
    });
  }
  const report = { files: sources.map((item) => item.file), compiled, advisory, coverage: { ruleLines, compiled: compiledLines } };
  reportCache.set(root, { key, report });
  return report;
}

export function rulesFor(report: RuleFileReport, relativePath: string): CompiledRule[] {
  const target = toPosix(relativePath);
  return report.compiled.filter((rule) => rule.scope.some((glob) => glob === "**" || minimatch(target, glob, { dot: true })));
}
