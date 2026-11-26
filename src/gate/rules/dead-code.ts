import type { SourceFile } from "ts-morph";

import { baselineText, type Baseline } from "../baseline.js";
import { collectUnused } from "../../engine/rules/dead-code.js";
import { simulateSource } from "../../engine/simulate.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";

function baseline(root: string, source: SourceFile, relativePath: string, text: Baseline): Set<string> {
  const pre = baselineText(root, relativePath, text);
  if (pre === null) return new Set();
  const options = source.getProject().getCompilerOptions();
  if (options.noUnusedLocals || options.noUnusedParameters) {
    // The project reports unused locals through the compiler, so the baseline has to come from the same
    // project and options, or every legacy unused local would look new.
    const proposed = source.getFullText();
    source.replaceWithText(pre);
    try {
      return new Set(collectUnused(source, true).map((record) => record.fingerprint));
    } finally {
      source.replaceWithText(proposed);
    }
  }
  const parsed = simulateSource(relativePath, pre);
  if (!parsed) return new Set();
  return new Set(collectUnused(parsed, true).map((record) => record.fingerprint));
}

export function deadCodeRegressionRule(root: string, source: SourceFile, relativePath: string, text: Baseline = undefined): GateViolation[] {
  const proposed = collectUnused(source, true);
  if (proposed.length === 0) return [];
  const known = baseline(root, source, relativePath, text);
  return proposed
    .filter((record) => !known.has(record.fingerprint))
    .map((record) =>
      gateViolation({
        rule: "DeadCodeRegressionRule",
        code: "DEAD_CODE_REGRESSION",
        file: relativePath,
        line: record.line,
        column: record.column,
        message: `Dead code regression: new unused ${record.kind.toLowerCase()} '${record.name}'.`,
        fix: `Remove unused ${record.kind.toLowerCase()} '${record.name}', or use it.`,
      }),
    );
}
