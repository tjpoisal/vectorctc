import { Node, SyntaxKind, type BinaryExpression, type CallExpression, type Project, type SourceFile } from "ts-morph";

import { simulateSource } from "../../engine/simulate.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";
import { diffLines } from "../diff.js";
import { referencesTo } from "../references.js";

/**
 * ConventionDriftRule (v0.3). Deterministic checks for semantic changes that keep the same types:
 *
 * 1. Units. Values are tagged with a unit from conventions the code already uses: identifier suffixes
 *    (`…Cents`, `…Ms`, `DAY_MS`, `…Seconds`), `Date#getTime()` / `Date.now()` (milliseconds), well-known
 *    duration constants (86 400 = seconds per day, 86 400 000 = milliseconds per day), the pre-edit JSDoc of
 *    the function ("in cents") and simple data flow through local variables. A changed line that mixes
 *    units (seconds added to milliseconds), returns a different unit than the function documented before
 *    the edit (cents -> dollars), or passes one unit to a parameter named for another, is held.
 * 2. Boundary comparisons. A comparison whose operands are unchanged but whose strictness flipped
 *    (`<` <-> `<=`, `>` <-> `>=`) inside the same function is held when that function is observable:
 *    exported or used by call sites / tests (they are named in the message), unless the task asks for a
 *    boundary change.
 *
 * Only lines the edit adds or modifies are reported, so legacy code never blocks.
 */

type Unit = "ms" | "s" | "cents" | "dollars";
type Dimension = "time" | "money";

const DIMENSION: Record<Unit, Dimension> = { ms: "time", s: "time", cents: "money", dollars: "money" };
const UNIT_LABEL: Record<Unit, string> = { ms: "milliseconds", s: "seconds", cents: "cents", dollars: "dollars" };

const NAME_UNITS: Array<[RegExp, Unit]> = [
  [/^(?:ms|millis|milliseconds)$/, "ms"],
  [/[a-z0-9](?:Ms|Millis|Milliseconds)$/, "ms"],
  [/^[A-Z0-9_]*_(?:MS|MILLIS|MILLISECONDS)$/, "ms"],
  [/^(?:seconds|secs)$/, "s"],
  [/[a-z0-9](?:Seconds|Secs)$/, "s"],
  [/^[A-Z0-9_]*_(?:SECONDS|SECS)$/, "s"],
  [/^cents$/, "cents"],
  [/[a-z0-9]Cents$/, "cents"],
  [/^[A-Z0-9_]*_CENTS$/, "cents"],
  [/^dollars$/, "dollars"],
  [/[a-z0-9]Dollars$/, "dollars"],
  [/^[A-Z0-9_]*_DOLLARS$/, "dollars"],
];

/** Seconds in a minute is ambiguous (60 also converts minutes to hours), so it is not a duration tag. */
const SECONDS_CONSTANTS = new Set([3600, 86400, 604800]);
const MS_CONSTANTS = new Set([60000, 3600000, 86400000, 604800000]);

const BOUNDARY_WORDS = /inclusive|exclusive|boundar|off[- ]by[- ]one|<=|>=|or equal|at least|at most|strict|exactly|edge case/i;
const UNIT_CHANGE_WORDS: Record<Unit, RegExp> = {
  ms: /millisecond|\bms\b/i,
  s: /\bseconds?\b/i,
  cents: /\bcents?\b/i,
  dollars: /\bdollars?\b/i,
};

export function unitFromName(name: string): Unit | null {
  for (const [pattern, unit] of NAME_UNITS) if (pattern.test(name)) return unit;
  return null;
}

