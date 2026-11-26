import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import type { FlightPlanContract } from "../../schemas/flightPlan.js";

function mismatch(name: string, pattern: string): boolean {
  return new RegExp(pattern).test(name) === false;
}

export function namingDriftRule(source: SourceFile, relativePath: string, naming: FlightPlanContract["naming"]): GateViolation[] {
  const violations: GateViolation[] = [];
  const push = (name: string, kind: string, pattern: string, line: number, column: number): void => {
    if (name.startsWith("_")) return;
    if (!mismatch(name, pattern)) return;
    violations.push(
      gateViolation({
        rule: "NamingDriftRule",
        code: "NAMING_DRIFT",
        file: relativePath,
        line,
        column,
        message: `${kind} '${name}' does not match ${pattern}.`,
        fix: `Rename '${name}' so it matches ${pattern}.`,
      }),
    );
  };

  for (const fn of source.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const pos = source.getLineAndColumnAtPos(fn.getNameNode()?.getStart() ?? fn.getStart());
    push(name, "Function", naming.functions, pos.line, pos.column);
  }
  for (const method of source.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
    const pos = source.getLineAndColumnAtPos(method.getNameNode().getStart());
    push(method.getName(), "Method", naming.functions, pos.line, pos.column);
  }
  for (const statement of source.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const nameNode = decl.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      const init = decl.getInitializer();
      const isFn = init != null && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
      const pos = source.getLineAndColumnAtPos(nameNode.getStart());
      push(nameNode.getText(), isFn ? "Function" : "Variable", isFn ? naming.functions : naming.variables, pos.line, pos.column);
    }
  }
  for (const node of [...source.getInterfaces(), ...source.getTypeAliases(), ...source.getClasses(), ...source.getEnums()]) {
    const name = node.getName();
    if (!name) continue;
    const pos = source.getLineAndColumnAtPos(node.getNameNode()?.getStart() ?? node.getStart());
    push(name, "Type", naming.typesAndInterfaces, pos.line, pos.column);
  }
  return violations;
}
