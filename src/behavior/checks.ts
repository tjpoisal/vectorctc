import fs from "node:fs";
import path from "node:path";

import { ts } from "ts-morph";

import { pathMatches } from "../engine/match.js";
import { toPosix } from "../paths.js";
import type { GateViolation } from "../schemas/gate.js";
import { diffLines } from "../gate/diff.js";
import type { ExtensionInput } from "../gate/extensions.js";
import { DEFAULT_UTILITY_GLOBS, INTERNAL_HELPER_GLOBS, expandUtilityGlobs } from "../gate/rules/duplicates.js";
import { modelOf, toSandboxJs, type Callable, type FileModel } from "./extract.js";
import { tuplesFor } from "./inputs.js";
import { behaviorEnabled, encodeArgs, runSandbox, type Encodable, type SandboxJob, type SandboxModule } from "./sandbox.js";

/**
 * v0.4 behavioural layer (runs before the optional semantic reviewer):
 *  - DIFFERENTIAL: every function the edit modifies is run, old version vs new, on generated inputs of the OLD
 *    signature (plus literal arguments harvested from the repo's tests). Output changes the objective does not
 *    ask for block when the objective says behaviour must be preserved or the edit only adds optional
 *    parameters; otherwise they are reported as warnings for the semantic step / reviewer. The responsible line
 *    is found by reverting each changed line on its own and re-running the differing inputs.
 *  - EQUIVALENCE: a small function the edit adds is run against existing helpers with the same parameter types;
 *    identical outputs on every input (and at least two distinct outputs) mean it is a reworded duplicate, which
 *    token similarity misses when the code is phrased differently (`charAt(0) === "/"` vs `startsWith("/")`).
 *  - ARITY: an exported function whose required parameter count grows breaks its existing callers.
 */

const SCRIPT = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const JS_GLOBALS = new Set([
  "Math", "Number", "String", "Boolean", "Array", "Object", "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
  "Symbol", "BigInt", "Error", "TypeError", "RangeError", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "Intl", "Infinity", "NaN", "Promise", "Reflect",
]);
const PRESERVE = /\b(must not|should not|does not|do not|don'?t|won'?t|without|no)\s+(change|changing|alter|altering|affect)\w*\s+(its |the |any |existing )?(behaviou?r|output|result|semantics)|\bbehaviou?r\s+(must|should)\s+(not|stay)|\bbehave[sd]?\s+(exactly\s+)?(as|like)\s+before|\bno\s+behaviou?r(al)?\s+change|\bexisting\s+(calls|callers|behaviou?r|results)\s+(must|should)\s+not\s+change|\bunchanged\b|\brefactor|\btidy\b|\bclean\s?up\b|\breadab|\bjsdoc\b|\bdocument(ation)?\b|\bcomment\b|\bannotat|\brename\b|\bstack traces?\b/i;
const CHANGE_VERB = /\b(change|changes|make|fix|treat|instead|now|should|return|returns|handle|accept|support|allow|let|so that|use)\b/i;
const ACCEPT_VERB = /\b(accept|accepts|support|supports|allow|allows|handle|handles|tolerate)\b/i;
const BREAK_OK = /\b(breaking|break callers|now required|make \S+ required|mandatory|required parameter)\b/i;
const MAX_CANDIDATES = 40;
const MAX_VARIANTS = 8;

function objectiveOf(input: ExtensionInput): string {
  const plan = input.plan;
  if (!plan) return "";
  return `${plan.ticket ?? ""}\n${plan.objective ?? ""}`;
}

