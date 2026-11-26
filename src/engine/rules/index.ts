import type { Rule, RuleContext, Violation } from "../types.js";
import { bannedImportRule } from "./banned-imports.js";
import { boundaryRule } from "./boundaries.js";
import { complexityRule } from "./complexity.js";
import { deadCodeRule } from "./dead-code.js";
import { duplicateRule } from "./duplicates.js";
import { invariantRule } from "./invariants.js";
import { lockRule } from "./lock.js";
import { namingRule } from "./naming.js";
import { restrictedCallRule } from "./restricted-calls.js";
import { scopeRule } from "./scope.js";
import { unusedImportRule } from "./unused-imports.js";

/** Built-in Runway Gate rules. Order is the gate sequence, not a short-circuit. */
export const builtinRules: readonly Rule[] = [
  lockRule,
  scopeRule,
  invariantRule,
  bannedImportRule,
  restrictedCallRule,
  complexityRule,
  unusedImportRule,
  namingRule,
  boundaryRule,
  duplicateRule,
  deadCodeRule,
].sort((a, b) => a.order - b.order);

export function runRules(ctx: RuleContext, rules: readonly Rule[] = builtinRules): Violation[] {
  const violations: Violation[] = [];
  for (const rule of rules) {
    violations.push(...rule.check(ctx));
  }
  return violations;
}
