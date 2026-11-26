import fs from "node:fs";
import path from "node:path";

import { diffLines } from "../gate/diff.js";
import type { ExtensionInput } from "../gate/extensions.js";
import type { GateViolation } from "../schemas/gate.js";
import { DEFAULT_THRESHOLDS } from "../schemas/flightPlan.js";
import { languageOf } from "./lines.js";
import { outline, type FunctionInfo, type Outline } from "./outline.js";
import { GO_STDLIB, PYTHON_DIST_ALIASES, PYTHON_STDLIB } from "./stdlib.js";
import type { GrammarId } from "./treesitter.js";

/**
 * Language-agnostic rules for Python and Go (v0.4 item 9): phantom imports / symbols, duplicate logic,
 * function length and complexity, in-file edit scope. Every rule is diff-aware — it reports only what the
 * proposal introduces — and resolves against what is really on disk: stdlib tables, the repo tree, and the
 * declared dependency manifests (requirements / pyproject / Pipfile / setup.cfg, go.mod). A module the task has not
 * created yet is phantom until it is written (write it first). When a repo declares no dependencies at all,
 * unknown third-party imports are reported as warnings instead of blocks.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", "vendor", "dist", "build", ".tox", ".mypy_cache", ".ctc", "testdata"]);

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const isDir = (file: string): boolean => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};

function violation(input: ExtensionInput, partial: Omit<GateViolation, "file" | "column"> & { column?: number | null }): GateViolation {
  return { file: input.relativePath, column: null, ...partial };
}

// ------------------------------------------------------------------ dependency manifests

interface PythonDeps {
  declared: Set<string>;
  manifests: string[];
}

function normalizeDist(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function pythonDeps(root: string): PythonDeps {
  const declared = new Set<string>();
  const manifests: string[] = [];
  const add = (dist: string): void => {
    const clean = dist.trim().replace(/\[.*$/, "");
    if (!/^[A-Za-z0-9][\w.-]*$/.test(clean)) return;
    const norm = normalizeDist(clean);
    declared.add(norm.replace(/-/g, "_"));
    declared.add(clean.toLowerCase());
    for (const alias of PYTHON_DIST_ALIASES[norm] ?? []) declared.add(alias.toLowerCase());
  };
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!/^requirements.*\.(txt|in)$/i.test(name) && name !== "constraints.txt") continue;
    manifests.push(name);
    for (const raw of (read(path.join(root, name)) ?? "").split("\n")) {
      const lineText = raw.replace(/#.*$/, "").trim();
      if (!lineText || lineText.startsWith("-")) continue;
      add(lineText.split(/[<>=!~;@\s]/)[0] ?? "");
    }
  }
  const pyproject = read(path.join(root, "pyproject.toml"));
  if (pyproject) {
    manifests.push("pyproject.toml");
    for (const match of pyproject.matchAll(/^\s*["']([A-Za-z0-9][\w.\-[\],]*)\s*[<>=!~;@ "']/gm)) add(match[1] ?? "");
    for (const match of pyproject.matchAll(/^\s*["']([A-Za-z0-9][\w.-]*)["']\s*,?\s*$/gm)) add(match[1] ?? "");
    const poetry = pyproject.match(/\[tool\.poetry(?:\.group\.\w+)?\.(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g) ?? [];
    for (const section of poetry) for (const match of section.matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)) add(match[1] ?? "");
    const name = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (name?.[1]) add(name[1]);
  }
  const pipfile = read(path.join(root, "Pipfile"));
  if (pipfile) {
    manifests.push("Pipfile");
    for (const match of pipfile.matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)) add(match[1] ?? "");
  }
  const setupCfg = read(path.join(root, "setup.cfg"));
  if (setupCfg?.includes("install_requires")) {
    manifests.push("setup.cfg");
    const block = setupCfg.split(/install_requires\s*=/)[1]?.split(/\n\S/)[0] ?? "";
    for (const raw of block.split("\n")) add(raw.trim().split(/[<>=!~;\s]/)[0] ?? "");
  }
  const setupPy = read(path.join(root, "setup.py"));
  if (setupPy) {
    manifests.push("setup.py");
    const block = setupPy.match(/install_requires\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    for (const match of block.matchAll(/["']([A-Za-z0-9][\w.-]*)/g)) add(match[1] ?? "");
  }
  // Installed packages in a project virtualenv count as declared.
  for (const venv of [".venv", "venv", "env"]) {
    const lib = path.join(root, venv, "lib");
    if (!isDir(lib)) continue;
    for (const version of fs.readdirSync(lib)) {
      const site = path.join(lib, version, "site-packages");
      if (!isDir(site)) continue;
      manifests.push(`${venv}/lib/${version}/site-packages`);
      for (const entry of fs.readdirSync(site)) declared.add(entry.replace(/\.py$/, "").replace(/-.*$/, "").toLowerCase());
    }
  }
  return { declared, manifests };
}

interface GoMod {
  module: string | null;
  requires: string[];
  replaces: Map<string, string>;
  dir: string;
}

function goMod(root: string, relativePath: string): GoMod | null {
  let dir = path.dirname(path.join(root, relativePath));
  const top = path.resolve(root);
  for (;;) {
    const text = read(path.join(dir, "go.mod"));
    if (text !== null) {
      const module = text.match(/^module\s+(\S+)/m)?.[1] ?? null;
      const requires: string[] = [];
      for (const match of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/\S+|[\w.-]+\.[\w.-]+)\s+v[\w.+-]+/gm)) if (match[1]) requires.push(match[1]);
      const replaces = new Map<string, string>();
      for (const match of text.matchAll(/^\s*(?:replace\s+)?(\S+)(?:\s+v\S+)?\s+=>\s+(\S+)/gm)) if (match[1] && match[2]) replaces.set(match[1], match[2]);
      return { module, requires, replaces, dir };
    }
    if (path.resolve(dir) === top || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}

// ------------------------------------------------------------------ module resolution

interface Resolved {
  kind: "stdlib" | "local" | "external" | "unknown";
  /** For local modules: the file whose top level holds the names, or a package dir. */
  file?: string | null;
  dir?: string | null;
}

