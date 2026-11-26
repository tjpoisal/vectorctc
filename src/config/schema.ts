import { randomUUID } from "node:crypto";
import { z } from "zod";

import { isSafeRegExp } from "../engine/safe-regex.js";

const safePattern = z.string().min(1).max(200).refine(isSafeRegExp, { message: "Must be a short regular expression without nested quantifiers" });

export const activeMilestoneSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    allowedPaths: z.array(z.string().min(1)).min(1),
    status: z.enum(["active", "locked"]),
  })
  .strict();

export const bannedImportSchema = z
  .object({
    pattern: z.string().min(1),
    reason: z.string().min(1),
    useInstead: z.string().min(1),
  })
  .strict();

export const restrictedCallSchema = z
  .object({
    callPattern: z.string().min(1),
    inPaths: z.array(z.string().min(1)).min(1),
    useInstead: z.string().min(1),
  })
  .strict();

const degradationSchema = z
  .object({
    maxFunctionLength: z.number().int().positive().nullable().default(null),
    maxCyclomaticComplexity: z.number().int().positive().nullable().default(null),
    flagUnusedImports: z.boolean().default(false),
  })
  .strict();

const circuitBreakerSchema = z
  .object({
    maxStrikes: z.number().int().min(1).max(100).default(3),
  })
  .strict();

const namingSchema = z
  .object({
    enabled: z.boolean().default(false),
    functions: safePattern.default("^[a-z][a-zA-Z0-9]*$"),
    variables: safePattern.default("^([a-z][a-zA-Z0-9]*|[A-Z][A-Z0-9_]*)$"),
    typesAndInterfaces: safePattern.default("^[A-Z][a-zA-Z0-9]*$"),
    customHookPrefix: z.string().min(1).max(32).nullable().default(null),
  })
  .strict();

const boundarySchema = z
  .object({
    sourcePattern: z.string().min(1),
    forbiddenImports: z.array(z.string().min(1)).min(1),
  })
  .strict();

const duplicateSchema = z
  .object({
    enabled: z.boolean().default(true),
    minAstNodes: z.number().int().positive().default(15),
    duplicateWarnThreshold: z.number().min(0.4).max(1).default(0.7),
    duplicateBlockThreshold: z.number().min(0.5).max(1).default(0.85),
    utilityGlobs: z.array(z.string().min(1)).default(["src/utils/**", "src/lib/**"]),
    shingleSize: z.number().int().min(2).max(8).default(4),
    minHashPermutations: z.number().int().min(8).max(128).default(64),
  })
  .strict()
  .refine((value) => value.duplicateWarnThreshold < value.duplicateBlockThreshold, {
    message: "duplicateWarnThreshold must be lower than duplicateBlockThreshold",
  });

const phantomSchema = z
  .object({
    /** The milestone engine's tsc-backed phantom pass (opt-in, time-bounded). */
    enabled: z.boolean().default(false),
    /** The Runway Gate's in-process symbol check (TS2339, TS2304, ...). On unless set to false. */
    gate: z.boolean().default(true),
    timeoutMs: z.number().int().min(1).max(60_000).default(1500),
    strictCallSignatures: z.boolean().default(true),
  })
  .strict();

const deadCodeSchema = z
  .object({
    enabled: z.boolean().default(true),
    allowUnderscorePrefix: z.boolean().default(true),
  })
  .strict();

const conventionsSchema = z
  .object({
    /** v0.3 ConventionDriftRule: unit (cents/dollars, ms/s) and boundary-comparison drift on changed lines. */
    enabled: z.boolean().default(true),
  })
  .strict();

const semanticSchema = z
  .object({
    /** v0.3 optional model-based review. Runs only when an API key is in the environment (see README). */
    enabled: z.boolean().default(true),
    /** "block" holds the write on a kept finding; "warn" reports it without holding. */
    mode: z.enum(["block", "warn"]).default("block"),
    minConfidence: z.number().min(0).max(1).default(0.8),
    maxFindings: z.number().int().min(1).max(10).default(3),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict();

const readZoneSchema = z
  .object({
    enabled: z.boolean().default(true),
    contextWindowTokens: z.number().int().positive().default(128_000),
    yellowAt: z.number().gt(0).lt(1).default(0.4),
    redAt: z.number().gt(0).lt(1).default(0.65),
    lockOnRed: z.boolean().default(false),
    lockOnReRead: z.boolean().default(false),
    signatureOnlyInYellow: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.yellowAt < value.redAt, { message: "yellowAt must be lower than redAt" });

const unimatrixSchema = z
  .object({
    enabled: z.boolean().default(false),
    endpoint: z.string().url().default("https://www.deployunimatrix.com/api"),
    spaceId: z.string().min(1).nullable().default(null),
    locationId: z.string().min(1).nullable().default(null),
    feedbackOnRepeat: z.boolean().default(false),
  })
  .strict();

const rulesSchema = z
  .object({
    naming: namingSchema.prefault({}),
    boundaries: z.array(boundarySchema).default([]),
    duplicates: duplicateSchema.prefault({}),
    phantom: phantomSchema.prefault({}),
    deadCode: deadCodeSchema.prefault({}),
    conventions: conventionsSchema.prefault({}),
    semantic: semanticSchema.prefault({}),
    readZones: readZoneSchema.prefault({}),
  })
  .strict();

export const ctcConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    activeMilestone: activeMilestoneSchema,
    lockedFiles: z.array(z.string().min(1)).default([]),
    bannedImports: z.array(bannedImportSchema).default([]),
    restrictedCalls: z.array(restrictedCallSchema).default([]),
    degradation: degradationSchema.default({
      maxFunctionLength: null,
      maxCyclomaticComplexity: null,
      flagUnusedImports: false,
    }),
    circuitBreaker: circuitBreakerSchema.default({ maxStrikes: 3 }),
    rules: rulesSchema.prefault({}),
    unimatrix: unimatrixSchema.prefault({}),
  })
  .strict();

export const invariantSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    forbiddenPattern: safePattern.optional(),
    requiredPattern: safePattern.optional(),
    inPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const canarySchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    targetFileGlob: z.string().min(1),
    requiredPattern: safePattern,
  })
  .strict();