export function unitFromDoc(text: string): Unit | null {
  const found = new Set<Unit>();
  if (/\b(?:in|as|of) cents\b|\bcents\b/i.test(text)) found.add("cents");
  if (/\bdollars\b/i.test(text)) found.add("dollars");
  if (/\bmilliseconds?\b|\bin ms\b/i.test(text)) found.add("ms");
  if (/\bin seconds\b/i.test(text)) found.add("s");
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

function literalValue(node: Node): number | null {
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (Node.isParenthesizedExpression(node)) return literalValue(node.getExpression());
  if (Node.isBinaryExpression(node)) {
    const left = literalValue(node.getLeft());
    const right = literalValue(node.getRight());
    if (left === null || right === null) return null;
    switch (node.getOperatorToken().getKind()) {
      case SyntaxKind.AsteriskToken:
        return left * right;
      case SyntaxKind.SlashToken:
        return right === 0 ? null : left / right;
      case SyntaxKind.PlusToken:
        return left + right;
      case SyntaxKind.MinusToken:
        return left - right;
      default:
        return null;
    }
  }
  return null;
}

function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    if (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isNonNullExpression(current) || Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

function multiplicativeFactors(node: Node, out: Node[]): void {
  const inner = unwrap(node);
  if (Node.isBinaryExpression(inner) && inner.getOperatorToken().getKind() === SyntaxKind.AsteriskToken) {
    multiplicativeFactors(inner.getLeft(), out);
    multiplicativeFactors(inner.getRight(), out);
    return;
  }
  out.push(inner);
}

function docUnitOfDeclaration(node: Node): Unit | null {
  const holder = Node.isVariableDeclaration(node) ? node.getVariableStatement() : node;
  if (holder && Node.isJSDocable(holder)) {
    const text = holder
      .getJsDocs()
      .map((doc) => doc.getDescription())
      .join(" ");
    return unitFromDoc(text);
  }
  return null;
}

interface UnitContext {
  depth: number;
}

/** Unit of an expression, or null when nothing in the code says what it is. */
export function unitOf(node: Node, ctx: UnitContext = { depth: 0 }): Unit | null {
  if (ctx.depth > 5) return null;
  const next = { depth: ctx.depth + 1 };
  const inner = unwrap(node);
  if (Node.isNumericLiteral(inner)) return null;
  if (Node.isIdentifier(inner)) return identifierUnit(inner, next);
  if (Node.isPropertyAccessExpression(inner)) return unitFromName(inner.getName());
  if (Node.isElementAccessExpression(inner)) return unitOf(inner.getExpression(), next);
  if (Node.isCallExpression(inner)) return callUnit(inner, next);
  if (Node.isConditionalExpression(inner)) {
    const a = unitOf(inner.getWhenTrue(), next);
    const b = unitOf(inner.getWhenFalse(), next);
    return a !== null && a === b ? a : (a ?? b);
  }
  if (Node.isPrefixUnaryExpression(inner)) return unitOf(inner.getOperand(), next);
  if (Node.isBinaryExpression(inner)) return binaryUnit(inner, next);
  return null;
}

function identifierUnit(node: Node, ctx: UnitContext): Unit | null {
  const named = unitFromName(node.getText());
  if (named) return named;
  let declarations: Node[] = [];
  try {
    declarations = node.getSymbol()?.getDeclarations() ?? [];
  } catch {
    declarations = [];
  }
  for (const declaration of declarations) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const doc = docUnitOfDeclaration(declaration);
    if (doc) return doc;
    const init = declaration.getInitializer();
    const fromInit = init ? unitOf(init, ctx) : null;
    if (fromInit) return fromInit;
    // `let total = 0; total += item.priceCents` — take the unit of what is accumulated into it.
    const scope = declaration.getFirstAncestor((item) => Node.isBlock(item) || Node.isSourceFile(item));
    if (!scope) continue;
    for (const assignment of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const kind = assignment.getOperatorToken().getKind();
      if (kind !== SyntaxKind.EqualsToken && kind !== SyntaxKind.PlusEqualsToken && kind !== SyntaxKind.MinusEqualsToken) continue;
      if (assignment.getLeft().getText() !== node.getText()) continue;
      const unit = unitOf(assignment.getRight(), ctx);
      if (unit) return unit;
    }
  }
  return null;
}

function callUnit(call: CallExpression, ctx: UnitContext): Unit | null {
  const callee = call.getExpression();
  const text = callee.getText();
  if (text === "Date.now" || text === "performance.now") return "ms";
  if (Node.isPropertyAccessExpression(callee) && (callee.getName() === "getTime" || callee.getName() === "valueOf") && text !== "valueOf") {
    if (callee.getName() === "getTime") return "ms";
  }
  if (/^Math\.(round|floor|ceil|abs|trunc|max|min)$/.test(text) || text === "Number") {
    const first = call.getArguments()[0];
    return first ? unitOf(first, ctx) : null;
  }
  const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : Node.isIdentifier(callee) ? callee.getText() : null;
  if (name) {
    const named = unitFromName(name);
    if (named) return named;
  }
  // Learned from the callee's own documentation, e.g. "Total of all line items, in cents."
  try {
    const symbol = callee.getSymbol();
    const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    for (const declaration of target?.getDeclarations() ?? []) {
      const doc = docUnitOfDeclaration(declaration);
      if (doc) return doc;
    }
  } catch {
    return null;
  }
  return null;
}

function binaryUnit(node: BinaryExpression, ctx: UnitContext): Unit | null {
  const kind = node.getOperatorToken().getKind();
  if (kind === SyntaxKind.AsteriskToken) {
    const factors: Node[] = [];
    multiplicativeFactors(node, factors);
    let product = 1;
    let literal = false;
    const units: Unit[] = [];
    for (const factor of factors) {
      const value = literalValue(factor);
      if (value !== null) {
        product *= value;
        literal = true;
        continue;
      }
      const unit = unitOf(factor, ctx);
      if (unit) units.push(unit);
    }
    if (units.length > 1) return null;
    const unit = units[0] ?? null;
    if (unit === null) {
      if (!literal) return null;
      if (SECONDS_CONSTANTS.has(product)) return "s";
      if (MS_CONSTANTS.has(product)) return "ms";
      return null;
    }
    if (unit === "s" && product === 1000) return "ms";
    if (unit === "dollars" && product === 100) return "cents";
    return unit;
  }
  if (kind === SyntaxKind.SlashToken) {
    const left = unitOf(node.getLeft(), ctx);
    const divisor = literalValue(node.getRight());
    if (left === "ms" && divisor === 1000) return "s";
    if (left === "cents" && divisor === 100) return "dollars";
    if (divisor !== null) return left;
    return null;
  }
  if (kind === SyntaxKind.PlusToken || kind === SyntaxKind.MinusToken || kind === SyntaxKind.PercentToken) {
    const left = unitOf(node.getLeft(), ctx);
    const right = kind === SyntaxKind.PercentToken ? null : unitOf(node.getRight(), ctx);
    if (left && right && left !== right) return null;
    return left ?? right;
  }
  return null;
}

function enclosingFunctionName(node: Node): string | null {
  for (const ancestor of node.getAncestors()) {
    if (Node.isFunctionDeclaration(ancestor)) return ancestor.getName() ?? null;
    if (Node.isMethodDeclaration(ancestor) || Node.isGetAccessorDeclaration(ancestor) || Node.isSetAccessorDeclaration(ancestor)) {
      const owner = ancestor.getParent();
      const cls = Node.isClassDeclaration(owner) ? owner.getName() : undefined;
      return cls ? `${cls}.${ancestor.getName()}` : ancestor.getName();
    }
    if ((Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) && Node.isVariableDeclaration(ancestor.getParent())) {
      return ancestor.getParentOrThrow().asKindOrThrow(SyntaxKind.VariableDeclaration).getName();
    }
  }
  return null;
}

function functionNode(node: Node): Node | null {
  for (const ancestor of node.getAncestors()) {
    if (Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor) || Node.isGetAccessorDeclaration(ancestor)) return ancestor;
    if ((Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) && Node.isVariableDeclaration(ancestor.getParent())) {
      return ancestor.getParentOrThrow();
    }
  }
  return null;
}