function pythonRoots(root: string): string[] {
  return [root, path.join(root, "src"), path.join(root, "lib"), path.join(root, "app")].filter(isDir);
}

function resolvePythonPath(base: string, dotted: string): { file: string | null; dir: string | null } | null {
  const parts = dotted ? dotted.split(".") : [];
  const target = path.join(base, ...parts);
  if (parts.length > 0 && (isFile(`${target}.py`) || isFile(`${target}.pyi`))) return { file: isFile(`${target}.py`) ? `${target}.py` : `${target}.pyi`, dir: null };
  if (isDir(target)) return { file: isFile(path.join(target, "__init__.py")) ? path.join(target, "__init__.py") : null, dir: target };
  return null;
}

function resolvePython(input: ExtensionInput, module: string, dots: number): Resolved {
  const { root } = input;
  if (dots > 0) {
    let base = path.dirname(path.join(root, input.relativePath));
    for (let index = 1; index < dots; index += 1) base = path.dirname(base);
    const hit = resolvePythonPath(base, module);
    if (hit) return { kind: "local", ...hit };
    return { kind: "unknown" };
  }
  const topName = module.split(".")[0] ?? module;
  if (PYTHON_STDLIB.has(topName)) return { kind: "stdlib" };
  for (const base of pythonRoots(root)) {
    if (!resolvePythonPath(base, topName)) continue;
    const hit = resolvePythonPath(base, module);
    if (hit) return { kind: "local", ...hit };
    return { kind: "unknown" };
  }
  // A sibling module next to the importing file (script-style layouts).
  const sibling = resolvePythonPath(path.dirname(path.join(root, input.relativePath)), module);
  if (sibling) return { kind: "local", ...sibling };
  return { kind: "external" };
}

function moduleOutline(file: string | null | undefined, language: GrammarId): Outline | null {
  if (!file) return null;
  const text = read(file);
  return text === null ? null : outline(language, text);
}

// ------------------------------------------------------------------ phantom rule

