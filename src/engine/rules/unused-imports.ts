import { Node, type ImportDeclaration, type SourceFile } from "ts-morph";

import { violation, type Rule, type Violation } from "../types.js";

interface Binding {
  name: string;
  line: number;
  column: number;
}

function countIdentifier(text: string, name: string, start: number, end: number): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "gu");
  let count = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index >= start && index < end) continue;
    count += 1;
  }
  return count;
}

function bindingsOf(sourceFile: SourceFile, statement: ImportDeclaration): Binding[] {
  const bindings: Binding[] = [];
  const push = (nameNode: Node | undefined): void => {
    if (!nameNode || !Node.isIdentifier(nameNode)) return;
    const pos = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
    bindings.push({ name: nameNode.getText(), line: pos.line, column: pos.column });
  };
  push(statement.getDefaultImport());
  push(statement.getNamespaceImport());
  for (const named of statement.getNamedImports()) {
    push(named.getAliasNode() ?? named.getNameNode());
  }
  return bindings;
}

export function unusedImportViolations(sourceFile: SourceFile, relativePath: string): Violation[] {
  const text = sourceFile.getFullText();
  const violations: Violation[] = [];
  for (const statement of sourceFile.getImportDeclarations()) {
    const bindings = bindingsOf(sourceFile, statement);
    if (bindings.length === 0) continue;
    const start = statement.getStart();
    const end = statement.getEnd();
    for (const binding of bindings) {
      if (countIdentifier(text, binding.name, start, end) > 0) continue;
      violations.push(
        violation({
          code: "UNUSED_IMPORT",
          rule: "unusedImports",
          gate: "ast",
          file: relativePath,
          line: binding.line,
          column: binding.column,
          message: `Import "${binding.name}" is unused.`,
          fix: `Remove the unused import "${binding.name}".`,
        }),
      );
    }
  }
  return violations;
}

export const unusedImportRule: Rule = {
  id: "unusedImports",
  gate: "ast",
  order: 60,
  check(ctx) {
    if (!ctx.sourceFile || !ctx.config.degradation.flagUnusedImports) return [];
    return unusedImportViolations(ctx.sourceFile, ctx.relativePath);
  },
};