/** Documented unit of each function in a file, keyed by enclosing name: JSDoc first, then the name. */
function documentedUnits(source: SourceFile): Map<string, Unit> {
  const out = new Map<string, Unit>();
  for (const fn of source.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const unit = docUnitOfDeclaration(fn) ?? unitFromName(name);
    if (unit) out.set(name, unit);
  }
  for (const statement of source.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const init = declaration.getInitializer();
      if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) continue;
      const unit = docUnitOfDeclaration(declaration) ?? unitFromName(declaration.getName());
      if (unit) out.set(declaration.getName(), unit);
    }
  }
  for (const cls of source.getClasses()) {
    for (const method of cls.getMethods()) {
      const unit = docUnitOfDeclaration(method) ?? unitFromName(method.getName());
      if (unit) out.set(`${cls.getName() ?? ""}.${method.getName()}`, unit);
    }
  }
  return out;
}

function sinkUnit(target: Node): Unit | null {
  const inner = unwrap(target);
  if (Node.isIdentifier(inner)) return unitFromName(inner.getText());
  if (Node.isPropertyAccessExpression(inner)) return unitFromName(inner.getName());
  return null;
}

function parameterUnits(call: CallExpression): Array<Unit | null> {
  const callee = call.getExpression();
  const text = callee.getText();
  if (text === "setTimeout" || text === "setInterval") return [null, "ms"];
  try {
    const symbol = callee.getSymbol();
    const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    for (const declaration of target?.getDeclarations() ?? []) {
      const fn = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
      if (fn && (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
        return fn.getParameters().map((param) => {
          const nameNode = param.getNameNode();
          return Node.isIdentifier(nameNode) ? unitFromName(nameNode.getText()) : null;
        });
      }
    }
  } catch {
    return [];
  }
  return [];
}

interface Finding {
  line: number;
  column: number;
  code: string;
  message: string;
  fix: string;
}

function snippet(node: Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

function unitFindings(source: SourceFile, changed: Set<number>, beforeDocs: Map<string, Unit>, objective: string): Finding[] {
  const findings: Finding[] = [];
  const onChanged = (node: Node): boolean => changed.has(node.getStartLineNumber()) || changed.has(node.getEndLineNumber());
  const push = (node: Node, code: string, message: string, fix: string): void => {
    const pos = source.getLineAndColumnAtPos(node.getStart());
    if (findings.some((item) => item.line === pos.line && item.code === code)) return;
    findings.push({ line: pos.line, column: pos.column, code, message, fix });
  };
  const asked = (unit: Unit): boolean => UNIT_CHANGE_WORDS[unit].test(objective);

  for (const binary of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!onChanged(binary)) continue;
    const kind = binary.getOperatorToken().getKind();
    const additive = [SyntaxKind.PlusToken, SyntaxKind.MinusToken, SyntaxKind.LessThanToken, SyntaxKind.LessThanEqualsToken, SyntaxKind.GreaterThanToken, SyntaxKind.GreaterThanEqualsToken, SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken].includes(kind);
    if (additive) {
      const left = unitOf(binary.getLeft());
      const right = unitOf(binary.getRight());
      if (left && right && left !== right && DIMENSION[left] === DIMENSION[right]) {
        push(
          binary,
          "UNIT_MISMATCH",
          `Unit mismatch: '${snippet(binary.getLeft())}' is in ${UNIT_LABEL[left]} but '${snippet(binary.getRight())}' is in ${UNIT_LABEL[right]}.`,
          `Convert one side so both are in ${UNIT_LABEL[left]}${DIMENSION[left] === "time" ? " (x1000 between seconds and milliseconds)" : " (x100 between dollars and cents)"}.`,
        );
      }
      continue;
    }
    if (kind === SyntaxKind.EqualsToken || kind === SyntaxKind.PlusEqualsToken || kind === SyntaxKind.MinusEqualsToken) {
      const target = sinkUnit(binary.getLeft());
      const value = unitOf(binary.getRight());
      if (target && value && target !== value && DIMENSION[target] === DIMENSION[value]) {
        push(binary, "UNIT_MISMATCH", `'${snippet(binary.getLeft())}' holds ${UNIT_LABEL[target]} but is assigned ${UNIT_LABEL[value]} ('${snippet(binary.getRight())}').`, `Assign a value in ${UNIT_LABEL[target]}.`);
      }
    }
  }

  for (const declaration of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = declaration.getInitializer();
    if (!init || !onChanged(declaration)) continue;
    const target = unitFromName(declaration.getName());
    const value = unitOf(init);
    if (target && value && target !== value && DIMENSION[target] === DIMENSION[value]) {
      push(declaration, "UNIT_MISMATCH", `'${declaration.getName()}' is named for ${UNIT_LABEL[target]} but is set to ${UNIT_LABEL[value]} ('${snippet(init)}').`, `Keep '${declaration.getName()}' in ${UNIT_LABEL[target]}, or rename it.`);
    }
  }

  for (const property of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const init = property.getInitializer();
    if (!init || !onChanged(property)) continue;
    const target = unitFromName(property.getName());
    const value = unitOf(init);
    if (target && value && target !== value && DIMENSION[target] === DIMENSION[value]) {
      push(property, "UNIT_MISMATCH", `Field '${property.getName()}' is ${UNIT_LABEL[target]} but gets ${UNIT_LABEL[value]} ('${snippet(init)}').`, `Pass a value in ${UNIT_LABEL[target]}.`);
    }
  }

  for (const statement of source.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expression = statement.getExpression();
    if (!expression || !onChanged(statement)) continue;
    const name = enclosingFunctionName(statement);
    if (!name) continue;
    const fn = functionNode(statement);
    // The convention is learned from the function as it was before the edit (its JSDoc or name), so
    // dropping "in cents" from the comment in the same edit does not hide the change.
    const expected = beforeDocs.get(name) ?? (fn ? (docUnitOfDeclaration(fn) ?? unitFromName(name.split(".").pop() ?? name)) : null);
    const actual = unitOf(expression);
    if (!expected || !actual || expected === actual || DIMENSION[expected] !== DIMENSION[actual] || asked(actual)) continue;
    push(
      statement,
      "UNIT_CHANGE",
      `'${name}' ${beforeDocs.has(name) ? "was documented to return" : "returns"} ${UNIT_LABEL[expected]}, but this edit makes it return ${UNIT_LABEL[actual]} ('${snippet(expression)}'). Callers keep the same types, so nothing else fails.`,
      `Keep '${name}' returning ${UNIT_LABEL[expected]}, or add a separately named function for ${UNIT_LABEL[actual]}.`,
    );
  }

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!onChanged(call)) continue;
    const params = parameterUnits(call);
    call.getArguments().forEach((arg, index) => {
      const expected = params[index] ?? null;
      const actual = unitOf(arg);
      if (!expected || !actual || expected === actual || DIMENSION[expected] !== DIMENSION[actual]) return;
      push(arg, "UNIT_MISMATCH", `'${snippet(call.getExpression())}' expects ${UNIT_LABEL[expected]} for argument ${index + 1}, but '${snippet(arg)}' is in ${UNIT_LABEL[actual]}.`, `Convert the argument to ${UNIT_LABEL[expected]}.`);
    });
  }
  return findings;
}