function pythonPhantoms(input: ExtensionInput, after: Outline, changed: Set<number>): GateViolation[] {
  const out: GateViolation[] = [];
  let deps: PythonDeps | null = null;
  const aliases = new Map<string, Resolved>();
  for (const item of after.imports) {
    const resolved = resolvePython(input, item.module, item.dots);
    if (item.local) aliases.set(item.local, resolved);
    if (!changed.has(item.line)) continue;
    const shown = `${".".repeat(item.dots)}${item.module}`;
    if (resolved.kind === "unknown") {
      out.push(violation(input, { rule: "PhantomSymbolRule", code: "PHANTOM_IMPORT", line: item.line, message: `Module '${shown}' does not exist in this repo (no matching .py file or package directory).`, fix: `Import an existing module, or add '${shown}' to the flight plan and create it first.` }));
      continue;
    }
    if (resolved.kind === "external") {
      deps ??= pythonDeps(input.root);
      const topName = (item.module.split(".")[0] ?? item.module).toLowerCase();
      if (deps.declared.has(topName)) continue;
      const none = deps.manifests.length === 0;
      out.push(violation(input, {
        rule: "PhantomSymbolRule",
        code: "PHANTOM_IMPORT",
        line: item.line,
        message: none
          ? `Module '${shown}' is not in the standard library or this repo, and the repo declares no dependencies to check it against.`
          : `Module '${shown}' is not in the standard library, this repo, or the declared dependencies (${deps.manifests.join(", ")}).`,
        fix: none ? "Add a requirements.txt or pyproject.toml so imports can be verified." : `Use a declared package, or add the distribution that provides '${topName}' to ${deps.manifests[0]} in a planned change.`,
        ...(none ? { severity: "warn" as const } : {}),
      }));
      continue;
    }
    if (resolved.kind !== "local" || item.names.length === 0) continue;
    const target = moduleOutline(resolved.file, "python");
    for (const name of item.names) {
      if (name === "*" || !target) continue;
      if (target.topLevel.has(name)) continue;
      if (resolved.dir && resolvePythonPath(resolved.dir, name)) continue;
      if (target.topLevel.has("__getattr__")) continue;
      out.push(violation(input, { rule: "PhantomSymbolRule", code: "PHANTOM_SYMBOL", line: item.line, message: `'${name}' is not defined in ${path.relative(input.root, resolved.file ?? "").split(path.sep).join("/")}.`, fix: `Import a name the module really defines${closest(name, target.topLevel)}, or add it there in a planned change.` }));
    }
  }
  // module.attr on changed lines, for local modules imported whole.
  for (const ref of after.attributes) {
    if (!changed.has(ref.line)) continue;
    const resolved = aliases.get(ref.object);
    if (!resolved || resolved.kind !== "local" || !resolved.file) continue;
    const target = moduleOutline(resolved.file, "python");
    if (!target || target.topLevel.has(ref.attribute) || target.topLevel.has("__getattr__")) continue;
    if (resolved.dir && resolvePythonPath(resolved.dir, ref.attribute)) continue;
    out.push(violation(input, { rule: "PhantomSymbolRule", code: "PHANTOM_SYMBOL", line: ref.line, message: `'${ref.object}.${ref.attribute}' does not exist: ${path.relative(input.root, resolved.file).split(path.sep).join("/")} defines no '${ref.attribute}'.`, fix: `Use a name the module defines${closest(ref.attribute, target.topLevel)}.` }));
  }
  return dedupe(out);
}

function goPackageNames(dir: string): Set<string> | null {
  if (!isDir(dir)) return null;
  const names = new Set<string>();
  let any = false;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".go") || entry.endsWith("_test.go")) continue;
    any = true;
    const text = read(path.join(dir, entry));
    if (text) for (const name of outline("go", text).topLevel) names.add(name);
  }
  return any ? names : null;
}

