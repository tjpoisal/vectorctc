import { simulateSource } from "../../engine/simulate.js";
import type { SemanticConfig } from "../../config/schema.js";
import type { FlightPlanContract } from "../../schemas/flightPlan.js";
import type { GateViolation } from "../../schemas/gate.js";
import { diffLines, unifiedDiff } from "../diff.js";
import { referencesTo } from "../references.js";
import { semanticProviderFromEnv, type SemanticProviderConfig } from "./config.js";
import { filterFindings, parseReply } from "./filter.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { httpModelClient, type ModelClient } from "./provider.js";

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = { enabled: true, mode: "block", minConfidence: 0.8, maxFindings: 3, timeoutMs: 30_000 };

export interface SemanticSummary {
  status: "skipped" | "ran" | "error";
  reason?: string;
  provider?: string;
  model?: string;
  mode?: "block" | "warn";
  kept: number;
  dropped: Array<{ reason: string }>;
  ms: number;
}

export interface SemanticOutcome {
  summary: SemanticSummary;
  /** Kept findings (blocking in "block" mode, advisory in "warn" mode). */
  findings: GateViolation[];
}

export interface SemanticReviewInput {
  root: string;
  relativePath: string;
  before: string | null;
  after: string;
  plan: FlightPlanContract;
  deterministic: readonly GateViolation[];
  settings?: SemanticConfig;
  /** Override the provider (tests, custom integrations). Defaults to the HTTP client from the environment. */
  client?: ModelClient;
  env?: NodeJS.ProcessEnv;
}

export function semanticAvailability(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; reason?: string; config?: SemanticProviderConfig } {
  const found = semanticProviderFromEnv(env);
  return found.enabled ? { enabled: true, config: found.config } : { enabled: false, reason: found.reason };
}

/** Names of functions and members whose bodies the edit touches; their call sites and tests go in the prompt. */
function touchedNames(relativePath: string, after: string, changed: Set<number>): string[] {
  const source = simulateSource(relativePath, after);
  if (!source) return [];
  const names = new Set<string>();
  const visit = (name: string | undefined, start: number, end: number): void => {
    if (!name) return;
    for (let line = start; line <= end; line += 1) {
      if (changed.has(line)) {
        names.add(name);
        return;
      }
    }
  };
  for (const fn of source.getFunctions()) visit(fn.getName(), fn.getStartLineNumber(), fn.getEndLineNumber());
  for (const cls of source.getClasses()) for (const method of cls.getMethods()) visit(method.getName(), method.getStartLineNumber(), method.getEndLineNumber());
  for (const statement of source.getVariableStatements()) for (const decl of statement.getDeclarations()) visit(decl.getName(), decl.getStartLineNumber(), decl.getEndLineNumber());
  return [...names].slice(0, 6);
}

export async function semanticReview(input: SemanticReviewInput): Promise<SemanticOutcome> {
  const started = performance.now();
  const settings = input.settings ?? DEFAULT_SEMANTIC_CONFIG;
  const skip = (reason: string): SemanticOutcome => ({ summary: { status: "skipped", reason, kept: 0, dropped: [], ms: performance.now() - started }, findings: [] });
  if (!settings.enabled || input.plan.disabledRules.includes("semantic")) return skip("disabled in config");
  let client = input.client;
  let provider = "custom";
  let model = "custom";
  if (!client) {
    const available = semanticAvailability(input.env);
    if (!available.enabled || !available.config) return skip(available.reason ?? "not configured");
    client = httpModelClient(available.config);
    provider = available.config.provider;
    model = available.config.model;
  }
  const { changedNewLines } = diffLines(input.before, input.after);
  if (changedNewLines.size === 0) return skip("no changed lines");
  const names = touchedNames(input.relativePath, input.after, changedNewLines);
  const user = buildUserPrompt({
    relativePath: input.relativePath,
    after: input.after,
    diff: unifiedDiff(input.relativePath, input.before, input.after),
    changedLines: changedNewLines,
    plan: input.plan,
    references: names.map((name) => ({ name, refs: referencesTo(input.root, null, input.relativePath, name, 6) })),
    deterministic: input.deterministic,
  });
  let reply: string;
  try {
    reply = await client({ system: SYSTEM_PROMPT, user, timeoutMs: settings.timeoutMs });
  } catch (error) {
    // Fail open: a provider outage must not block writes the deterministic gate already cleared.
    return {
      summary: { status: "error", reason: error instanceof Error ? error.message : String(error), provider, model, mode: settings.mode, kept: 0, dropped: [], ms: performance.now() - started },
      findings: [],
    };
  }
  const parsed = parseReply(reply);
  if (!parsed) {
    return { summary: { status: "error", reason: "model reply was not JSON", provider, model, mode: settings.mode, kept: 0, dropped: [], ms: performance.now() - started }, findings: [] };
  }
  const { kept, dropped } = filterFindings(parsed.findings, {
    relativePath: input.relativePath,
    after: input.after,
    changedLines: changedNewLines,
    deterministic: input.deterministic,
    minConfidence: settings.minConfidence,
    maxFindings: settings.maxFindings,
  });
  return {
    summary: { status: "ran", provider, model, mode: settings.mode, kept: kept.length, dropped: dropped.map((item) => ({ reason: item.reason })), ms: performance.now() - started },
    findings: kept,
  };
}
