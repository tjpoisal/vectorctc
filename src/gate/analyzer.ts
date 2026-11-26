import { scriptKindFor } from "../engine/simulate.js";
import type { FlightPlanContract } from "../schemas/flightPlan.js";
import type { GateResult, GateViolation } from "../schemas/gate.js";
import { onlyNew, type Baseline } from "./baseline.js";
import { withOverlay } from "./overlay.js";
import { boundaryCheckRule } from "./rules/boundaries.js";
import { breakingChangeRule } from "./rules/breaking-change.js";
import { conventionDriftRule } from "./rules/conventions.js";
import { editScopeRule } from "./rules/edit-scope.js";
import { deadCodeRegressionRule } from "./rules/dead-code.js";
import { duplicateLogicRule } from "./rules/duplicates.js";
import { exportScopeRule } from "./rules/export-scope.js";
import { longMethodRule } from "./rules/long-method.js";
import { namingDriftRule } from "./rules/naming.js";
import { phantomSymbolRule } from "./rules/phantom.js";

export interface AnalyzeOptions {
  /** Pre-edit text for diff-aware rules. Omit to read the file on disk; null to treat everything as new. */
  baseline?: Baseline;
}

export function analyzeProposal(root: string, relativePath: string, content: string, plan: FlightPlanContract, options: AnalyzeOptions = {}): GateResult {
  if (!scriptKindFor(relativePath)) {
    return { cleared: true, file: relativePath, violations: [] };
  }
  try {
    const off = new Set(plan.disabledRules);
    const maxLines = off.has("functionLength") ? Number.POSITIVE_INFINITY : plan.thresholds.maxFunctionLines;
    const maxComplexity = off.has("complexity") ? Number.POSITIVE_INFINITY : plan.thresholds.maxCyclomaticComplexity;
    return withOverlay(root, relativePath, content, (source, project) => {
      const violations: GateViolation[] = [
        ...(off.has("phantom") ? [] : phantomSymbolRule(source, relativePath, root, options.baseline)),
        ...(off.has("duplicates") ? [] : duplicateLogicRule(root, source, relativePath, plan.thresholds.duplicateJaccard, plan.utilityGlobs, options.baseline)),
        ...(off.has("deadCode") ? [] : deadCodeRegressionRule(root, source, relativePath, options.baseline)),
        // Complexity, length and naming look at the whole file, so they are compared with the pre-edit file
        // the same way dead code is: only new or worsened findings block.
        ...onlyNew(root, relativePath, options.baseline, longMethodRule(source, relativePath, maxLines, maxComplexity), (old) =>
          longMethodRule(old, relativePath, maxLines, maxComplexity),
        ),
        ...(off.has("naming") ? [] : onlyNew(root, relativePath, options.baseline, namingDriftRule(source, relativePath, plan.naming), (old) => namingDriftRule(old, relativePath, plan.naming))),
        ...boundaryCheckRule(source, relativePath, plan, root),
        ...exportScopeRule(root, source, relativePath, plan.allowedNewExports, options.baseline),
        ...editScopeRule(root, source, relativePath, plan.allowedEditSymbols, options.baseline),
        ...(off.has("conventions") ? [] : conventionDriftRule(root, source, project, relativePath, options.baseline, plan.objective)),
        ...(off.has("breakingChange") ? [] : breakingChangeRule(root, source, project, relativePath, options.baseline)),
      ];
      return { cleared: violations.length === 0, file: relativePath, violations };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      cleared: false,
      file: relativePath,
      violations: [
        {
          rule: "PhantomSymbolRule",
          code: "PARSE_ERROR",
          file: relativePath,
          line: 1,
          column: 1,
          message: `The proposal could not be analyzed: ${message}`,
          fix: "Fix the syntax and submit the file again.",
        },
      ],
    };
  }
}
