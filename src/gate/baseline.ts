import fs from "node:fs";
import path from "node:path";

import { simulateSource } from "../engine/simulate.js";
import type { GateViolation } from "../schemas/gate.js";

/**
 * Pre-edit state of a file, used to make whole-file rules diff-aware.
 * `undefined` = read it from disk; `null` = no baseline (every finding is new).
 */
export type Baseline = string | null | undefined;

export function baselineText(root: string, relativePath: string, baseline: Baseline): string | null {
  if (baseline !== undefined) return baseline;
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  return fs.readFileSync(absolute, "utf8");
}

/** Identity of a finding without its position, so moved-but-unchanged code still matches its baseline. */
export function findingKey(item: GateViolation): string {
  return `${item.rule}|${item.code}|${item.message}`;
}

/**
 * Drop findings that the same rule already raises on the pre-edit file. A function that keeps the same
 * complexity or the same off-pattern name is legacy; one that is new, or got worse, is reported.
 * Multiset semantics: two identical legacy findings excuse at most two identical new ones.
 */
export function onlyNew(
  root: string,
  relativePath: string,
  baseline: Baseline,
  proposed: GateViolation[],
  rule: (source: NonNullable<ReturnType<typeof simulateSource>>) => GateViolation[],
): GateViolation[] {
  if (proposed.length === 0) return proposed;
  const text = baselineText(root, relativePath, baseline);
  if (text === null) return proposed;
  const source = simulateSource(relativePath, text);
  if (!source) return proposed;
  const budget = new Map<string, number>();
  for (const item of rule(source)) budget.set(findingKey(item), (budget.get(findingKey(item)) ?? 0) + 1);
  return proposed.filter((item) => {
    const left = budget.get(findingKey(item)) ?? 0;
    if (left === 0) return true;
    budget.set(findingKey(item), left - 1);
    return false;
  });
}
