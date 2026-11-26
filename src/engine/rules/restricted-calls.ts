import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import type { CallRule } from "../../config/schema.js";
import { pathMatches } from "../match.js";
import { violation, type Rule, type Violation } from "../types.js";

interface CallHit {
  callee: string;
  line: number;
  column: number;
}

function calleeText(expression: Node): string | null {
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getText().replace(/\?\./g, ".");
  return null;
}

function callMatches(callee: string, rule: string): boolean {
  if (callee === rule) return true;
  if (!rule.includes(".") && (callee === rule || callee.endsWith(`.${rule}`))) return true;
  return false;
}

function pathInRule(relativePath: string, inPaths: readonly string[]): boolean {
  return inPaths.some((pattern) => pattern === "**" || pattern === "**/*" || pathMatches(relativePath, pattern));
}

function collectCalls(sourceFile: SourceFile): CallHit[] {
  const hits: CallHit[] = [];
  const visit = (expression: Node, site: Node): void => {
    const callee = calleeText(expression);
    if (!callee) return;
    const pos = sourceFile.getLineAndColumnAtPos(site.getStart());
    hits.push({ callee, line: pos.line, column: pos.column });
  };
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) continue;
    visit(call.getExpression(), call);
  }
  for (const construct of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    visit(construct.getExpression(), construct);
  }
  return hits;
}

export function restrictedCallViolations(
  sourceFile: SourceFile,
  relativePath: string,
  rules: readonly CallRule[],
): Violation[] {
  if (rules.length === 0) return [];
  const violations: Violation[] = [];
  for (const hit of collectCalls(sourceFile)) {
    const rule = rules.find((entry) => pathInRule(relativePath, entry.inPaths) && callMatches(hit.callee, entry.callPattern));
    if (!rule) continue;
    violations.push(
      violation({
        code: "RESTRICTED_CALL",
        rule: "restrictedCalls",
        gate: "ast",
        file: relativePath,
        line: hit.line,
        column: hit.column,
        message: `Call to "${hit.callee}" is restricted. Use ${rule.useInstead} instead.`,
        fix: `Replace "${rule.callPattern}" with ${rule.useInstead}.`,
        useInstead: rule.useInstead,
      }),
    );
  }
  return violations;
}

export const restrictedCallRule: Rule = {
  id: "restrictedCalls",
  gate: "ast",
  order: 40,
  check(ctx) {
    if (!ctx.sourceFile) return [];
    return restrictedCallViolations(ctx.sourceFile, ctx.relativePath, ctx.config.restrictedCalls);
  },
};