function goPhantoms(input: ExtensionInput, after: Outline, changed: Set<number>): GateViolation[] {
  const out: GateViolation[] = [];
  const mod = goMod(input.root, input.relativePath);
  const locals = new Map<string, { dir: string; rel: string }>();
  for (const item of after.imports) {
    const spec = item.module;
    const first = spec.split("/")[0] ?? spec;
    let kind: "stdlib" | "local" | "external" | "unknown";
    let dir: string | null = null;
    if (mod?.module && (spec === mod.module || spec.startsWith(`${mod.module}/`))) {
      dir = path.join(mod.dir, spec.slice(mod.module.length));
      const rel = path.relative(input.root, dir).split(path.sep).join("/");
      kind = goPackageNames(dir) ? "local" : "unknown";
      if (kind === "local" && item.local && item.local !== "_" && item.local !== ".") locals.set(item.local, { dir, rel });
    } else if (!first.includes(".")) kind = GO_STDLIB.has(spec) ? "stdlib" : "unknown";
    else if (!mod) kind = "unknown";
    else kind = mod.requires.some((req) => spec === req || spec.startsWith(`${req}/`)) || [...mod.replaces.keys()].some((req) => spec === req || spec.startsWith(`${req}/`)) ? "external" : "unknown";
    if (!changed.has(item.line) || kind === "stdlib" || kind === "local" || kind === "external") continue;
    const stdlibLike = !first.includes(".");
    const message = mod?.module && spec.startsWith(`${mod.module}/`)
      ? `Package '${spec}' does not exist in this module (no .go files in ${path.relative(input.root, dir ?? "").split(path.sep).join("/") || "."}).`
      : stdlibLike
        ? `'${spec}' is not a Go standard-library package${mod?.module ? ` and does not start with the module path '${mod.module}'` : ""}.`
        : mod
          ? `Module '${spec}' is not required in go.mod.`
          : `Module '${spec}' cannot be verified: no go.mod found.`;
    out.push(violation(input, { rule: "PhantomSymbolRule", code: "PHANTOM_IMPORT", line: item.line, message, fix: stdlibLike ? "Import an existing package path." : "Use a module listed in go.mod, or add it with `go get` in a planned change.", ...(mod ? {} : { severity: "warn" as const }) }));
  }
  for (const ref of after.attributes) {
    if (!changed.has(ref.line)) continue;
    const local = locals.get(ref.object);
    if (!local || !/^[A-Z]/.test(ref.attribute)) continue;
    const names = goPackageNames(local.dir);
    if (!names || names.has(ref.attribute)) continue;
    out.push(violation(input, { rule: "PhantomSymbolRule", code: "PHANTOM_SYMBOL", line: ref.line, message: `'${ref.object}.${ref.attribute}' does not exist: package ${local.rel} exports no '${ref.attribute}'.`, fix: `Use an identifier the package declares${closest(ref.attribute, names)}.` }));
  }
  return dedupe(out);
}

