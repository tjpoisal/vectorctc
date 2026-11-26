import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import { gateViolation, type GateViolation } from "../../schemas/gate.js";

function functionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

function label(node: Node): string {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node) || Node.isFunctionExpression(node)) {
    return node.getName() ?? "(anonymous)";
  }
  if (Node.isArrowFunction(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) return parent.getName();
  }
  return "(anonymous)";
}

function cyclomatic(fn: Node): number {
  let score = 1;
  fn.forEachDescendant((node, traversal) => {
    if (functionLike(node)) {
      traversal.skip();
      return;
    }
    if (
      Node.isIfStatement(node) ||
      Node.isForStatement(node) ||
      Node.isForInStatement(node) ||
      Node.isForOfStatement(node) ||
      Node.isWhileStatement(node) ||
      Node.isDoStatement(node) ||
      Node.isCatchClause(node) ||
      Node.isConditionalExpression(node) ||
      Node.isCaseClause(node)
    ) {
      score += 1;
    }
    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken) score += 1;
    }
  });
  return score;
}

export function longMethodRule(source: SourceFile, relativePath: string, maxLines: number, maxComplexity: number): GateViolation[] {
  const violations: GateViolation[] = [];
  const functions: Node[] = [];
  source.forEachDescendant((node) => {
    if (functionLike(node)) functions.push(node);
  });
  for (const fn of functions) {
    const name = label(fn);
    const pos = source.getLineAndColumnAtPos(fn.getStart());
    const lines = fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
    if (lines > maxLines) {
      violations.push(
        gateViolation({
          rule: "LongMethodRule",
          code: "FUNCTION_TOO_LONG",
          file: relativePath,
          line: pos.line,
          column: pos.column,
          message: `Function '${name}' spans ${lines} lines (limit ${maxLines}).`,
          fix: `Split '${name}' so it is ${maxLines} lines or fewer.`,
        }),
      );
    }
    const score = cyclomatic(fn);
    if (score > maxComplexity) {
      violations.push(
        gateViolation({
          rule: "LongMethodRule",
          code: "COMPLEXITY",
          file: relativePath,
          line: pos.line,
          column: pos.column,
          message: `Function '${name}' has cyclomatic complexity ${score} (limit ${maxComplexity}).`,
          fix: `Simplify '${name}' until its cyclomatic complexity is ${maxComplexity} or less.`,
        }),
      );
    }
  }
  return violations;
}
