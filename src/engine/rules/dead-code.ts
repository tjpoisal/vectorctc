import fs from "node:fs";
import path from "node:path";
import { Node, type Identifier, type SourceFile, SyntaxKind } from "ts-morph";

import { simulateSource } from "../simulate.js";
import { violation, type Rule, type Violation } from "../types.js";

interface UnusedRecord {
  kind: "IMPORT" | "VARIABLE" | "PARAMETER" | "FUNCTION" | "MEMBER";
  name: string;
  line: number;
  column: number;
  fingerprint: string;
}

function countOutside(text: string, name: string, start: number, end: number): number {
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

/**
 * Private class members (TypeScript `private` or ECMAScript `#name`) that nothing in the class reads.
 * A private member can only be used inside its class, so a text search of the class body is exact
 * except for computed access (`this[name]`), which is treated as "used" to stay conservative.
 */
export function unusedPrivateMembers(sourceFile: SourceFile, allowUnderscore: boolean): UnusedRecord[] {
  const records: UnusedRecord[] = [];
  for (const cls of sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
    const classText = cls.getFullText();
    const classStart = cls.getPos();
    if (/this\[/.test(classText)) continue;
    const candidates: Array<{ nameNode: Node; name: string }> = [];
    for (const member of cls.getMembers()) {
      if (!(Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member))) continue;
      const nameNode = member.getNameNode();
      const isHash = Node.isPrivateIdentifier(nameNode);
      if (!isHash && !member.hasModifier(SyntaxKind.PrivateKeyword)) continue;
      if (Node.isMethodDeclaration(member) && member.getOverloads().length > 0 && !member.getBody()) continue;
      candidates.push({ nameNode, name: nameNode.getText() });
    }
    for (const ctor of cls.getConstructors()) {
      for (const param of ctor.getParameters()) {
        if (!param.hasModifier(SyntaxKind.PrivateKeyword)) continue;
        const nameNode = param.getNameNode();
        if (Node.isIdentifier(nameNode)) candidates.push({ nameNode, name: nameNode.getText() });
      }
    }
    for (const { nameNode, name } of candidates) {
      if (allowUnderscore && name.startsWith("_")) continue;
      const start = nameNode.getStart() - classStart;
      const end = nameNode.getEnd() - classStart;
      if (countOutside(classText, name, start, end) > 0) continue;
      // Accessor pairs share a name: the getter and setter count as one member.
      if (records.some((record) => record.name === name)) continue;
      const pos = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
      records.push({ kind: "MEMBER", name, line: pos.line, column: pos.column, fingerprint: `MEMBER:${cls.getName() ?? ""}.${name}` });
    }
  }
  return records;
}

export function collectUnused(sourceFile: SourceFile, allowUnderscore: boolean): UnusedRecord[] {
  const text = sourceFile.getFullText();
  const records: UnusedRecord[] = [];
  const push = (kind: UnusedRecord["kind"], nameNode: Identifier | undefined): void => {
    if (!nameNode) return;
    const name = nameNode.getText();
    if (allowUnderscore && name.startsWith("_")) return;
    const start = nameNode.getStart();
    const end = nameNode.getEnd();
    if (countOutside(text, name, start, end) > 0) return;
    const pos = sourceFile.getLineAndColumnAtPos(start);
    records.push({ kind, name, line: pos.line, column: pos.column, fingerprint: `${kind}:${name}` });
  };

  for (const statement of sourceFile.getImportDeclarations()) {
    if (!statement.getImportClause()) continue;
    push("IMPORT", statement.getDefaultImport());
    push("IMPORT", statement.getNamespaceImport());
    for (const named of statement.getNamedImports()) {
      const alias = named.getAliasNode();
      const imported = named.getNameNode();
      push("IMPORT", alias ?? (Node.isIdentifier(imported) ? imported : undefined));
    }
  }
  for (const statement of sourceFile.getVariableStatements()) {
    if (statement.isExported()) continue;
    for (const decl of statement.getDeclarations()) {
      const nameNode = decl.getNameNode();
      if (Node.isIdentifier(nameNode)) push("VARIABLE", nameNode);
    }
  }
  for (const fn of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ]) {
    if (!fn.getBody()) continue;
    for (const param of fn.getParameters()) {
      if (!Node.isIdentifier(param.getNameNode())) continue;
      const body = fn.getBody();
      if (!body) continue;
      const name = param.getName();
      if (allowUnderscore && name.startsWith("_")) continue;
      if (countOutside(body.getFullText(), name, -1, -1) > 0) continue;
      const pos = sourceFile.getLineAndColumnAtPos(param.getNameNode().getStart());
      records.push({ kind: "PARAMETER", name, line: pos.line, column: pos.column, fingerprint: `PARAMETER:${name}` });
    }
  }
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported()) continue;
    push("FUNCTION", fn.getNameNode());
  }
  records.push(...unusedPrivateMembers(sourceFile, allowUnderscore));

  // TS6133/6192/6196 only exist when the project asks for them; skipping the type-check otherwise is
  // the same result for a fraction of the cost (the in-memory baseline parse never sets these options).
  const options = sourceFile.getProject().getCompilerOptions();
  let diagnostics: ReturnType<SourceFile["getPreEmitDiagnostics"]> = [];
  if (options.noUnusedLocals || options.noUnusedParameters) {
    try {
      diagnostics = sourceFile.getPreEmitDiagnostics();
    } catch {
      diagnostics = [];
    }
  }
  for (const diagnostic of diagnostics) {
    const code = diagnostic.getCode();
    if (code !== 6133 && code !== 6192 && code !== 6196) continue;
    const message = diagnostic.getMessageText();
    const flat = typeof message === "string" ? message : message.getMessageText();
    const quoted = flat.match(/'([^']+)'/);
    const name = quoted?.[1];
    if (!name) continue;
    if (allowUnderscore && name.startsWith("_")) continue;
    if (records.some((record) => record.name === name)) continue;
    const start = diagnostic.getStart() ?? 0;
    const pos = sourceFile.getLineAndColumnAtPos(start);
    const kind = code === 6192 || code === 6196 ? "IMPORT" : "VARIABLE";
    records.push({ kind, name, line: pos.line, column: pos.column, fingerprint: `${kind}:${name}` });
  }
  return records;
}

