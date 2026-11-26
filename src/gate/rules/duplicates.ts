import fs from "node:fs";
import path from "node:path";
import { Node, Project, ScriptKind, SyntaxKind, type SourceFile } from "ts-morph";

import { fingerprint, functionName, functionsIn, jaccardSimilarity, type FunctionLikeNode, type SubtreeFingerprint } from "../../engine/hash/ast-hasher.js";
import { scriptKindFor, simulateSource } from "../../engine/simulate.js";
import { pathMatches } from "../../engine/match.js";
import { toPosix } from "../../paths.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";

const BANDS = 64;
const PERMUTATIONS = 64;
const SHINGLE = 4;
const MIN_TOKENS = 6;
export const DEFAULT_UTILITY_GLOBS = ["src/utils/**", "src/lib/**"];
/**
 * Private/internal helper modules are indexed in addition to the configured utility globs (v0.3):
 * `_name.ts` files, `internal/`, `helpers/` and `shared/` folders. Agents re-implement these as often as
 * public utilities, and they are usually where a library keeps its normalizers.
 */
export const INTERNAL_HELPER_GLOBS = ["src/**/_*.*", "src/**/internal/**", "src/**/*internal*.*", "src/**/helpers/**", "src/**/shared/**"];
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * `src/utils/**` also covers the single-file form `src/utils.ts` (and .tsx/.js...), so a repo that keeps
 * its helpers in one module is indexed the same way as one that keeps them in a folder.
 */
export function expandUtilityGlobs(globs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const glob of globs) {
    out.add(glob);
    const folder = glob.match(/^(.*[^/*])\/\*\*(?:\/\*)?$/)?.[1];
    if (folder && !/[*?[\]{]/.test(folder)) for (const ext of SCRIPT_EXTENSIONS) out.add(`${folder}${ext}`);
  }
  return [...out];
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  functions: IndexedFunction[];
}

/** Per-root fingerprint cache keyed by file; entries are reused while mtime and size are unchanged. */
const fileCache = new Map<string, Map<string, CachedFile>>();

export function clearDuplicateIndexCache(): void {
  fileCache.clear();
}
const IGNORE = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next"]);

interface IndexedFunction {
  relativePath: string;
  name: string;
  print: SubtreeFingerprint;
}

function exportedFunction(fn: FunctionLikeNode): boolean {
  if (Node.isFunctionDeclaration(fn)) return fn.isExported();
  if (Node.isMethodDeclaration(fn)) {
    const parent = fn.getParent();
    return Node.isClassDeclaration(parent) && parent.isExported();
  }
  const statement = fn.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  return statement?.isExported() === true;
}

function shareBand(left: Uint32Array, right: Uint32Array): boolean {
  const length = Math.min(left.length, right.length, BANDS);
  for (let band = 0; band < length; band += 1) {
    if (left[band] !== undefined && left[band] === right[band]) return true;
  }
  return false;
}

function walk(root: string, dir: string, out: string[], globs: readonly string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORE.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, out, globs);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = toPosix(path.relative(root, absolute));
    if (!scriptKindFor(relative)) continue;
    if (globs.some((pattern) => pathMatches(relative, pattern))) out.push(relative);
  }
}

function fingerprintFile(relative: string, content: string): IndexedFunction[] {
  const scratch = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const kind = relative.endsWith("x") ? ScriptKind.TSX : ScriptKind.TS;
  const source = scratch.createSourceFile(relative, content, { overwrite: true, scriptKind: kind });
  const indexed: IndexedFunction[] = [];
  for (const fn of functionsIn(source)) {
    if (!exportedFunction(fn)) continue;
    const print = fingerprint(fn, SHINGLE, PERMUTATIONS);
    if (print.nodeCount < MIN_TOKENS || print.exactHash === "") continue;
    indexed.push({ relativePath: relative, name: functionName(fn), print });
  }
  return indexed;
}

function indexUtilities(root: string, skipPath: string, globs: readonly string[]): IndexedFunction[] {
  const files: string[] = [];
  walk(root, root, files, expandUtilityGlobs(globs));
  let cache = fileCache.get(root);
  if (!cache) {
    cache = new Map();
    fileCache.set(root, cache);
  }
  const seen = new Set(files);
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  const indexed: IndexedFunction[] = [];
  for (const relative of files) {
    if (relative === skipPath) continue;
    const absolute = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    const hit = cache.get(relative);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      indexed.push(...hit.functions);
      continue;
    }
    let content = "";
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const functions = fingerprintFile(relative, content);
    cache.set(relative, { mtimeMs: stat.mtimeMs, size: stat.size, functions });
    indexed.push(...functions);
  }
  return indexed;
}

export function duplicateLogicRule(
  root: string,
  source: SourceFile,
  relativePath: string,
  threshold: number,
  globs: readonly string[] = DEFAULT_UTILITY_GLOBS,
  baseline: Baseline = undefined,
): GateViolation[] {
  const index = indexUtilities(root, relativePath, [...globs, ...INTERNAL_HELPER_GLOBS]);
  const violations: GateViolation[] = sameFileDuplicates(root, source, relativePath, threshold, baseline);
  const reported = new Set(violations.map((item) => item.line));
  if (index.length === 0) return violations;
  for (const fn of functionsIn(source)) {
    if (reported.has(source.getLineAndColumnAtPos(fn.getStart()).line)) continue;
    if (isDelegation(fn)) continue;
    const print = fingerprint(fn, SHINGLE, PERMUTATIONS);
    if (print.nodeCount < MIN_TOKENS || print.exactHash === "") continue;
    let best: { entry: IndexedFunction; similarity: number } | null = null;
    for (const entry of index) {
      const exact = entry.print.exactHash === print.exactHash;
      const similarity = exact ? 1 : jaccardSimilarity(print.shingles, entry.print.shingles);
      if (similarity < threshold) continue;
      if (index.length > 500 && !exact && !shareBand(print.minHashSignature, entry.print.minHashSignature)) continue;
      if (!best || similarity > best.similarity) best = { entry, similarity };
    }
    if (!best) continue;
    const pos = source.getLineAndColumnAtPos(fn.getStart());
    const specifier = best.entry.relativePath;
    violations.push(
      gateViolation({
        rule: "DuplicateLogicRule",
        code: "DUPLICATE_LOGIC",
        file: relativePath,
        line: pos.line,
        column: pos.column,
        similarity: Number(best.similarity.toFixed(3)),
        message: `Function '${functionName(fn)}' matches exported '${best.entry.name}' (Jaccard ${best.similarity.toFixed(2)}).`,
        fix: `Import the existing function: import { ${best.entry.name} } from "${specifier}".`,
      }),
    );
  }
  return violations;
}

/** A body that is one call to another function (`return kebabCase(str, ".")`) reuses code; it is not a copy. */
export function isDelegation(fn: FunctionLikeNode): boolean {
  const body = fn.getBody();
  if (!body) return false;
  let expression: Node | undefined;
  if (Node.isBlock(body)) {
    const statements = body.getStatements();
    if (statements.length !== 1) return false;
    const only = statements[0];
    if (Node.isReturnStatement(only)) expression = only.getExpression();
    else if (Node.isExpressionStatement(only)) expression = only.getExpression();
  } else expression = body;
  while (expression && (Node.isAsExpression(expression) || Node.isParenthesizedExpression(expression) || Node.isNonNullExpression(expression))) expression = expression.getExpression();
  if (!expression || !Node.isCallExpression(expression)) return false;
  // Only a plain call to another named function counts; a method chain on the input (`s.split().join()`)
  // is an implementation, not reuse.
  const callee = expression.getExpression();
  if (!Node.isIdentifier(callee)) return false;
  return expression.getArguments().every((arg) => !arg.getFirstDescendant((node) => Node.isCallExpression(node) || Node.isConditionalExpression(node)));
}

function literalValues(fn: FunctionLikeNode): string {
  const body = fn.getBody();
  if (!body) return "";
  const values: string[] = [];
  body.forEachDescendant((node) => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) values.push(`s:${node.getLiteralText()}`);
    else if (Node.isNumericLiteral(node)) values.push(`n:${node.getLiteralValue()}`);
  });
  return values.sort().join("\u0000");
}