const RELATIONAL = new Map<SyntaxKind, { op: string; strict: boolean; flipped: boolean }>([
  [SyntaxKind.LessThanToken, { op: "<", strict: true, flipped: false }],
  [SyntaxKind.LessThanEqualsToken, { op: "<=", strict: false, flipped: false }],
  [SyntaxKind.GreaterThanToken, { op: ">", strict: true, flipped: true }],
  [SyntaxKind.GreaterThanEqualsToken, { op: ">=", strict: false, flipped: true }],
]);

interface Comparison {
  fn: string;
  lhs: string;
  rhs: string;
  strict: boolean;
  op: string;
  line: number;
  column: number;
  text: string;
}

function normalizeOperand(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/\.(?:getTime|valueOf)\(\)/g, "")
    .replace(/^Number\((.*)\)$/, "$1")
    .replace(/^\((.*)\)$/, "$1");
}

function comparisons(source: SourceFile): Comparison[] {
  const out: Comparison[] = [];
  for (const binary of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const info = RELATIONAL.get(binary.getOperatorToken().getKind());
    if (!info) continue;
    const fn = enclosingFunctionName(binary) ?? "<module>";
    const left = normalizeOperand(binary.getLeft().getText());
    const right = normalizeOperand(binary.getRight().getText());
    const pos = source.getLineAndColumnAtPos(binary.getOperatorToken().getStart());
    out.push({ fn, lhs: info.flipped ? right : left, rhs: info.flipped ? left : right, strict: info.strict, op: info.op, line: pos.line, column: pos.column, text: binary.getText().replace(/\s+/g, " ") });
  }
  return out;
}

