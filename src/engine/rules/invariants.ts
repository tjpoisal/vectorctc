import { pathMatches } from "../match.js";
import { compileSafeRegExp, safeTest } from "../safe-regex.js";
import { violation, type Rule } from "../types.js";

export const invariantRule: Rule = {
  id: "invariants",
  gate: "scope",
  order: 25,
  check(ctx) {
    const plan = ctx.flightPlan;
    if (!plan) return [];
    const violations = [];
    for (const canary of plan.canaries) {
      if (!pathMatches(ctx.relativePath, canary.targetFileGlob)) continue;
      const pattern = compileSafeRegExp(canary.requiredPattern);
      if (safeTest(pattern, ctx.content)) continue;
      violations.push(
        violation({
          code: "CANARY_AMNESIA",
          rule: "invariants",
          gate: "scope",
          file: ctx.relativePath,
          line: 1,
          column: 1,
          message: `Canary '${canary.id}' failed: ${canary.description}`,
          fix: `Restore text matching /${canary.requiredPattern}/ in ${ctx.relativePath}.`,
          useInstead: canary.requiredPattern,
        }),
      );
    }
    for (const invariant of plan.invariants) {
      const paths = invariant.inPaths ?? plan.paths;
      if (!paths.some((pattern) => pathMatches(ctx.relativePath, pattern))) continue;
      if (invariant.forbiddenPattern) {
        const pattern = compileSafeRegExp(invariant.forbiddenPattern);
        if (safeTest(pattern, ctx.content)) {
          violations.push(
            violation({
              code: "INVARIANT_VIOLATION",
              rule: "invariants",
              gate: "scope",
              file: ctx.relativePath,
              line: 1,
              column: 1,
              message: `Invariant '${invariant.id}' forbids this file: ${invariant.text}`,
              fix: `Remove text matching /${invariant.forbiddenPattern}/.`,
              useInstead: invariant.text,
            }),
          );
        }
      }
      if (invariant.requiredPattern) {
        const pattern = compileSafeRegExp(invariant.requiredPattern);
        if (!safeTest(pattern, ctx.content)) {
          violations.push(
            violation({
              code: "INVARIANT_VIOLATION",
              rule: "invariants",
              gate: "scope",
              file: ctx.relativePath,
              line: 1,
              column: 1,
              message: `Invariant '${invariant.id}' is missing from this file: ${invariant.text}`,
              fix: `Include text matching /${invariant.requiredPattern}/.`,
              useInstead: invariant.requiredPattern,
            }),
          );
        }
      }
    }
    return violations;
  },
};
