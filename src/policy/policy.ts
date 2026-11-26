import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";

import { isSafeRegExp } from "../engine/safe-regex.js";
import { toPosix } from "../paths.js";

/**
 * Policy as code with inheritance (v0.4): org → repo → directory.
 *
 *   org:       $CTC_ORG_POLICY, or ctc.config.json "orgPolicy", or ~/.config/ctc/org-policy.json
 *   repo:      <root>/.ctc/policy.json
 *   directory: <dir>/.ctc-policy.json for every directory between the root and the file
 *
 * Later layers override earlier ones, except that a layer can mark a setting `locked`: lower layers may
 * make a locked rule stricter but never weaker (observe or off), and the attempt is reported as a
 * conflict instead of silently winning. `ctc policy explain <file>` shows which layer set each value.
 * Rollout is per rule: the whole policy, or any rule or code glob, can run in `observe` mode, where
 * findings are logged as "would have blocked" and the write proceeds.
 */

export type RuleMode = "enforce" | "observe" | "off";
const MODE_STRENGTH: Record<RuleMode, number> = { off: 0, observe: 1, enforce: 2 };

const ruleSettingSchema = z.object({
  mode: z.enum(["enforce", "observe", "off"]).optional(),
  locked: z.boolean().optional(),
  /** Paths the setting applies to (globs, repo-relative). Default: everywhere. */
  paths: z.array(z.string()).optional(),
});

const forbidSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().refine(isSafeRegExp, { message: "unsafe regular expression" }),
  message: z.string().min(1),
  fix: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

