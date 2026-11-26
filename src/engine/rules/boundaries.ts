import path from "node:path";

import { pathMatches } from "../match.js";
import { toPosix } from "../../paths.js";
import { violation, type Rule } from "../types.js";

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function packageForbidden(specifier: string, forbidden: string): boolean {
  if (specifier.startsWith(".")) return false;
  if (forbidden.startsWith(".") || forbidden.includes("*") || forbidden.startsWith("src/")) return false;
  const name = packageName(specifier);
  const banned = packageName(forbidden);
  if (name !== banned) return false;
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.posix.dirname(toPosix(fromFile));
  return path.posix.normalize(path.posix.join(base, specifier));
}

function relativeForbidden(fromFile: string, specifier: string, forbidden: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolveRelative(fromFile, specifier).replace(/^\.\//, "");
  const stem = resolved.replace(/\.(tsx|ts|jsx|js|mts|cts|mjs|cjs)$/, "");
  const candidates = [resolved, stem, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}/index.ts`, `${stem}/index.tsx`];
  const patterns = forbidden.includes("*") ? [forbidden] : [forbidden, `${forbidden.replace(/\/$/, "")}/**`];
  return candidates.some((candidate) => patterns.some((pattern) => pathMatches(candidate, pattern) || candidate === forbidden.replace(/\/$/, "")));
}

export const boundaryRule: Rule = {
  id: "boundaries",
  gate: "ast",
  order: 80,
  check(ctx) {
    const rules = ctx.config.rules.boundaries;
    if (!ctx.sourceFile || rules.length === 0) return [];
    const active = rules.filter((rule) => pathMatches(ctx.relativePath, rule.sourcePattern) || pathMatches(ctx.relativePath, `${rule.sourcePattern.replace(/\/$/, "")}/**`));
    if (active.length === 0) return [];
    const violations = [];
    for (const statement of ctx.sourceFile.getImportDeclarations()) {
      const specifier = statement.getModuleSpecifierValue();
      const pos = ctx.sourceFile.getLineAndColumnAtPos(statement.getModuleSpecifier().getStart());
      for (const rule of active) {
        for (const forbidden of rule.forbiddenImports) {
          const hit = packageForbidden(specifier, forbidden) || relativeForbidden(ctx.relativePath, specifier, forbidden);
          if (!hit) continue;
          violations.push(
            violation({
              code: "BOUNDARY_VIOLATION",
              rule: "boundaries",
              gate: "ast",
              file: ctx.relativePath,
              line: pos.line,
              column: pos.column,
              message: `Files matching '${rule.sourcePattern}' cannot import '${specifier}'.`,
              fix: `Remove '${specifier}'. It crosses the boundary '${forbidden}'.`,
              useInstead: forbidden,
            }),
          );
        }
      }
    }
    return violations;
  },
};