function quotedFragments(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/`([^`]{1,40})`|"([^"]{1,40})"|'([^']{1,40})'/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) out.push(value);
  }
  return out;
}

function requiredCount(fn: Callable): number {
  return fn.params.filter((p) => !p.optional && !p.rest).length;
}

function normType(type: string | null): string {
  return (type ?? "?").replace(/\breadonly\s+/g, "").replace(/\s+/g, "");
}

function isBoolText(value: string): boolean {
  return value === "true" || value === "false";
}

function sameOutput(a: [string, boolean], b: [string, boolean], booleanCoercion: boolean): boolean {
  if (a[0] === b[0]) return true;
  if (!booleanCoercion) return false;
  if (a[0].startsWith("throw:") || b[0].startsWith("throw:")) return false;
  return isBoolText(a[0]) !== isBoolText(b[0]) && a[1] === b[1];
}

function showValue(arg: unknown): string {
  if (Array.isArray(arg)) return `[${arg.map((item) => showValue(item)).join(", ")}]`;
  if (arg && typeof arg === "object") {
    const tag = arg as Record<string, unknown>;
    if ("$u" in tag) return "undefined";
    if ("$d" in tag) return `new Date("${String(tag.$d)}")`;
    if ("$stub" in tag) return `<${String(tag.$stub)}>`;
    if ("$n" in tag) return String(tag.$n);
  }
  return JSON.stringify(arg) ?? "undefined";
}

function showArgs(json: string): string {
  try {
    return (JSON.parse(json) as unknown[]).map((arg) => showValue(arg)).join(", ");
  } catch {
    return json;
  }
}

function showOut(value: string): string {
  if (value.startsWith("throw:")) return `throws ${value.slice(6)}`;
  if (value === "u") return "undefined";
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

// ---------- repo indexes (utility files, test literals) ----------

interface CachedModel {
  mtimeMs: number;
  size: number;
  text: string;
  model: FileModel;
}
const fileModels = new Map<string, CachedModel>();
const IGNORE = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next"]);

function walk(root: string, dir: string, out: string[], accept: (relative: string) => boolean, depth = 0): void {
  if (depth > 8 || out.length > 400) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORE.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, absolute, out, accept, depth + 1);
    else if (entry.isFile()) {
      const relative = toPosix(path.relative(root, absolute));
      if (SCRIPT.test(relative) && !relative.endsWith(".d.ts") && accept(relative)) out.push(relative);
    }
  }
}

function loadModel(root: string, relative: string): CachedModel | null {
  const absolute = path.join(root, relative);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return null;
  }
  const key = absolute;
  const hit = fileModels.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  if (stat.size > 400_000) return null;
  try {
    const text = fs.readFileSync(absolute, "utf8");
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, text, model: modelOf(relative, text) };
    if (fileModels.size > 500) fileModels.clear();
    fileModels.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function utilityFiles(root: string, globs: readonly string[]): string[] {
  const patterns = expandUtilityGlobs([...globs, ...INTERNAL_HELPER_GLOBS]);
  const files: string[] = [];
  walk(root, root, files, (relative) => patterns.some((pattern) => pathMatches(relative, pattern)) && !/\.(test|spec)\./.test(relative));
  return files;
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const testIndex = new Map<string, { at: number; files: string[] }>();

function testFiles(root: string): string[] {
  const hit = testIndex.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files: string[] = [];
  walk(root, root, files, (relative) => TEST_FILE.test(relative));
  testIndex.set(root, { at: Date.now(), files });
  return files;
}

function literalValue(node: ts.Expression): { ok: boolean; value: Encodable } {
  if (ts.isStringLiteralLike(node)) return { ok: true, value: node.text };
  if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return { ok: true, value: -Number(node.operand.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isIdentifier(node) && node.text === "undefined") return { ok: true, value: undefined };
  if (ts.isArrayLiteralExpression(node)) {
    const items: Encodable[] = [];
    for (const element of node.elements) {
      const item = literalValue(element);
      if (!item.ok) return { ok: false, value: null };
      items.push(item.value);
    }
    return { ok: true, value: items };
  }
  return { ok: false, value: null };
}

/** Literal argument lists of calls to `name` in the repo's tests: the existing tests' own examples become inputs. */
function testExamples(root: string, name: string, arity: number): Encodable[][] {
  const out: Encodable[][] = [];
  for (const relative of testFiles(root)) {
    const entry = loadModel(root, relative);
    if (!entry || !entry.text.includes(`${name}(`)) continue;
    const sf = ts.createSourceFile(relative, entry.text, ts.ScriptTarget.ES2022, false);
    const visit = (node: ts.Node): void => {
      if (out.length >= 80) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name && node.arguments.length <= arity) {
        const args: Encodable[] = [];
        let ok = true;
        for (const arg of node.arguments) {
          const value = literalValue(arg);
          if (!value.ok) {
            ok = false;
            break;
          }
          args.push(value.value);
        }
        if (ok && args.length > 0) out.push(args);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// ---------- the check ----------

interface Comparison {
  kind: "diff" | "equiv";
  fn: Callable;
  other?: { callable: Callable; file: string };
  inputs: string[];
  a: number;
  b: number;
  booleanCoercion: boolean;
}

function gatherable(fn: Callable): boolean {
  return !fn.async && !fn.generator;
}

export function behaviorViolations(input: ExtensionInput): GateViolation[] {
  if (!behaviorEnabled() || !SCRIPT.test(input.relativePath) || input.relativePath.endsWith(".d.ts")) return [];
  if (TEST_FILE.test(input.relativePath)) return [];
  const after = modelOf(input.relativePath, input.after);
  if (after.parseErrors) return [];
  const before = input.before === null ? null : modelOf(input.relativePath, input.before);
  if (before?.parseErrors) return [];
  const objective = objectiveOf(input);
  const out: GateViolation[] = [];
  const modules: SandboxModule[] = [];
  const moduleIndex = new Map<string, number>();
  const moduleFor = (key: string, file: string, text: string, model: FileModel): number => {
    const known = moduleIndex.get(key);
    if (known !== undefined) return known;
    modules.push({ code: toSandboxJs(file, text), names: model.names });
    moduleIndex.set(key, modules.length - 1);
    return modules.length - 1;
  };
  const jobs: SandboxJob[] = [];
  const comparisons: Comparison[] = [];
  const oldByKey = new Map((before?.callables ?? []).map((fn) => [fn.key, fn]));

  // DIFFERENTIAL + ARITY
  for (const fn of after.callables) {
    const old = oldByKey.get(fn.key);
    if (!old || input.before === null || !before) continue;
    const signatureChanged = old.params.map((p) => `${p.name}${p.optional ? "?" : ""}:${normType(p.type)}`).join(",") !== fn.params.map((p) => `${p.name}${p.optional ? "?" : ""}:${normType(p.type)}`).join(",");
    if (old.bodyText === fn.bodyText && !signatureChanged) continue;
    if (requiredCount(fn) > requiredCount(old)) {
      if (fn.exported && !BREAK_OK.test(objective)) {
        const added = fn.params.slice(requiredCount(old)).filter((p) => !p.optional && !p.rest).map((p) => `'${p.name}'`);
        out.push({
          rule: "BreakingChangeRule",
          code: "SIGNATURE_BREAK",
          file: input.relativePath,
          line: fn.line,
          column: 1,
          message: `Exported '${fn.name}' now requires ${requiredCount(fn)} argument(s); it took ${requiredCount(old)} before, so existing callers that pass fewer arguments break (new required ${added.join(", ")}).`,
          fix: `Make ${added.join(", ") || "the new parameter"} optional with a default that keeps the old behaviour, or update every caller in the same plan.`,
        });
      }
      continue;
    }
    if (!gatherable(fn) || !gatherable(old)) continue;
    const params = old.params.map((p, i) => ({ ...p, type: p.type ?? fn.params[i]?.type ?? null }));
    const shortName = fn.ref[fn.ref.length - 1] ?? fn.name;
    const extras = fn.ref.length === 1 ? testExamples(input.root, shortName, params.length) : [];
    const tuples = tuplesFor(params, true, extras);
    if (!tuples || tuples.length === 0) continue;
    const encoded = [...new Set(tuples.map((tuple) => encodeArgs(tuple)))];
    const a = moduleFor("before", input.relativePath, input.before, before);
    const b = moduleFor("after", input.relativePath, input.after, after);
    jobs.push({ module: a, ref: old.ref, inputs: encoded });
    jobs.push({ module: b, ref: fn.ref, inputs: encoded });
    comparisons.push({ kind: "diff", fn, inputs: encoded, a: jobs.length - 2, b: jobs.length - 1, booleanCoercion: true });
  }

  // EQUIVALENCE (reworded duplicates)
  const fresh = after.callables.filter((fn) => !oldByKey.has(fn.key) && fn.ref.length === 1 && gatherable(fn) && !fn.delegation && fn.statements <= 12);
  if (fresh.length > 0) {
    const localNames = new Set([...after.topLevel].filter((name) => !after.imported.has(name)));
    const globs = input.plan?.utilityGlobs ?? DEFAULT_UTILITY_GLOBS;
    let pool: Array<{ callable: Callable; file: string; text: string; model: FileModel }> | null = null;
    for (const fn of fresh) {
      if ([...fn.freeIdentifiers].some((id) => !JS_GLOBALS.has(id) && !localNames.has(id))) continue;
      const tuples = tuplesFor(fn.params, false);
      if (!tuples || tuples.length < 8) continue;
      const signature = fn.params.map((p) => normType(p.type)).join(",");
      if (!pool) {
        pool = [];
        if (before && input.before !== null) for (const callable of before.callables) pool.push({ callable, file: input.relativePath, text: input.before, model: before });
        for (const relative of utilityFiles(input.root, globs)) {
          if (relative === input.relativePath) continue;
          const entry = loadModel(input.root, relative);
          if (!entry || entry.model.parseErrors) continue;
          for (const callable of entry.model.callables) if (callable.exported) pool.push({ callable, file: relative, text: entry.text, model: entry.model });
        }
      }
      const candidates = pool
        .filter((c) => c.callable.ref.length === 1 && gatherable(c.callable) && c.callable.name !== fn.name)
        .filter((c) => c.callable.params.length === fn.params.length && c.callable.params.map((p) => normType(p.type)).join(",") === signature)
        .slice(0, MAX_CANDIDATES);
      if (candidates.length === 0) continue;
      const encoded = [...new Set(tuples.map((tuple) => encodeArgs(tuple)))];
      const self = moduleFor("after", input.relativePath, input.after, after);
      jobs.push({ module: self, ref: fn.ref, inputs: encoded });
      const selfJob = jobs.length - 1;
      for (const candidate of candidates) {
        const key = candidate.file === input.relativePath ? "before" : `file:${candidate.file}`;
        const m = moduleFor(key, candidate.file, candidate.text, candidate.model);
        jobs.push({ module: m, ref: candidate.callable.ref, inputs: encoded });
        comparisons.push({ kind: "equiv", fn, other: { callable: candidate.callable, file: candidate.file }, inputs: encoded, a: selfJob, b: jobs.length - 1, booleanCoercion: false });
      }
    }
  }

  if (jobs.length === 0) return out;
  const result = runSandbox(modules, jobs);
  if (!result.ok) return out;

  const reportedEquiv = new Set<string>();
  for (const comparison of comparisons) {
    const left = result.outputs[comparison.a];
    const right = result.outputs[comparison.b];
    if (!left || !right || left.length !== right.length) continue;
    if (left.some((o) => o[0] === "timeout") || right.some((o) => o[0] === "timeout")) continue;
    if (comparison.kind === "equiv") {
      if (reportedEquiv.has(comparison.fn.key)) continue;
      const allSame = left.every((o, i) => {
        const r = right[i];
        return r !== undefined && sameOutput(o, r, false);
      });
      const distinct = new Set(left.map((o) => o[0]).filter((v) => !v.startsWith("throw:")));
      if (!allSame || distinct.size < 2) continue;
      if (left.some((o) => o[0].includes("stub:"))) continue;
      const other = comparison.other;
      if (!other) continue;
      reportedEquiv.add(comparison.fn.key);
      const where = other.file === input.relativePath ? "in this file" : `in ${other.file}`;
      const importHint = other.file === input.relativePath ? `Call the existing '${other.callable.name}' instead of adding a copy.` : `Import the existing function: import { ${other.callable.name} } from "${other.file}".`;
      out.push({
        rule: "DuplicateLogicRule",
        code: "DUPLICATE_BEHAVIOR",
        file: input.relativePath,
        line: comparison.fn.line,
        column: 1,
        message: `Function '${comparison.fn.name}' duplicates the existing '${other.callable.name}' ${where}: the two returned the same result on all ${left.length} generated inputs (${distinct.size} distinct results), so it is the same logic written differently.`,
        fix: importHint,
      });
      continue;
    }
    const differing: number[] = [];
    left.forEach((o, i) => {
      const r = right[i];
      if (r && !sameOutput(o, r, comparison.booleanCoercion)) differing.push(i);
    });
    if (differing.length === 0) continue;
    const fn = comparison.fn;
    const old = oldByKey.get(fn.key);
    if (!old) continue;
    const fragments = quotedFragments(objective).filter((f) => f.length <= 12 && !/^[A-Za-z_$][\w$]*$/.test(f));
    const accepts = ACCEPT_VERB.test(objective);
    const uncovered = differing.filter((i) => {
      const args = comparison.inputs[i] ?? "";
      const was = left[i]?.[0] ?? "";
      if (fragments.some((f) => args.includes(JSON.stringify(f).slice(1, -1)))) return false;
      if (accepts && was.startsWith("throw:")) return false;
      return true;
    });
    if (uncovered.length === 0) continue;
    const shortName = fn.ref[fn.ref.length - 1] ?? fn.name;
    const named = new RegExp(`\\b${shortName.replace(/[$]/g, "\\$")}\\b`).test(objective);
    const additive = fn.params.length > old.params.length && requiredCount(fn) === requiredCount(old);
    const preserving = PRESERVE.test(objective);
    const block = preserving || additive;
    if (!block && named && CHANGE_VERB.test(objective)) continue;
    const first = [...uncovered].sort((x, y) => (comparison.inputs[x]?.length ?? 0) - (comparison.inputs[y]?.length ?? 0) || x - y)[0] ?? 0;
    const example = `${shortName}(${showArgs(comparison.inputs[first] ?? "[]")}) returned ${showOut(left[first]?.[0] ?? "?")} before and now returns ${showOut(right[first]?.[0] ?? "?")}`;
    const culprit = localize(input, fn, comparison, uncovered, result.outputs);
    const why = preserving
      ? "the objective says behaviour must be preserved"
      : additive
        ? "the edit only adds optional parameters, so calls with the old arguments must behave as before"
        : "the objective does not ask for a behaviour change here";
    out.push({
      rule: "BehaviorRule",
      code: "BEHAVIOR_CHANGED",
      file: input.relativePath,
      line: culprit?.line ?? fn.line,
      column: 1,
      message: `Unrequested behaviour change in '${fn.name}': ${example} (${uncovered.length} of ${comparison.inputs.length} generated inputs differ)${culprit ? `; line ${culprit.line} is responsible (reverting it alone restores the old results): '${culprit.text.trim()}'` : ""}. Flagged because ${why}.`,
      fix: culprit ? `Restore '${culprit.oldText.trim()}', or say in the plan objective that this behaviour change is intended.` : "Keep the old results for existing inputs, or say in the plan objective that this behaviour change is intended.",
      ...(block ? {} : { severity: "warn" as const }),
    });
  }
  return out;
}

/** Revert each one-for-one changed line of the function on its own; the line whose revert restores the old outputs is the cause. */
function localize(
  input: ExtensionInput,
  fn: Callable,
  comparison: Comparison,
  differing: number[],
  outputs: Array<Array<[string, boolean]> | null>,
): { line: number; text: string; oldText: string } | null {
  if (input.before === null) return null;
  const diff = diffLines(input.before, input.after);
  const candidates: Array<{ line: number; text: string; oldText: string }> = [];
  for (const hunk of diff.hunks) {
    if (hunk.removed.length !== hunk.added.length) continue;
    hunk.added.forEach((added, i) => {
      const removed = hunk.removed[i];
      if (!removed || added.line < fn.startLine || added.line > fn.endLine) return;
      candidates.push({ line: added.line, text: added.text, oldText: removed.text });
    });
  }
  if (candidates.length === 0) return null;
  const old = outputs[comparison.a];
  if (!old) return null;
  const lines = input.after.split("\n");
  const subset = differing.slice(0, 12).map((i) => comparison.inputs[i] ?? "[]");
  const modules: SandboxModule[] = [];
  const jobs: SandboxJob[] = [];
  const model = modelOf(input.relativePath, input.after);
  for (const candidate of candidates.slice(0, MAX_VARIANTS)) {
    const variant = [...lines];
    variant[candidate.line - 1] = candidate.oldText;
    const text = variant.join("\n");
    const variantModel = modelOf(input.relativePath, text);
    if (variantModel.parseErrors) {
      modules.push({ code: "", names: [] });
    } else modules.push({ code: toSandboxJs(input.relativePath, text), names: model.names });
    jobs.push({ module: modules.length - 1, ref: fn.ref, inputs: subset });
  }
  const result = runSandbox(modules, jobs);
  if (!result.ok) return null;
  for (let index = 0; index < jobs.length; index += 1) {
    const got = result.outputs[index];
    if (!got) continue;
    const restored = got.every((o, k) => {
      const original = old[differing[k] ?? -1];
      return original !== undefined && sameOutput(o, original, comparison.booleanCoercion);
    });
    if (restored) return candidates[index] ?? null;
  }
  return null;
}
