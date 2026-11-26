import { z } from "zod";

export const GateRuleSchema = z.enum([
  "PhantomSymbolRule",
  "DuplicateLogicRule",
  "DeadCodeRegressionRule",
  "LongMethodRule",
  "NamingDriftRule",
  "BoundaryCheckRule",
  "BreakingChangeRule",
  "ExportScopeRule",
  "ConventionDriftRule",
  "EditScopeRule",
  "SemanticReview",
  "FlightPlanScope",
  "CanaryAssertion",
  "InvariantCheck",
  // v0.4
  "PolicyRule",
  "SecretScan",
  "SastRule",
  "DependencyAdvisory",
  "WireframeDrift",
  "CrossRepoImpact",
  "IntentCheck",
  "LanguageRule",
  "BehaviorRule",
]);

export const GateViolationSchema = z.object({
  rule: GateRuleSchema,
  code: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  message: z.string(),
  fix: z.string(),
  tsDiagnosticCode: z.number().int().optional(),
  similarity: z.number().optional(),
  /** v0.4: "observe" = logged as would-have-blocked, the write proceeds (policy rollout mode). */
  severity: z.enum(["block", "warn", "observe"]).optional(),
  /** v0.4: CWE id for security findings. */
  cwe: z.string().optional(),
});

export const GateResultSchema = z.object({
  cleared: z.boolean(),
  file: z.string(),
  violations: z.array(GateViolationSchema),
});

export type GateRule = z.infer<typeof GateRuleSchema>;
export type GateViolation = z.infer<typeof GateViolationSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;

export function gateViolation(input: GateViolation): GateViolation {
  return input;
}