function baselineFingerprints(root: string, relativePath: string, allowUnderscore: boolean): Set<string> {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return new Set();
  const content = fs.readFileSync(absolute, "utf8");
  const source = simulateSource(relativePath, content);
  if (!source) return new Set();
  return new Set(collectUnused(source, allowUnderscore).map((record) => record.fingerprint));
}

export const deadCodeRule: Rule = {
  id: "deadCode",
  gate: "ast",
  order: 100,
  check(ctx): Violation[] {
    const settings = ctx.config.rules.deadCode;
    if (!settings.enabled || !ctx.sourceFile) return [];
    const proposed = collectUnused(ctx.sourceFile, settings.allowUnderscorePrefix);
    if (proposed.length === 0) return [];
    const baseline = baselineFingerprints(ctx.root, ctx.relativePath, settings.allowUnderscorePrefix);
    return proposed
      .filter((record) => !baseline.has(record.fingerprint))
      .map((record) =>
        violation({
          code: "DEAD_CODE_REGRESSION",
          rule: "deadCode",
          gate: "ast",
          file: ctx.relativePath,
          line: record.line,
          column: record.column,
          message: `Dead code regression: new unused ${record.kind.toLowerCase()} '${record.name}'.`,
          fix: `Remove unused ${record.kind.toLowerCase()} '${record.name}', or use it.`,
          useInstead: `Remove '${record.name}'.`,
        }),
      );
  },
};
