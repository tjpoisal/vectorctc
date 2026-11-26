import type { SourceFile } from "ts-morph";

import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";

function exportLines(source: SourceFile): Map<string, number> {
  const lines = new Map<string, number>();
  for (const [name, declarations] of source.getExportedDeclarations()) {
    const local = declarations.find((item) => item.getSourceFile() === source);
    lines.set(name, local?.getStartLineNumber() ?? 1);
  }
  for (const item of source.getExportDeclarations()) {
    for (const specifier of item.getNamedExports()) {
      const name = specifier.getAliasNode()?.getText() ?? specifier.getName();
      if (!lines.has(name)) lines.set(name, specifier.getStartLineNumber());
    }
  }
  return lines;
}

/**
 * Scope check for the public surface: when the flight plan lists `allowedNewExports`, any export the
 * edit adds that is not on the list blocks. Existing exports are never flagged. Plans without the
 * field skip the rule. This is purely syntactic over export names; it does not judge what an export does.
 */
export function exportScopeRule(root: string, source: SourceFile, relativePath: string, allowed: readonly string[] | undefined, baseline: Baseline): GateViolation[] {
  if (!allowed) return [];
  const before = baselineText(root, relativePath, baseline);
  // Read the old surface from the same project as the new one, so `export * from` resolves the same way
  // on both sides (a barrel's re-exports are not new just because an isolated parse cannot see them).
  const existing = new Set<string>();
  if (before !== null) {
    const proposed = source.getFullText();
    source.replaceWithText(before);
    try {
      for (const name of exportLines(source).keys()) existing.add(name);
    } finally {
      source.replaceWithText(proposed);
    }
  }
  const permitted = new Set(allowed);
  const violations: GateViolation[] = [];
  for (const [name, line] of exportLines(source)) {
    if (existing.has(name) || permitted.has(name)) continue;
    violations.push(
      gateViolation({
        rule: "ExportScopeRule",
        code: "EXPORT_NOT_IN_PLAN",
        file: relativePath,
        line,
        column: 1,
        message: `New export '${name}' is not in the flight plan's allowedNewExports (${permitted.size ? [...permitted].join(", ") : "none"}).`,
        fix: `Keep '${name}' module-private, or add it to the flight plan before exporting it.`,
      }),
    );
  }
  return violations;
}
