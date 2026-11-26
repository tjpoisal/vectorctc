import type { SourceFile } from "ts-morph";

import type { CtcConfig, FlightPlan } from "../config/schema.js";

export type ViolationGate = "lock" | "scope" | "ast" | "circuit" | "config";

export type PrimaryGate = ViolationGate | "none";

export interface Violation {
  code: string;
  rule: string;
  gate: ViolationGate;
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  fix: string;
  /** Module, hook, or other exact replacement. Null when the fix is not an import. */
  useInstead: string | null;
  severity: "block" | "warn";
  similarity?: number | null;
  tsDiagnosticCode?: number | null;
  /** v0.4: logged in observe mode; would have blocked under enforce. */
  observed?: boolean;
  cwe?: string;
}

export interface RuleContext {
  root: string;
  relativePath: string;
  content: string;
  config: CtcConfig;
  sourceFile: SourceFile | null;
  flightPlan: FlightPlan | null;
}

export interface Rule {
  id: string;
  gate: ViolationGate;
  order: number;
  check(ctx: RuleContext): Violation[];
}

export type RadarSource =
  | "ctc_propose_write"
  | "ctc_propose_patch"
  | "ctc_read_file"
  | "ctc_check_flightplan"
  | "ctc_log_decision"
  | "ctc_hook"
  | "ctc_write_file"
  | "ctc_patch_file"
  | "ctc_onboard_idea"
  | "ctc_promote_task_to_flight_plan"
  | "ctc_update_task";

export type RadarDecision = "cleared" | "rejected" | "noted" | "waived";

export interface RadarEntry {
  id: string;
  ts: string;
  source: RadarSource;
  decision: RadarDecision;
  gate: PrimaryGate | null;
  path: string | null;
  summary: string;
  strikes: number;
  circuitOpen: boolean;
  violations: Violation[];
}

export function violation(
  input: Omit<Violation, "useInstead" | "severity"> & {
    useInstead?: string | null;
    severity?: Violation["severity"];
    similarity?: number | null;
    tsDiagnosticCode?: number | null;
  },
): Violation {
  return { ...input, useInstead: input.useInstead ?? null, severity: input.severity ?? "block" };
}
