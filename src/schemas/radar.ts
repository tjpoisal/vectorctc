import { z } from "zod";

/** GREEN is under 40% estimated context. YELLOW is 40–65%. RED is over 65%, or three consecutive failures, or the third identical read. */
export const RadarZoneSchema = z.enum(["GREEN", "YELLOW", "RED"]);

export const RadarTelemetrySchema = z.object({
  zone: RadarZoneSchema,
  utilization: z.number(),
  estimatedTokensUsed: z.number(),
  contextWindowTokens: z.number().int().positive(),
  consecutiveFailures: z.number().int().nonnegative(),
  consecutiveIdenticalReads: z.number().int().nonnegative(),
  filePath: z.string(),
  lineRange: z.string(),
  tokenEstimate: z.literal(true),
});

export const HandoffReasonSchema = z.enum([
  "CONTEXT_SATURATION",
  "CONSECUTIVE_GATE_FAILURES",
  "RETRY_THRASHING",
  "RED_ZONE_LOCK",
  "CANARY_AMNESIA",
  "MANUAL_HANDOFF",
]);

export const GroundCrewHandoffSchema = z
  .object({
    handoffId: z.string().min(1),
    generatedAt: z.string().min(1),
    previousSessionId: z.string(),
    triggerReason: HandoffReasonSchema,
    activePlanId: z.string(),
    objective: z.string(),
    invariants: z.array(z.string()),
    completedFiles: z.array(z.string()),
    pendingFiles: z.array(z.string()),
    unresolvedViolations: z.array(z.string()),
    bootstrapPrompt: z.string().min(1),
  })
  .passthrough();

export type RadarZone = z.infer<typeof RadarZoneSchema>;
export type RadarTelemetry = z.infer<typeof RadarTelemetrySchema>;
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;
export type GroundCrewHandoff = z.infer<typeof GroundCrewHandoffSchema>;

export const CONTEXT_WINDOW_TOKENS = 128_000;

export function zoneFor(input: { utilization: number; consecutiveIdenticalReads: number; consecutiveFailures: number }): RadarZone {
  if (input.utilization > 0.65 || input.consecutiveFailures >= 3 || input.consecutiveIdenticalReads >= 3) return "RED";
  if (input.utilization >= 0.4 || input.consecutiveIdenticalReads >= 2) return "YELLOW";
  return "GREEN";
}
