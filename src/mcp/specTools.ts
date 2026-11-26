import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { findProjectRoot } from "../paths.js";
import { appendRadar } from "../engine/radar-memory.js";
import { applyPatchReviewed, applyWriteReviewed } from "../gate/apply.js";
import { readFile } from "../radar/read.js";
import { applyFix } from "../explain/apply-fix.js";
import { lastHeld, ledgerSummary } from "../explain/ledger.js";
import { listReplays, loadReplay } from "../replay/store.js";
import { effectivePolicy } from "../policy/policy.js";
import { importRuleFiles } from "../policy/rulefiles.js";
import { approveWireframe, listWireframes, loadOne, renderToFile, saveWireframe } from "../wireframe/cli.js";
import { WireframeSchema } from "../wireframe/schema.js";
import { renderWireframeSvg } from "../wireframe/render.js";

function textResult(payload: unknown, isError = false): CallToolResult {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function rootOf(projectRoot: string | undefined, fallback: string): string {
  return findProjectRoot(projectRoot ?? fallback);
}

export function registerSpecTools(server: McpServer, defaultRoot: string): void {
  server.registerTool(
    "ctc_write_file",
    {
      title: "Write a file through the runway gate",
      description:
        "Write one file if it matches the active task flight plan (allowedFileGlobs), passes canary and invariant checks, and clears RunwayGateAnalyzer. Three consecutive failures lock the session and write a ground-crew handoff into .ctc/state.json.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ path: filePath, content, sessionId, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const payload = await applyWriteReviewed(root, { path: filePath, content, ...(sessionId ? { sessionId } : {}) });
      appendRadar(root, {
        source: "ctc_write_file",
        decision: payload.cleared ? "cleared" : "rejected",
        gate: payload.cleared ? "none" : "ast",
        path: payload.file,
        summary: payload.message ?? (payload.cleared ? `Landed ${payload.file}.` : payload.violations[0]?.message ?? "Rejected."),
        strikes: payload.consecutiveFailures,
        circuitOpen: payload.locked,
        violations: [],
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_patch_file",
    {
      title: "Patch a file through the runway gate",
      description:
        "Apply one unique literal search/replace, then run the same checks as ctc_write_file. $ is not a substitute. The search must match exactly once.",
      inputSchema: {
        path: z.string(),
        hunks: z.array(z.object({ search: z.string(), replace: z.string() })).min(1),
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ path: filePath, hunks, sessionId, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const payload = await applyPatchReviewed(root, { path: filePath, hunks, ...(sessionId ? { sessionId } : {}) });
      appendRadar(root, {
        source: "ctc_patch_file",
        decision: payload.cleared ? "cleared" : "rejected",
        gate: payload.cleared ? "none" : "ast",
        path: payload.file,
        summary: payload.message ?? (payload.cleared ? `Patched ${payload.file}.` : payload.violations[0]?.message ?? "Rejected."),
        strikes: payload.consecutiveFailures,
        circuitOpen: payload.locked,
        violations: [],
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_read_file",
    {
      title: "Read a file with radar zones",
      description:
        "Read a repo file and track estimated tokens (characters / 4) plus consecutive identical reads. The second identical read is YELLOW and returns TypeScript signatures with bodies elided. The third identical read locks RED and writes a ground-crew handoff to .ctc/state.json. A new sessionId, a read of .ctc/state.json, or `ctc reset` clears the lock.",
      inputSchema: {
        path: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        forceFull: z.boolean().optional(),
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ path: filePath, startLine, endLine, forceFull, sessionId, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const payload = readFile(root, {
        path: filePath,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(forceFull !== undefined ? { forceFull } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      appendRadar(root, {
        source: "ctc_read_file",
        decision: payload.cleared ? "noted" : "rejected",
        gate: payload.locked ? "circuit" : null,
        path: payload.file,
        summary: payload.warning ?? payload.message ?? `Read ${payload.file}.`,
        strikes: payload.telemetry.consecutiveIdenticalReads,
        circuitOpen: payload.locked,
        violations: [],
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_apply_fix",
    {
      title: "Apply the gate's suggested fixes",
      description:
        "Apply the suggested fix patches from the last held proposal for a file (all of them, or only `ids` from explain.explanations[].id) and run the result through the gate. It is written only if it clears; otherwise the response carries the next explain report.",
      inputSchema: { path: z.string(), ids: z.array(z.string()).optional(), sessionId: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ path: filePath, ids, sessionId, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const payload = await applyFix(root, filePath, ids, sessionId);
      return textResult(payload, !(payload.result?.cleared ?? false));
    },
  );

  server.registerTool(
    "ctc_explain",
    {
      title: "Explain the last block",
      description: "Return the explain-the-block report (rule, exact lines, why, fix patch) for the last held proposal of a file, or the fix-loop summary for every file when no path is given.",
      inputSchema: { path: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ path: filePath, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      if (!filePath) return textResult({ protocol: "ctc.fixloop.v1", files: ledgerSummary(root) });
      const last = lastHeld(root, filePath);
      return textResult(last ? { protocol: "ctc.explain.v1", file: filePath, explanations: last.explanations } : { protocol: "ctc.explain.v1", file: filePath, explanations: [], message: "Nothing is held for this file." });
    },
  );

  server.registerTool(
    "ctc_replay",
    {
      title: "Replay why a write was held",
      description: "Return a stored replay of a held or observed write: the attempted change as a unified diff, each rule broken, why it exists and the suggested fix. No id: the newest replay. list=true: the 20 newest replay ids.",
      inputSchema: { id: z.string().regex(/^[a-f0-9]{1,64}$/).optional(), list: z.boolean().optional(), projectRoot: z.string().optional() },
    },
    async ({ id, list, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      if (list) return textResult({ protocol: "ctc.replay.list.v1", replays: listReplays(root, 20).map((item) => ({ id: item.id, ts: item.ts, file: item.file, decision: item.decision, codes: item.explanations.map((entry) => entry.code) })) });
      const replay = loadReplay(root, id ?? { last: true });
      return textResult(replay ?? { protocol: "ctc.replay.v1", message: id ? `No unique replay matches '${id}'.` : "No replays stored yet (.ctc/replays is empty)." });
    },
  );

  server.registerTool(
    "ctc_policy",
    {
      title: "Show the effective policy",
      description: "Effective org → repo → directory policy for a path (mode, per-rule modes and which layer set them, conflicts) plus the rules CTC compiled from AGENTS.md, CLAUDE.md, Cursor rules and Copilot instructions.",
      inputSchema: { path: z.string().optional(), projectRoot: z.string().optional() },
    },
    async ({ path: filePath, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const policy = effectivePolicy(root, filePath ?? null);
      const rules = importRuleFiles(root);
      return textResult({ protocol: "ctc.policy.v1", path: filePath ?? null, policy: { ...policy, layers: policy.layers.map((layer) => ({ level: layer.level, source: layer.source })) }, ruleFiles: rules });
    },
  );

  server.registerTool(
    "ctc_wireframe",
    {
      title: "Propose, render and agree a wireframe",
      description:
        "Design phase for UI work. action 'propose' saves a low-fi wireframe (regions with components, as JSON) as a draft and returns its SVG; 'render' returns the SVG; 'agree' records the agent's agreement (bound to the layout hash) so UI writes for its files are allowed; 'list' shows all. UI code must mark components with data-wf=\"<component id>\" and regions with data-wf-region; the gate flags drift.",
      inputSchema: { action: z.enum(["propose", "render", "agree", "list"]), name: z.string().optional(), wireframe: z.unknown().optional(), projectRoot: z.string().optional() },
    },
    async ({ action, name, wireframe, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      try {
        if (action === "list") return textResult({ wireframes: listWireframes(root) });
        if (action === "propose") {
          const frame = WireframeSchema.parse({ ...(wireframe as object), status: "draft" });
          const file = saveWireframe(root, frame);
          renderToFile(root, frame);
          return textResult({ saved: file, status: "draft", svg: renderWireframeSvg(frame), next: `Show the SVG to the user. When they agree, call ctc_wireframe with action 'agree' and name '${frame.name}'.` });
        }
        if (!name) return textResult({ error: "name is required" }, true);
        if (action === "render") return textResult({ svg: renderWireframeSvg(loadOne(root, name)) });
        const frame = approveWireframe(root, name, process.env.CTC_ACTOR ?? "agent");
        return textResult({ approved: frame.name, approval: frame.approval });
      } catch (error) {
        return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );
}
