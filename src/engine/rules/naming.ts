import { Node, SyntaxKind, type Node as MorphNode, type SourceFile } from "ts-morph";

import { compileSafeRegExp } from "../safe-regex.js";
import { violation, type Rule, type Violation } from "../types.js";

function callsHook(node: MorphNode): boolean {
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const name = Node.isIdentifier(expr) ? expr.getText() : Node.isPropertyAccessExpression(expr) ? expr.getName() : "";
    if (/^use[A-Z]/.test(name)) return true;
  }
  return false;
}

function isPascalComponent(name: string, filePath: string): boolean {
  return /\.(tsx|jsx)$/.test(filePath) && /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function functionNodes(sourceFile: SourceFile): Array<{ name: string; line: number; column: number; node: MorphNode }> {
  const found: Array<{ name: string; line: number; column: number; node: MorphNode }> = [];
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const pos = sourceFile.getLineAndColumnAtPos(fn.getNameNode()?.getStart() ?? fn.getStart());
    found.push({ name, line: pos.line, column: pos.column, node: fn });
  }
  for (const method of sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
    const name = method.getName();
    const pos = sourceFile.getLineAndColumnAtPos(method.getNameNode()?.getStart() ?? method.getStart());
    found.push({ name, line: pos.line, column: pos.column, node: method });
  }
  for (const statement of sourceFile.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init))) continue;
      if (!Node.isIdentifier(decl.getNameNode())) continue;
      const name = decl.getName();
      const pos = sourceFile.getLineAndColumnAtPos(decl.getNameNode().getStart());
      found.push({ name, line: pos.line, column: pos.column, node: init });
    }
  }
  return found;
}

export const namingRule: Rule = {
  id: "naming",
  gate: "ast",
  order: 70,
  check(ctx) {
    const naming = ctx.config.rules.naming;
    if (!ctx.sourceFile) return [];
    if (!naming.enabled && !naming.customHookPrefix) return [];
    const violations: Violation[] = [];
    const functionPattern = naming.enabled ? compileSafeRegExp(naming.functions) : null;
    const typePattern = naming.enabled ? compileSafeRegExp(naming.typesAndInterfaces) : null;
    const variablePattern = naming.enabled ? compileSafeRegExp(naming.variables) : null;
    const functionNames = new Set<string>();

    for (const fn of functionNodes(ctx.sourceFile)) {
      functionNames.add(fn.name);
      if (isPascalComponent(fn.name, ctx.relativePath)) continue;
      if (functionPattern && !functionPattern.test(fn.name)) {
        violations.push(
          violation({
            code: "NAMING_DRIFT",
            rule: "naming",
            gate: "ast",
            file: ctx.relativePath,
            line: fn.line,
            column: fn.column,
            message: `Function '${fn.name}' does not match ${naming.functions}.`,
            fix: `Rename '${fn.name}' to match the function pattern.`,
            useInstead: naming.functions,
          }),
        );
      }
      if (naming.customHookPrefix && callsHook(fn.node) && !fn.name.startsWith(naming.customHookPrefix)) {
        violations.push(
          violation({
            code: "NAMING_DRIFT",
            rule: "naming",
            gate: "ast",
            file: ctx.relativePath,
            line: fn.line,
            column: fn.column,
            message: `Function '${fn.name}' calls a hook but does not start with '${naming.customHookPrefix}'.`,
            fix: `Rename '${fn.name}' so it starts with '${naming.customHookPrefix}'.`,
            useInstead: naming.customHookPrefix,
          }),
        );
      }
    }

    if (typePattern) {
      for (const node of [...ctx.sourceFile.getInterfaces(), ...ctx.sourceFile.getTypeAliases()]) {
        const name = node.getName();
        if (typePattern.test(name)) continue;
        const pos = ctx.sourceFile.getLineAndColumnAtPos(node.getNameNode()?.getStart() ?? node.getStart());
        violations.push(
          violation({
            code: "NAMING_DRIFT",
            rule: "naming",
            gate: "ast",
            file: ctx.relativePath,
            line: pos.line,
            column: pos.column,
            message: `Type '${name}' does not match ${naming.typesAndInterfaces}.`,
            fix: `Rename '${name}' to PascalCase.`,
            useInstead: naming.typesAndInterfaces,
            severity: "block",
          }),
        );
      }
    }

    if (variablePattern) {
      for (const decl of ctx.sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (!Node.isIdentifier(decl.getNameNode())) continue;
        const name = decl.getName();
        if (functionNames.has(name)) continue;
        if (variablePattern.test(name)) continue;
        const pos = ctx.sourceFile.getLineAndColumnAtPos(decl.getNameNode().getStart());
        violations.push(
          violation({
            code: "NAMING_DRIFT",
            rule: "naming",
            gate: "ast",
            file: ctx.relativePath,
            line: pos.line,
            column: pos.column,
            message: `Variable '${name}' does not match ${naming.variables}.`,
            fix: `Rename '${name}' to camelCase or UPPER_SNAKE_CASE.`,
            useInstead: naming.variables,
            severity: "warn",
          }),
        );
      }
    }
    return violations;
  },
};
