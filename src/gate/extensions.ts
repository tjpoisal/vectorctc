import type { FlightPlanContract } from "../schemas/flightPlan.js";
import type { GateViolation } from "../schemas/gate.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { crossRepoViolations } from "../crossrepo/impact.js";
import { intentViolations } from "../intent/intent.js";
import { polyglotViolations } from "../lang/polyglot.js";
import { wireframeViolations } from "../wireframe/drift.js";
import { behaviorViolations } from "../behavior/checks.js";

export interface ExtensionInput {
  root: string;
  relativePath: string;
  before: string | null;
  after: string;
  plan: FlightPlanContract | null;
  policy: EffectivePolicy;
}

export type ExtensionCheck = (input: ExtensionInput) => GateViolation[];

/** Built-in v0.4 extensions, run by the pipeline after the core analyzer for every file type. */
export const BUILTIN_EXTENSIONS: Array<{ id: string; check: ExtensionCheck }> = [
  { id: "python-go", check: (input) => polyglotViolations(input) },
  { id: "cross-repo", check: (input) => crossRepoViolations(input) },
  { id: "intent", check: (input) => intentViolations(input) },
  { id: "behavior", check: (input) => behaviorViolations(input) },
  { id: "wireframes", check: ({ root, relativePath, before, after, plan }) => wireframeViolations(root, relativePath, before, after, plan) },
];
