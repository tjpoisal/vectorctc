import type { PrimaryGate, Violation } from "./types.js";

export const HOLD_PROTOCOL = "ctc.hold.v1";
export const CLEARED_PROTOCOL = "ctc.cleared.v1";
export const FLIGHTPLAN_PROTOCOL = "ctc.flightplan.v1";
export const RADAR_PROTOCOL = "ctc.radar.v1";

export interface CtcWritePayload {
  protocol: typeof HOLD_PROTOCOL | typeof CLEARED_PROTOCOL;
  cleared: boolean;
  written: boolean;
  gate: PrimaryGate;
  file: string | null;
  strikes: number;
  maxStrikes: number;
  circuit: "open" | "closed";
  violations: Violation[];
  bytesWritten: number | null;
  selfCorrection: string | null;
  warnings: Violation[];
  /** v0.3: status of the optional semantic review step ("skipped" with a reason when no key is configured). */
  /** v0.4: explain-the-block report (ctc.explain.v1). */
  explain?: import("../explain/explain.js").ExplainReport;
  /** v0.4: fix handoff loop status. */
  fixLoop?: import("../explain/ledger.js").FixLoopStatus;
  semanticReview?: { status: "skipped" | "ran" | "error"; reason?: string; provider?: string; model?: string; mode?: "block" | "warn"; kept: number; dropped: Array<{ reason: string }>; ms: number };
}

const GATE_PRIORITY: Violation["gate"][] = ["circuit", "lock", "scope", "config", "ast"];

export const WAVE_OFF_HEADER = "[CTC RUNWAY GATE — WAVE OFF]";
export const CIRCUIT_BREAKER_HEADER = "[CTC CIRCUIT BREAKER — HUMAN OVERRIDE REQUIRED]";

export function primaryGate(violations: readonly Violation[]): PrimaryGate {
  for (const gate of GATE_PRIORITY) {
    if (violations.some((item) => item.gate === gate)) return gate;
  }
  return "none";
}

function violationLines(item: Violation): string[] {
  const where = item.line == null ? "" : ` at line ${item.line}`;
  return [`Violation: ${item.code}${where}: ${item.message}`, `Required Action: ${item.useInstead ?? item.fix}`];
}

/** Human-readable block the calling model sees before the structured hold JSON. */
export function buildWaveOff(input: {
  file: string | null;
  circuitOpen: boolean;
  violations: readonly Violation[];
}): string {
  const substantive = input.violations.filter((item) => item.code !== "CIRCUIT_OPEN");
  const ordered = substantive.length > 0 ? substantive : [...input.violations];
  const file = input.file ?? ordered[0]?.file ?? "(unknown)";
  const lines = [WAVE_OFF_HEADER, `File: ${file}`];
  const lead = ordered[0];
  if (lead) lines.push(...violationLines(lead));
  for (const extra of ordered.slice(1)) lines.push(...violationLines(extra));
  if (input.circuitOpen) {
    lines.push("");
    lines.push(CIRCUIT_BREAKER_HEADER);
  }
  return lines.join("\n");
}

export function buildSelfCorrection(input: {
  cleared: boolean;
  gate: PrimaryGate;
  file: string | null;
  strikes: number;
  maxStrikes: number;
  circuitOpen: boolean;
  violations: readonly Violation[];
}): string | null {
  if (input.cleared) return null;
  const lines = [
    buildWaveOff(input),
    "",
    input.circuitOpen
      ? `The breaker is open for this file after ${input.strikes} consecutive rejections. Stop and get a human waiver via ctc_log_decision decision "waived" before proposing this file again.`
      : "The write was rejected before it touched disk. Fix every violation, then call ctc_propose_write again with the full corrected file. Do not write this file with any other tool.",
    `Gate: ${input.gate}`,
    `Strikes: ${input.strikes}/${input.maxStrikes}. Circuit ${input.circuitOpen ? "open" : "closed"}.`,
  ];
  return lines.join("\n");
}

export function formatHoldForModel(payload: CtcWritePayload): string {
  const block = buildWaveOff({
    file: payload.file,
    circuitOpen: payload.circuit === "open",
    violations: payload.violations,
  });
  return `${block}\n\n${JSON.stringify(payload, null, 2)}`;
}

export function holdPayload(input: {
  file: string | null;
  strikes: number;
  maxStrikes: number;
  circuitOpen: boolean;
  violations: Violation[];
}): CtcWritePayload {
  const blocking = input.violations.filter((item) => item.severity !== "warn");
  const warnings = input.violations.filter((item) => item.severity === "warn");
  const gate = primaryGate(blocking);
  return {
    protocol: HOLD_PROTOCOL,
    cleared: false,
    written: false,
    gate,
    file: input.file,
    strikes: input.strikes,
    maxStrikes: input.maxStrikes,
    circuit: input.circuitOpen ? "open" : "closed",
    violations: blocking,
    bytesWritten: null,
    warnings,
    selfCorrection: buildSelfCorrection({
      cleared: false,
      gate,
      file: input.file,
      strikes: input.strikes,
      maxStrikes: input.maxStrikes,
      circuitOpen: input.circuitOpen,
      violations: blocking,
    }),
  };
}

export function clearedPayload(input: {
  file: string | null;
  maxStrikes: number;
  written: boolean;
  bytesWritten: number | null;
  warnings?: Violation[];
}): CtcWritePayload {
  return {
    protocol: CLEARED_PROTOCOL,
    cleared: true,
    written: input.written,
    gate: "none",
    file: input.file,
    strikes: 0,
    maxStrikes: input.maxStrikes,
    circuit: "closed",
    violations: [],
    bytesWritten: input.bytesWritten,
    selfCorrection: null,
    warnings: input.warnings ?? [],
  };
}