function closest(name: string, pool: Iterable<string>): string {
  let best: string | null = null;
  let score = Infinity;
  for (const candidate of pool) {
    const a = name.toLowerCase();
    const b = candidate.toLowerCase();
    const distance = b.length >= 4 && (a.startsWith(b) || b.startsWith(a)) ? 1 : levenshtein(a, b);
    if (distance < score) {
      score = distance;
      best = candidate;
    }
  }
  return best && score <= Math.max(2, Math.floor(name.length / 3)) ? ` (did you mean '${best}'?)` : "";
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0;
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

function dedupe(items: GateViolation[]): GateViolation[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.code}:${item.line}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------------ duplicates

const PY_KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self".split(" "));
const GO_KEYWORDS = new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false err".split(" "));

function shingles(fn: FunctionInfo, language: GrammarId): Set<string> {
  const keywords = language === "python" ? PY_KEYWORDS : GO_KEYWORDS;
  const body = fn.text.split("\n").slice(1).join("\n").replace(language === "python" ? /#.*$/gm : /\/\/.*$/gm, "");
  const tokens = (body.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\d[\w.]*|[A-Za-z_]\w*|[^\s\w]/g) ?? []).map((token) => {
    if (/^["'`\d]/.test(token)) return "LIT";
    if (/^[A-Za-z_]/.test(token) && !keywords.has(token)) return "ID";
    return token;
  });
  const out = new Set<string>();
  for (let index = 0; index + 4 <= tokens.length; index += 1) out.add(tokens.slice(index, index + 4).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  return inter / (a.size + b.size - inter);
}

interface IndexedFunction {
  file: string;
  fn: FunctionInfo;
  shingles: Set<string>;
}

const indexCache = new Map<string, { at: number; stamp: string; items: IndexedFunction[] }>();

function functionIndex(root: string, language: GrammarId, exclude: string): IndexedFunction[] {
  const ext = language === "python" ? [".py"] : [".go"];
  const key = `${root}\u0000${language}`;
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.items.filter((item) => item.file !== exclude);
  const items: IndexedFunction[] = [];
  const stampParts: string[] = [];
  let files = 0;
  const visit = (dir: string): void => {
    if (files > 3000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) visit(path.join(dir, entry.name));
        continue;
      }
      if (!ext.includes(path.extname(entry.name)) || entry.name.endsWith("_test.go") || /^test_.*\.py$/.test(entry.name)) continue;
      files += 1;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      const text = read(absolute);
      if (!text) continue;
      stampParts.push(`${rel}:${text.length}`);
      for (const fn of outline(language, text).functions) {
        if (fn.end - fn.start + 1 < 5) continue;
        items.push({ file: rel, fn, shingles: shingles(fn, language) });
      }
    }
  };
  visit(root);
  indexCache.set(key, { at: Date.now(), stamp: stampParts.join("|"), items });
  return items.filter((item) => item.file !== exclude);
}

function duplicateViolations(input: ExtensionInput, language: GrammarId, before: Outline | null, after: Outline, changed: Set<number>, threshold: number): GateViolation[] {
  const out: GateViolation[] = [];
  const index = functionIndex(input.root, language, input.relativePath);
  const beforeBodies = new Map((before?.functions ?? []).map((fn) => [fn.qualified, fn.text]));
  for (const fn of after.functions) {
    if (fn.end - fn.start + 1 < 5) continue;
    if (beforeBodies.get(fn.qualified) === fn.text) continue;
    if (![...changed].some((lineNo) => lineNo >= fn.start && lineNo <= fn.end)) continue;
    const mine = shingles(fn, language);
    if (mine.size < 8) continue;
    let best: { item: IndexedFunction; score: number } | null = null;
    const candidates = [...index, ...after.functions.filter((other) => other !== fn && other.end - other.start + 1 >= 5 && beforeBodies.has(other.qualified)).map((other) => ({ file: input.relativePath, fn: other, shingles: shingles(other, language) }))];
    for (const item of candidates) {
      if (item.file === input.relativePath && item.fn.qualified === fn.qualified) continue;
      const score = jaccard(mine, item.shingles);
      if (score >= threshold && (!best || score > best.score)) best = { item, score };
    }
    if (!best) continue;
    out.push(violation(input, {
      rule: "DuplicateLogicRule",
      code: "DUPLICATE_LOGIC",
      line: fn.start,
      similarity: Math.round(best.score * 100) / 100,
      message: `'${fn.qualified}' duplicates '${best.item.fn.qualified}' in ${best.item.file}:${best.item.fn.start} (${Math.round(best.score * 100)}% token similarity).`,
      fix: `Call or extend '${best.item.fn.qualified}' instead of re-implementing it.`,
    }));
  }
  return out;
}

// ------------------------------------------------------------------ length / complexity

function sizeViolations(input: ExtensionInput, before: Outline | null, after: Outline, changed: Set<number>, maxLines: number, maxComplexity: number, disabled: Set<string>): GateViolation[] {
  const out: GateViolation[] = [];
  const previous = new Map((before?.functions ?? []).map((fn) => [fn.qualified, fn]));
  for (const fn of after.functions) {
    if (![...changed].some((lineNo) => lineNo >= fn.start && lineNo <= fn.end)) continue;
    const old = previous.get(fn.qualified);
    const lines = fn.end - fn.start + 1;
    if (!disabled.has("functionLength") && lines > maxLines && (!old || old.end - old.start + 1 < lines) && (!old || old.end - old.start + 1 <= maxLines || lines > old.end - old.start + 1)) {
      out.push(violation(input, { rule: "LongMethodRule", code: "FUNCTION_TOO_LONG", line: fn.start, message: `Function '${fn.qualified}' spans ${lines} lines (limit ${maxLines})${old ? `; it was ${old.end - old.start + 1}` : ""}.`, fix: `Split '${fn.qualified}' so it is ${maxLines} lines or fewer.` }));
    }
    if (!disabled.has("complexity") && fn.complexity > maxComplexity && (!old || old.complexity < fn.complexity)) {
      out.push(violation(input, { rule: "LongMethodRule", code: "COMPLEXITY", line: fn.start, message: `Function '${fn.qualified}' has cyclomatic complexity ${fn.complexity} (limit ${maxComplexity})${old ? `; it was ${old.complexity}` : ""}.`, fix: `Extract branches from '${fn.qualified}' until its complexity is ${maxComplexity} or less.` }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ edit scope

function editScopeViolations(input: ExtensionInput, before: Outline, after: Outline, beforeText: string, allowed: readonly string[]): GateViolation[] {
  const diff = diffLines(beforeText, input.after);
  const allow = new Set(allowed);
  const isAllowed = (fn: FunctionInfo): boolean => allow.has(fn.name) || allow.has(fn.qualified) || allow.has(fn.qualified.split(".")[0] ?? "");
  // Derived scope: functions the allowed ones call (helpers they need) are in scope too.
  const derived = new Set<string>();
  for (const fn of after.functions) if (isAllowed(fn)) for (const call of fn.calls) derived.add(call);
  const existing = new Set(before.functions.map((fn) => fn.qualified));
  const out: GateViolation[] = [];
  const reported = new Set<string>();
  for (const lineNo of [...diff.changedNewLines].sort((a, b) => a - b)) {
    const enclosing = after.functions.filter((fn) => lineNo >= fn.start && lineNo <= fn.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!enclosing || !existing.has(enclosing.qualified)) continue;
    const outer = after.functions.filter((fn) => lineNo >= fn.start && lineNo <= fn.end);
    if (outer.some(isAllowed) || outer.some((fn) => derived.has(fn.name))) continue;
    if (reported.has(enclosing.qualified)) continue;
    reported.add(enclosing.qualified);
    out.push(violation(input, { rule: "EditScopeRule", code: "EDIT_OUTSIDE_PLAN_SCOPE", line: lineNo, message: `This edit changes '${enclosing.qualified}', which the flight plan does not list in allowedEditSymbols (${allowed.join(", ")}).`, fix: `Revert the change to '${enclosing.qualified}', or add it to allowedEditSymbols in the flight plan.` }));
  }
  // Removed functions that are not allowed.
  const afterNames = new Set(after.functions.map((fn) => fn.qualified));
  for (const fn of before.functions) {
    if (afterNames.has(fn.qualified) || isAllowed(fn)) continue;
    out.push(violation(input, { rule: "EditScopeRule", code: "EDIT_OUTSIDE_PLAN_SCOPE", line: null, message: `This edit removes '${fn.qualified}', which the flight plan does not list in allowedEditSymbols.`, fix: `Keep '${fn.qualified}', or add it to allowedEditSymbols in the flight plan.` }));
  }
  return out;
}

// ------------------------------------------------------------------ entry point

export function polyglotViolations(input: ExtensionInput): GateViolation[] {
  const lang = languageOf(input.relativePath);
  if (lang !== "python" && lang !== "go") return [];
  if (input.relativePath.endsWith(".pyi")) return [];
  const language: GrammarId = lang;
  const after = outline(language, input.after);
  const before = input.before === null ? null : outline(language, input.before);
  const changed = input.before === null ? new Set(input.after.split("\n").map((_, index) => index + 1)) : diffLines(input.before, input.after).changedNewLines;
  if (changed.size === 0 && (!before || before.functions.length === after.functions.length)) return [];
  const plan = input.plan;
  const disabled = new Set<string>(plan?.disabledRules ?? []);
  const thresholds = plan?.thresholds ?? DEFAULT_THRESHOLDS;
  const isTest = /(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go)|conftest\.py)$/.test(input.relativePath);
  const out: GateViolation[] = [];
  if (!disabled.has("phantom")) out.push(...(language === "python" ? pythonPhantoms(input, after, changed) : goPhantoms(input, after, changed)));
  if (!disabled.has("duplicates") && !isTest) out.push(...duplicateViolations(input, language, before, after, changed, thresholds.duplicateJaccard));
  if (!isTest) out.push(...sizeViolations(input, before, after, changed, thresholds.maxFunctionLines, thresholds.maxCyclomaticComplexity, disabled));
  if (plan?.allowedEditSymbols && before && input.before !== null) out.push(...editScopeViolations(input, before, after, input.before, plan.allowedEditSymbols));
  if (after.parser === "fallback" && out.length > 0) {
    for (const item of out) item.message += " [line-based parser: tree-sitter grammar not loaded]";
  }
  return out;
}