function key(item: Pick<Comparison, "fn" | "lhs" | "rhs" | "strict">): string {
  return `${item.fn}\u0000${item.lhs}\u0000${item.rhs}\u0000${item.strict ? "<" : "<="}`;
}

function count(items: Comparison[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}

function isExportedName(source: SourceFile, fn: string): boolean {
  const top = fn.split(".")[0] ?? fn;
  return source.getExportedDeclarations().has(top);
}

function boundaryFindings(root: string, project: Project | null, relativePath: string, source: SourceFile, before: SourceFile, changed: Set<number>, objective: string): Finding[] {
  if (BOUNDARY_WORDS.test(objective)) return [];
  const old = comparisons(before);
  const now = comparisons(source);
  const oldCount = count(old);
  const newCount = count(now);
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const item of now) {
    if (!changed.has(item.line)) continue;
    const k = key(item);
    if ((newCount.get(k) ?? 0) <= (oldCount.get(k) ?? 0)) continue;
    const flipped = key({ ...item, strict: !item.strict });
    if ((oldCount.get(flipped) ?? 0) <= (newCount.get(flipped) ?? 0)) continue;
    if (reported.has(k)) continue;
    reported.add(k);
    const previous = old.find((candidate) => key(candidate) === flipped);
    const member = item.fn.split(".").pop() ?? item.fn;
    const refs = item.fn === "<module>" ? [] : referencesTo(root, project, relativePath, member, 6);
    const inFile = item.fn === "<module>" ? 0 : Math.max(0, (source.getFullText().match(new RegExp(`(?<![\\w$])${member.replace(/[$]/g, "\\$")}\\(`, "g"))?.length ?? 0) - 1);
    const exported = item.fn !== "<module>" && isExportedName(source, item.fn);
    if (!exported && refs.length === 0 && inFile === 0) continue;
    const tests = refs.filter((ref) => ref.test);
    const callers = refs.filter((ref) => !ref.test);
    const evidence = [
      callers.length ? `call sites ${callers.slice(0, 3).map((ref) => `${ref.file}:${ref.line}`).join(", ")}` : "",
      tests.length ? `tests ${[...new Set(tests.map((ref) => ref.file))].slice(0, 3).join(", ")}` : "",
      inFile ? `${inFile} use${inFile === 1 ? "" : "s"} in this file` : "",
      exported && !callers.length ? "exported (public API)" : "",
    ].filter(Boolean);
    findings.push({
      line: item.line,
      column: item.column,
      code: "BOUNDARY_FLIP",
      message: `Comparison strictness flipped in '${item.fn}': '${previous?.text ?? `${item.lhs} ${item.strict ? "<=" : "<"} ${item.rhs}`}' became '${item.text}'. Values equal at the boundary now take the other branch (off-by-one). Relied on by: ${evidence.join("; ")}.`,
      fix: `Restore '${previous?.op ?? (item.strict ? "<=" : "<")}' or, if the boundary change is intended, say so in the flight plan objective and update the tests.`,
    });
  }
  return findings;
}

export function conventionDriftRule(root: string, source: SourceFile, project: Project | null, relativePath: string, baseline: Baseline, objective = ""): GateViolation[] {
  const before = baselineText(root, relativePath, baseline);
  const after = source.getFullText();
  if (before === after) return [];
  const { changedNewLines } = diffLines(before, after);
  if (changedNewLines.size === 0) return [];
  const beforeSource = before === null ? null : simulateSource(relativePath, before);
  const beforeDocs = beforeSource ? documentedUnits(beforeSource) : new Map<string, Unit>();
  const findings = [...unitFindings(source, changedNewLines, beforeDocs, objective)];
  if (beforeSource) findings.push(...boundaryFindings(root, project, relativePath, source, beforeSource, changedNewLines, objective));
  return findings.map((item) =>
    gateViolation({
      rule: "ConventionDriftRule",
      code: item.code,
      file: relativePath,
      line: item.line,
      column: item.column,
      message: item.message,
      fix: item.fix,
    }),
  );
}
