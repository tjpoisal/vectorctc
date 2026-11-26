import path from "node:path";
import { Node, SyntaxKind, type SourceFile } from "ts-morph";

import { pathMatches } from "../../engine/match.js";
import { toPosix } from "../../paths.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import type { FlightPlanContract } from "../../schemas/flightPlan.js";

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function packageHit(specifier: string, forbidden: string): boolean {
  if (specifier.startsWith(".")) return false;
  if (forbidden.startsWith(".") || forbidden.includes("*") || forbidden.startsWith("src/")) return false;
  const name = packageName(specifier);
  const banned = packageName(forbidden);
  if (name !== banned) return false;
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.posix.dirname(toPosix(fromFile));
  return path.posix.normalize(path.posix.join(base, specifier)).replace(/^\.\//, "");
}

function relativeHit(fromFile: string, specifier: string, forbidden: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolveRelative(fromFile, specifier);
  const stem = resolved.replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, "");
  const candidates = [resolved, stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}/index.ts`];
  const patterns = forbidden.includes("*") ? [forbidden] : [forbidden, `${forbidden.replace(/\/$/, "")}/**`];
  return candidates.some((candidate) => patterns.some((pattern) => pathMatches(candidate, pattern) || candidate === forbidden.replace(/\/$/, "")));
}

function specifiers(source: SourceFile): Array<{ specifier: string; line: number; column: number }> {
  const found: Array<{ specifier: string; line: number; column: number }> = [];
  const push = (specifier: string, node: Node): void => {
    const pos = source.getLineAndColumnAtPos(node.getStart());
    found.push({ specifier, line: pos.line, column: pos.column });
  };
  for (const statement of source.getImportDeclarations()) push(statement.getModuleSpecifierValue(), statement.getModuleSpecifier());
  for (const statement of source.getExportDeclarations()) {
    const specifier = statement.getModuleSpecifierValue();
    if (specifier) push(specifier, statement.getModuleSpecifier() ?? statement);
  }
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!Node.isIdentifier(call.getExpression()) || call.getExpression().getText() !== "import") continue;
    const arg = call.getArguments()[0];
    if (arg && Node.isStringLiteral(arg)) push(arg.getLiteralValue(), arg);
  }
  return found;
}

/**
 * v0.3: names imported through a barrel (`import { InvoiceRepo } from "../index"`) are followed to the
 * module that declares them, so a re-export cannot launder a forbidden layer. Uses the gate project's
 * type checker (alias resolution handles `export *` and `export { x } from` chains).
 */
function barrelOrigins(root: string, source: SourceFile): Array<{ specifier: string; name: string; origin: string; line: number; column: number }> {
  const out: Array<{ specifier: string; name: string; origin: string; line: number; column: number }> = [];
  for (const statement of source.getImportDeclarations()) {
    const target = statement.getModuleSpecifierSourceFile();
    if (!target || target.isInNodeModules() || target.isDeclarationFile()) continue;
    const named = statement.getNamedImports();
    const defaults = statement.getDefaultImport();
    const nodes = [...named.map((item) => item.getNameNode()), ...(defaults ? [defaults] : [])];
    for (const nameNode of nodes) {
      let files: string[] = [];
      try {
        const symbol = nameNode.getSymbol();
        const aliased = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
        files = (aliased?.getDeclarations() ?? []).map((item) => item.getSourceFile().getFilePath());
      } catch {
        files = [];
      }
      for (const file of new Set(files)) {
        if (file === target.getFilePath()) continue;
        const origin = toPosix(path.relative(root, file));
        if (origin.startsWith("..") || origin.includes("node_modules/")) continue;
        const pos = source.getLineAndColumnAtPos(statement.getStart());
        out.push({ specifier: statement.getModuleSpecifierValue(), name: nameNode.getText(), origin, line: pos.line, column: pos.column });
      }
    }
  }
  return out;
}

function originHit(origin: string, forbidden: string): boolean {
  const stem = origin.replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, "");
  const patterns = forbidden.includes("*") ? [forbidden] : [forbidden, `${forbidden.replace(/\/$/, "")}/**`];
  return [origin, stem].some((candidate) => patterns.some((pattern) => pathMatches(candidate, pattern) || candidate === forbidden.replace(/\/$/, "")));
}

export function boundaryCheckRule(source: SourceFile, relativePath: string, plan: FlightPlanContract, root?: string): GateViolation[] {
  const violations: GateViolation[] = [];
  const active = plan.boundaries.filter((rule) => pathMatches(relativePath, rule.sourcePattern));
  for (const item of specifiers(source)) {
    for (const banned of plan.globalBannedPackages) {
      if (!packageHit(item.specifier, banned)) continue;
      violations.push(
        gateViolation({
          rule: "BoundaryCheckRule",
          code: "BANNED_PACKAGE",
          file: relativePath,
          line: item.line,
          column: item.column,
          message: `Package '${item.specifier}' is banned for this flight plan.`,
          fix: `Remove '${item.specifier}'.`,
        }),
      );
    }
    for (const rule of active) {
      for (const forbidden of rule.forbiddenImports) {
        const hit = packageHit(item.specifier, forbidden) || relativeHit(relativePath, item.specifier, forbidden);
        if (!hit) continue;
        violations.push(
          gateViolation({
            rule: "BoundaryCheckRule",
            code: "BOUNDARY_VIOLATION",
            file: relativePath,
            line: item.line,
            column: item.column,
            message: `Files matching '${rule.sourcePattern}' cannot import '${item.specifier}'.`,
            fix: `Remove '${item.specifier}'. It crosses the boundary '${forbidden}'.`,
          }),
        );
      }
    }
  }
  if (root && active.length > 0) {
    const direct = new Set(violations.filter((item) => item.code === "BOUNDARY_VIOLATION").map((item) => item.line));
    for (const item of barrelOrigins(path.resolve(root), source)) {
      if (direct.has(item.line)) continue;
      for (const rule of active) {
        const forbidden = rule.forbiddenImports.find((pattern) => originHit(item.origin, pattern));
        if (!forbidden) continue;
        violations.push(
          gateViolation({
            rule: "BoundaryCheckRule",
            code: "BOUNDARY_VIOLATION",
            file: relativePath,
            line: item.line,
            column: item.column,
            message: `Files matching '${rule.sourcePattern}' cannot import from '${forbidden}': '${item.name}' comes from ${item.origin} through the re-export in '${item.specifier}', which bypasses the layer boundary.`,
            fix: `Do not import '${item.name}' here; go through the allowed layer instead of the barrel '${item.specifier}'.`,
          }),
        );
        direct.add(item.line);
        break;
      }
    }
  }
  return violations;
}