export const flightPlanSchema = z
  .object({
    planId: z.string().uuid().optional(),
    createdAt: z.string().datetime().optional(),
    sessionId: z.string().min(1).default("local"),
    milestone: z.string().min(1),
    intent: z.string().default(""),
    paths: z.array(z.string().min(1)).min(1),
    invariants: z.array(invariantSchema).default([]),
    canaries: z.array(canarySchema).default([]),
  })
  .strict();

export interface ActiveMilestone {
  id: string;
  title: string;
  allowedPaths: string[];
  status: "active" | "locked";
}

export interface ImportRule {
  pattern: string;
  reason: string;
  useInstead: string;
}

export interface CallRule {
  callPattern: string;
  inPaths: string[];
  useInstead: string;
}

export interface DegradationConfig {
  maxFunctionLength: number | null;
  maxCyclomaticComplexity: number | null;
  flagUnusedImports: boolean;
}

export interface NamingConfig {
  enabled: boolean;
  functions: string;
  variables: string;
  typesAndInterfaces: string;
  customHookPrefix: string | null;
}

export interface BoundaryConfig {
  sourcePattern: string;
  forbiddenImports: string[];
}

export interface DuplicateConfig {
  enabled: boolean;
  minAstNodes: number;
  duplicateWarnThreshold: number;
  duplicateBlockThreshold: number;
  utilityGlobs: string[];
  shingleSize: number;
  minHashPermutations: number;
}

export interface SemanticConfig {
  enabled: boolean;
  mode: "block" | "warn";
  minConfidence: number;
  maxFindings: number;
  timeoutMs: number;
}

export interface RulesConfig {
  naming: NamingConfig;
  boundaries: BoundaryConfig[];
  duplicates: DuplicateConfig;
  phantom: { enabled: boolean; gate: boolean; timeoutMs: number; strictCallSignatures: boolean };
  deadCode: { enabled: boolean; allowUnderscorePrefix: boolean };
  conventions: { enabled: boolean };
  semantic: SemanticConfig;
  readZones: {
    enabled: boolean;
    contextWindowTokens: number;
    yellowAt: number;
    redAt: number;
    lockOnRed: boolean;
    lockOnReRead: boolean;
    signatureOnlyInYellow: boolean;
  };
}

export interface UnimatrixConfig {
  enabled: boolean;
  endpoint: string;
  spaceId: string | null;
  locationId: string | null;
  feedbackOnRepeat: boolean;
}

export interface CtcConfig {
  version: 1;
  activeMilestone: ActiveMilestone;
  lockedFiles: string[];
  bannedImports: ImportRule[];
  restrictedCalls: CallRule[];
  degradation: DegradationConfig;
  circuitBreaker: { maxStrikes: number };
  rules: RulesConfig;
  unimatrix: UnimatrixConfig;
}

export interface PlanInvariant {
  id: string;
  text: string;
  forbiddenPattern?: string;
  requiredPattern?: string;
  inPaths?: string[];
}

export interface PlanCanary {
  id: string;
  description: string;
  targetFileGlob: string;
  requiredPattern: string;
}

export interface FlightPlan {
  planId: string;
  createdAt: string;
  sessionId: string;
  milestone: string;
  intent: string;
  paths: string[];
  invariants: PlanInvariant[];
  canaries: PlanCanary[];
}

export function normalizeConfig(raw: unknown): CtcConfig {
  const parsed = ctcConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(details);
  }
  const data = parsed.data;
  return {
    version: 1,
    activeMilestone: data.activeMilestone,
    lockedFiles: data.lockedFiles,
    bannedImports: data.bannedImports,
    restrictedCalls: data.restrictedCalls,
    degradation: data.degradation,
    circuitBreaker: data.circuitBreaker,
    rules: data.rules,
    unimatrix: data.unimatrix,
  };
}

export function normalizeFlightPlan(raw: unknown): FlightPlan {
  const parsed = flightPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Flight plan is invalid: ${details}`);
  }
  return {
    planId: parsed.data.planId ?? randomUUID(),
    createdAt: parsed.data.createdAt ?? new Date().toISOString(),
    sessionId: parsed.data.sessionId,
    milestone: parsed.data.milestone,
    intent: parsed.data.intent,
    paths: parsed.data.paths,
    invariants: parsed.data.invariants.map((item) => ({
      id: item.id,
      text: item.text,
      ...(item.forbiddenPattern ? { forbiddenPattern: item.forbiddenPattern } : {}),
      ...(item.requiredPattern ? { requiredPattern: item.requiredPattern } : {}),
      ...(item.inPaths ? { inPaths: item.inPaths } : {}),
    })),
    canaries: parsed.data.canaries,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
