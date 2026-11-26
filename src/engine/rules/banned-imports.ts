import { minimatch } from "minimatch";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import type { ImportRule } from "../../config/schema.js";
import { hasGlob } from "../match.js";
import { violation, type Rule, type Violation } from "../types.js";

interface SpecifierHit {
  specifier: string;
  line: number;
  column: number;
}

function specifierMatches(specifier: string, rule: string): boolean {
  if (hasGlob(rule)) return minimatch(specifier, rule, { dot: true });
  if (specifier === rule) return true;
  if (!rule.includes("/") && specifier.startsWith(`${rule}/`)) return true;
  return false;
}

function location(sourceFile: SourceFile, node: Node): { line: number; column: number } {
  const pos = sourceFile.getLineAndColumnAtPos(node.getStart());
  return { line: pos.line, column: pos.column };
}

function literalSpecifier(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  return null;
}

function collectSpecifiers(sourceFile: SourceFile): SpecifierHit[] {
  const hits: SpecifierHit[] = [];
  for (const statement of sourceFile.getImportDeclarations()) {
    const specifier = statement.getModuleSpecifier();
    const value = statement.getModuleSpecifierValue();
    if (!value) continue;
    const pos = location(sourceFile, specifier);
    hits.push({ specifier: value, ...pos });
  }
  for (const statement of sourceFile.getExportDeclarations()) {
    const specifier = statement.getModuleSpecifier();
    const value = statement.getModuleSpecifierValue();
    if (!specifier || !value) continue;
    const pos = location(sourceFile, specifier);
    hits.push({ specifier: value, ...pos });
  }
  for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const reference = statement.getModuleReference();
    if (!Node.isExternalModuleReference(reference)) continue;
    const expression = reference.getExpression();
    if (!expression) continue;
    const value = literalSpecifier(expression);
    if (!value) continue;
    const pos = location(sourceFile, expression);
    hits.push({ specifier: value, ...pos });
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    const value = literalSpecifier(arg);
    if (!value) continue;
    const pos = location(sourceFile, arg);
    hits.push({ specifier: value, ...pos });
  }
  return hits;
}

function describe(rule: ImportRule, specifier: string): { message: string; fix: string; useInstead: string } {
  return {
    message: `Import "${specifier}" is banned: ${rule.reason}`,
    fix: `Import ${rule.useInstead} instead of "${specifier}". ${rule.reason}`,
    useInstead: rule.useInstead,
  };
}

export function bannedImportViolations(
  sourceFile: SourceFile,
  relativePath: string,
  rules: readonly ImportRule[],
): Violation[] {
  if (rules.length === 0) return [];
  const violations: Violation[] = [];
  for (const hit of collectSpecifiers(sourceFile)) {
    const rule = rules.find((entry) => specifierMatches(hit.specifier, entry.pattern));
    if (!rule) continue;
    const copy = describe(rule, hit.specifier);
    violations.push(
      violation({
        code: "BANNED_IMPORT",
        rule: "bannedImports",
        gate: "ast",
        file: relativePath,
        line: hit.line,
        column: hit.column,
        message: copy.message,
        fix: copy.fix,
        useInstead: copy.useInstead,
      }),
    );
  }
  return violations;
}

export const bannedImportRule: Rule = {
  id: "bannedImports",
  gate: "ast",
  order: 30,
  check(ctx) {
    if (!ctx.sourceFile) return [];
    return bannedImportViolations(ctx.sourceFile, ctx.relativePath, ctx.config.bannedImports);
  },
};
