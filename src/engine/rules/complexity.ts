import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import type { DegradationConfig } from "../../config/schema.js";
import { violation, type Rule, type Violation } from "../types.js";

function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  );
}

function functionLabel(node: Node): string {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isFunctionExpression(node)
  ) {
    return node.getName() ?? "(anonymous)";
  }
  if (Node.isArrowFunction(node)) {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      const name = parent.getNameNode();
      if (Node.isIdentifier(name)) return name.getText();
    }
    if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
    return "(arrow)";
  }
  return "(anonymous)";
}

function cyclomatic(fn: Node): number {
  let score = 1;
  fn.forEachDescendant((node, traversal) => {
    if (isFunctionLike(node)) {
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
      if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken) {
        score += 1;
      }
    }
  });
  return score;
}

function collectFunctions(sourceFile: SourceFile): Node[] {
  const functions: Node[] = [];
  sourceFile.forEachDescendant((node) => {
    if (isFunctionLike(node)) functions.push(node);
  });
  return functions;
}

export function complexityViolations(
  sourceFile: SourceFile,
  relativePath: string,
  degradation: DegradationConfig,
): Violation[] {
  const lengthLimit = degradation.maxFunctionLength;
  const complexityLimit = degradation.maxCyclomaticComplexity;
  if (lengthLimit == null && complexityLimit == null) return [];
  const violations: Violation[] = [];
  for (const fn of collectFunctions(sourceFile)) {
    const name = functionLabel(fn);
    const pos = sourceFile.getLineAndColumnAtPos(fn.getStart());
    const length = fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
    if (lengthLimit != null && length > lengthLimit) {
      violations.push(
        violation({
          code: "FUNCTION_TOO_LONG",
          rule: "maxFunctionLength",
          gate: "ast",
          file: relativePath,
          line: pos.line,
          column: pos.column,
          message: `Function "${name}" spans ${length} lines (limit ${lengthLimit}).`,
          fix: `Split "${name}" into smaller functions at or under ${lengthLimit} lines.`,
        }),
      );
    }
    if (complexityLimit != null) {
      const score = cyclomatic(fn);
      if (score > complexityLimit) {
        violations.push(
          violation({
            code: "COMPLEXITY",
            rule: "maxCyclomaticComplexity",
            gate: "ast",
            file: relativePath,
            line: pos.line,
            column: pos.column,
            message: `Function "${name}" has cyclomatic complexity ${score} (limit ${complexityLimit}).`,
            fix: `Simplify "${name}" until its cyclomatic complexity is ${complexityLimit} or less.`,
          }),
        );
      }
    }
  }
  return violations;
}

export const complexityRule: Rule = {
  id: "complexity",
  gate: "ast",
  order: 50,
  check(ctx) {
    if (!ctx.sourceFile) return [];
    return complexityViolations(ctx.sourceFile, ctx.relativePath, ctx.config.degradation);
  },
};