/**
 * v0.3: a function the edit adds that copies a function already in the same file (exported or private).
 * Only new functions are judged, so near-identical legacy siblings never block. Siblings that differ only
 * in a literal (`snakeCase` vs `flatCase`: same call, different joiner) are parametric variants, not copies.
 */
function sameFileDuplicates(root: string, source: SourceFile, relativePath: string, threshold: number, baseline: Baseline): GateViolation[] {
  const before = baselineText(root, relativePath, baseline);
  if (before === null) return [];
  const old = simulateSource(relativePath, before);
  if (!old) return [];
  const existingNames = new Set(functionsIn(old).map((fn) => functionName(fn)));
  const all = functionsIn(source);
  const prints = new Map<FunctionLikeNode, SubtreeFingerprint>();
  const printOf = (fn: FunctionLikeNode): SubtreeFingerprint => {
    let hit = prints.get(fn);
    if (!hit) {
      hit = fingerprint(fn, SHINGLE, PERMUTATIONS);
      prints.set(fn, hit);
    }
    return hit;
  };
  const existing = all.filter((fn) => functionName(fn) !== "<anonymous>" && existingNames.has(functionName(fn)));
  const violations: GateViolation[] = [];
  for (const fn of all) {
    const name = functionName(fn);
    if (name === "<anonymous>" || existingNames.has(name) || isDelegation(fn)) continue;
    const print = printOf(fn);
    if (print.nodeCount < MIN_TOKENS || print.exactHash === "") continue;
    let best: { other: FunctionLikeNode; similarity: number } | null = null;
    for (const other of existing) {
      if (other === fn || other.getFirstAncestor((node) => node === fn) || fn.getFirstAncestor((node) => node === other)) continue;
      const otherPrint = printOf(other);
      if (otherPrint.nodeCount < MIN_TOKENS || otherPrint.exactHash === "") continue;
      const similarity = otherPrint.exactHash === print.exactHash ? 1 : jaccardSimilarity(print.shingles, otherPrint.shingles);
      if (similarity < threshold) continue;
      if (literalValues(fn) !== literalValues(other)) continue;
      if (!best || similarity > best.similarity) best = { other, similarity };
    }
    if (!best) continue;
    const pos = source.getLineAndColumnAtPos(fn.getStart());
    const otherName = functionName(best.other);
    violations.push(
      gateViolation({
        rule: "DuplicateLogicRule",
        code: "DUPLICATE_LOGIC",
        file: relativePath,
        line: pos.line,
        column: pos.column,
        similarity: Number(best.similarity.toFixed(3)),
        message: `Function '${name}' duplicates '${otherName}', which already exists in this file at line ${best.other.getStartLineNumber()} (Jaccard ${best.similarity.toFixed(2)}).`,
        fix: `Call the existing '${otherName}' instead of adding a copy.`,
      }),
    );
  }
  return violations;
}
