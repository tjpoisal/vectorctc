import { z } from "zod";

import { isSafeRegExp } from "../engine/safe-regex.js";

export const DEFAULT_NAMING = {
  functions: "^[a-z][a-zA-Z0-9]*$",
  variables: "^([a-z][a-zA-Z0-9]*|[A-Z][A-Z0-9_]*)$",
  typesAndInterfaces: "^[A-Z][a-zA-Z0-9]*$",
};

export const DEFAULT_THRESHOLDS = {
  maxFunctionLines: 40,
  maxCyclomaticComplexity: 10,
  duplicateJaccard: 0.85,
};

const safePattern = z.string().refine(isSafeRegExp, { message: "Rejected regular expression. Use a short pattern without nested quantifiers." });

export const GateRuleToggleSchema = z.enum(["phantom", "duplicates", "deadCode", "functionLength", "complexity", "naming", "breakingChange", "conventions", "semantic"]);
export type GateRuleToggle = z.infer<typeof GateRuleToggleSchema>;

export const FlightPlanInvariantSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  forbiddenPattern: z.string().optional(),
  requiredPattern: z.string().optional(),
  inPaths: z.array(z.string()).optional(),
});

export const FlightPlanCanarySchema = z.object({
  id: z.string().min(1),
  description: z.string().default(""),
  targetFileGlob: z.string().min(1),
  requiredPattern: safePattern,
});

export const FlightPlanBoundarySchema = z.object({
  sourcePattern: z.string().min(1),
  forbiddenImports: z.array(z.string().min(1)).min(1),
});

export const FlightPlanSchema = z.object({
  planId: z.string().min(1),
  taskId: z.string().min(1),
  createdAt: z.string().min(1),
  sessionId: z.string().min(1).default("local"),
  objective: z.string().default(""),
  allowedFileGlobs: z.array(z.string().min(1)).min(1),
  invariants: z.array(FlightPlanInvariantSchema).default([]),
  naming: z
    .object({
      functions: safePattern.default(DEFAULT_NAMING.functions),
      variables: safePattern.default(DEFAULT_NAMING.variables),
      typesAndInterfaces: safePattern.default(DEFAULT_NAMING.typesAndInterfaces),
    })
    .default(DEFAULT_NAMING),
  boundaries: z.array(FlightPlanBoundarySchema).default([]),
  thresholds: z
    .object({
      maxFunctionLines: z.number().int().positive().default(DEFAULT_THRESHOLDS.maxFunctionLines),
      maxCyclomaticComplexity: z.number().int().positive().default(DEFAULT_THRESHOLDS.maxCyclomaticComplexity),
      duplicateJaccard: z.number().min(0.5).max(1).default(DEFAULT_THRESHOLDS.duplicateJaccard),
    })
    .default(DEFAULT_THRESHOLDS),
  canaries: z.array(FlightPlanCanarySchema).default([]),
  globalBannedPackages: z.array(z.string()).default([]),
  /** Analyzer rules switched off by ctc.config.json (`rules.<name>.enabled: false`, null degradation limits). */
  disabledRules: z.array(GateRuleToggleSchema).default([]),
  /** Where the duplicate-logic index looks for existing helpers. Falls back to rules.duplicates.utilityGlobs. */
  utilityGlobs: z.array(z.string().min(1)).optional(),
  /** When set, exports an edit adds must be on this list (ExportScopeRule). Omit to allow any new export. */
  allowedNewExports: z.array(z.string().min(1)).optional(),
  /**
   * When set, existing declarations (functions, classes, members, top-level consts) the edit may change.
   * Changing or removing one that is not listed is held as in-file scope creep (EditScopeRule).
   * Naming a class covers its members. Omit to allow edits anywhere in a planned file.
   */
  allowedEditSymbols: z.array(z.string().min(1)).optional(),
  /** v0.4: wireframes (.ctc/wireframes/<name>) the task's UI must match. Omit to enforce every approved wireframe by its file globs. */
  wireframes: z.array(z.string().min(1)).optional(),
  /** v0.4: the UI is meant to be complete after this task, so missing wireframe components block instead of warn. */
  uiComplete: z.boolean().optional(),
  /** v0.4: ticket or issue text the diff should implement (IntentCheck). Falls back to objective. */
  ticket: z.string().optional(),
});

export type FlightPlanContract = z.infer<typeof FlightPlanSchema>;
export type FlightPlanCanary = z.infer<typeof FlightPlanCanarySchema>;
export type FlightPlanInvariant = z.infer<typeof FlightPlanInvariantSchema>;