export const PolicyFileSchema = z.object({
  version: z.literal(1).default(1),
  /** Default mode for every rule this layer does not mention. */
  mode: z.enum(["enforce", "observe"]).optional(),
  lockMode: z.boolean().optional(),
  /** Keys are rule names (SecretScan), codes (SECRET_AWS_KEY) or code globs (SAST_*). */
  rules: z.record(z.string(), ruleSettingSchema).default({}),
  /** Regex rules (policy-as-code): a new line matching `pattern` is held with `message`. */
  forbid: z.array(forbidSchema).default([]),
  /** Import AGENTS.md, CLAUDE.md, Cursor rules and Copilot instructions as enforceable rules. Default true. */
  importRuleFiles: z.boolean().optional(),
  secrets: z.object({ allow: z.array(z.string()).default([]) }).partial().optional(),
  sca: z.object({ minSeverity: z.enum(["low", "moderate", "high", "critical"]).optional(), advisoryFile: z.string().optional() }).partial().optional(),
  /** Sibling repos checked for consumers of what this repo exports (CrossRepoImpact). Paths are relative to the repo root. */
  crossRepo: z
    .object({
      siblings: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).default([]),
    })
    .partial()
    .optional(),
  /** IntentCheck: "warn" (default) reports diffs unrelated to the ticket; "enforce" also blocks them; "off" disables. Out-of-scope clauses always block. */
  intent: z.object({ unrelated: z.enum(["warn", "enforce", "off"]).optional() }).partial().optional(),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export interface PolicyLayer {
  level: "org" | "repo" | "directory";
  source: string;
  policy: PolicyFile;
}

export interface EffectiveRule {
  mode: RuleMode;
  locked: boolean;
  setBy: string;
  paths?: string[];
}

export interface EffectivePolicy {
  layers: PolicyLayer[];
  mode: "enforce" | "observe";
  modeSetBy: string;
  rules: Record<string, EffectiveRule>;
  forbid: Array<PolicyFile["forbid"][number] & { source: string }>;
  importRuleFiles: boolean;
  secretAllow: string[];
  sca: { minSeverity: "low" | "moderate" | "high" | "critical"; advisoryFile: string | null };
  siblings: Array<{ name: string; path: string; source: string }>;
  intentUnrelated: "warn" | "enforce" | "off";
  conflicts: string[];
  errors: string[];
}

const cache = new Map<string, { mtime: number; layer: PolicyLayer | null; error: string | null }>();

function readLayer(file: string, level: PolicyLayer["level"], label: string): { layer: PolicyLayer | null; error: string | null } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { layer: null, error: null };
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return { layer: hit.layer, error: hit.error };
  let result: { layer: PolicyLayer | null; error: string | null };
  try {
    const policy = PolicyFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    result = { layer: { level, source: label, policy }, error: null };
  } catch (error) {
    result = { layer: null, error: `${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
  cache.set(file, { mtime: stat.mtimeMs, ...result });
  return result;
}

export function orgPolicyPath(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CTC_ORG_POLICY) return path.resolve(env.CTC_ORG_POLICY);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "ctc.config.json"), "utf8")) as { orgPolicy?: unknown };
    if (typeof raw.orgPolicy === "string" && raw.orgPolicy.length > 0) return path.resolve(root, raw.orgPolicy);
  } catch {
    // no config, or not JSON: fall through to the user-level default
  }
  const home = env.HOME ?? os.homedir();
  return home ? path.join(home, ".config", "ctc", "org-policy.json") : null;
}

export function policyLayers(root: string, relativePath: string | null, env: NodeJS.ProcessEnv = process.env): { layers: PolicyLayer[]; errors: string[] } {
  const layers: PolicyLayer[] = [];
  const errors: string[] = [];
  const push = (r: { layer: PolicyLayer | null; error: string | null }): void => {
    if (r.layer) layers.push(r.layer);
    if (r.error) errors.push(r.error);
  };
  const org = orgPolicyPath(root, env);
  if (org) push(readLayer(org, "org", `org:${org}`));
  push(readLayer(path.join(root, ".ctc", "policy.json"), "repo", ".ctc/policy.json"));
  if (relativePath) {
    const parts = toPosix(path.posix.dirname(toPosix(relativePath))).split("/").filter((part) => part && part !== ".");
    for (let depth = 0; depth <= parts.length; depth += 1) {
      const dir = parts.slice(0, depth).join("/");
      const label = dir ? `${dir}/.ctc-policy.json` : ".ctc-policy.json";
      push(readLayer(path.join(root, dir, ".ctc-policy.json"), "directory", label));
    }
  }
  return { layers, errors };
}

export function effectivePolicy(root: string, relativePath: string | null, env: NodeJS.ProcessEnv = process.env): EffectivePolicy {
  const { layers, errors } = policyLayers(root, relativePath, env);
  const out: EffectivePolicy = {
    layers,
    mode: "enforce",
    modeSetBy: "default",
    rules: {},
    forbid: [],
    importRuleFiles: true,
    secretAllow: [],
    sca: { minSeverity: "moderate", advisoryFile: null },
    siblings: [],
    intentUnrelated: "warn",
    conflicts: [],
    errors,
  };
  let modeLocked = false;
  for (const layer of layers) {
    const p = layer.policy;
    if (p.mode) {
      if (modeLocked && MODE_STRENGTH[p.mode] < MODE_STRENGTH[out.mode]) out.conflicts.push(`${layer.source} tried to set mode "${p.mode}", but ${out.modeSetBy} locked mode "${out.mode}".`);
      else {
        out.mode = p.mode;
        out.modeSetBy = layer.source;
      }
    }
    if (p.lockMode) modeLocked = true;
    for (const [key, setting] of Object.entries(p.rules)) {
      const prior = out.rules[key];
      const mode = setting.mode ?? prior?.mode ?? out.mode;
      if (prior?.locked && MODE_STRENGTH[mode] < MODE_STRENGTH[prior.mode]) {
        out.conflicts.push(`${layer.source} tried to set ${key} to "${mode}", but ${prior.setBy} locked it at "${prior.mode}".`);
        continue;
      }
      out.rules[key] = { mode, locked: (prior?.locked ?? false) || setting.locked === true, setBy: layer.source, ...(setting.paths ? { paths: setting.paths } : {}) };
    }
    for (const rule of p.forbid) out.forbid.push({ ...rule, source: layer.source });
    if (p.importRuleFiles !== undefined) out.importRuleFiles = p.importRuleFiles;
    if (p.secrets?.allow) out.secretAllow.push(...p.secrets.allow);
    if (p.sca?.minSeverity) out.sca.minSeverity = p.sca.minSeverity;
    if (p.sca?.advisoryFile) out.sca.advisoryFile = path.resolve(root, p.sca.advisoryFile);
    for (const sibling of p.crossRepo?.siblings ?? []) {
      const absolute = path.resolve(layer.level === "org" ? process.cwd() : root, sibling.path);
      out.siblings = out.siblings.filter((item) => item.name !== sibling.name);
      out.siblings.push({ name: sibling.name, path: absolute, source: layer.source });
    }
    if (p.intent?.unrelated) out.intentUnrelated = p.intent.unrelated;
  }
  return out;
}

/** Most specific match wins: exact code, then rule name, then the longest matching code glob, then the policy default. */
export function modeFor(policy: EffectivePolicy, finding: { rule: string; code: string }, relativePath: string): { mode: RuleMode; setBy: string } {
  const applies = (entry: EffectiveRule): boolean => !entry.paths || entry.paths.some((glob) => minimatch(relativePath, glob, { dot: true }));
  const exact = policy.rules[finding.code];
  if (exact && applies(exact)) return { mode: exact.mode, setBy: exact.setBy };
  const byRule = policy.rules[finding.rule];
  if (byRule && applies(byRule)) return { mode: byRule.mode, setBy: byRule.setBy };
  const globs = Object.entries(policy.rules)
    .filter(([key, entry]) => /[*?]/.test(key) && minimatch(finding.code, key) && applies(entry))
    .sort((a, b) => b[0].length - a[0].length);
  const glob = globs[0];
  if (glob) return { mode: glob[1].mode, setBy: glob[1].setBy };
  return { mode: policy.mode, setBy: policy.modeSetBy };
}
