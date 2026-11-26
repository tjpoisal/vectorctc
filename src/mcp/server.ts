import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { findProjectRoot } from "../paths.js";
import { loadConfig } from "../config/load.js";
import { anyCircuitOpen, fileStrikes, loadState, noteLog, noteWaiver, saveState } from "../engine/circuit-breaker.js";
import { formatHoldForModel, RADAR_PROTOCOL } from "../engine/payload.js";
import { appendRadar, queryRadar } from "../engine/radar-memory.js";
import { checkFlightPlan, proposePatch, proposeWrite } from "../engine/runway-gate.js";
import { registerOnboardingTools } from "./onboardingTools.js";
import { registerSpecTools } from "./specTools.js";
import type { CtcWritePayload } from "../engine/payload.js";
import type { RadarDecision } from "../engine/types.js";
import { recallMemories, remember } from "../memory/sync.js";
import { setGateClient } from "../telemetry/client.js";

function textResult(payload: unknown, isError = false): CallToolResult {
  const json = JSON.stringify(payload, null, 2);
  const hold = isError && payload && typeof payload === "object" && "protocol" in payload && (payload as { protocol?: string }).protocol === "ctc.hold.v1";
  const text = hold ? formatHoldForModel(payload as CtcWritePayload) : json;
  return {
    isError,
    content: [{ type: "text", text }],
  };
}

function resolveRoot(projectRoot: string | undefined, fallback: string): string {
  return findProjectRoot(projectRoot ?? fallback);
}

const decisionSchema = z.enum(["cleared", "rejected", "noted", "waived"]);

export function createMcpServer(defaultRoot: string, version = "0.1.0"): McpServer {
  const server = new McpServer(
    { name: "code-traffic-control", version },
    {
      instructions:
        "Code Traffic Control sits in front of the filesystem. Start a feature with ctc_onboard_idea, then ctc_promote_task_to_flight_plan, then ctc_write_file or ctc_patch_file. Read through ctc_read_file. The second identical read is yellow and returns signatures. The third identical read locks red until a new session reads .ctc/state.json or a human runs ctc reset. ctc_propose_write and ctc_propose_patch remain the milestone gate. On a CTC HOLD, the text starts with [CTC RUNWAY GATE — WAVE OFF]. If the text includes [CTC CIRCUIT BREAKER — HUMAN OVERRIDE REQUIRED], stop and ask the user to waive that file.",
    },
  );

  // v0.5 report card: remember which client (clientInfo name/version) is behind this server's decisions.
  server.server.oninitialized = () => {
    setGateClient(server.server.getClientVersion());
  };

  server.registerTool(
    "ctc_propose_write",
    {
      title: "Propose a file write",
      description:
        "Submit the full contents of one file. CTC runs the Runway Gate in memory (lock, flight-plan scope, AST contract, circuit breaker) and writes the file only if every check passes. On rejection, obey selfCorrection and do not write the file yourself.",
      inputSchema: {
        path: z.string().describe("Repo-relative file path, using forward slashes."),
        content: z.string().describe("Full proposed file contents. Partial patches are rejected."),
        rationale: z.string().optional().describe("Why this write belongs on the active flight plan."),
        projectRoot: z.string().optional().describe("Project root. Defaults to the server working directory."),
      },
    },
    async ({ path: filePath, content, rationale, projectRoot }) => {
      const payload = proposeWrite({
        root: resolveRoot(projectRoot, defaultRoot),
        path: filePath,
        content,
        ...(rationale ? { rationale } : {}),
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_check_flightplan",
    {
      title: "Check a flight plan",
      description:
        "Validate repo-relative paths or globs against the active milestone ceiling and locked files. Set persist:true to save a passing plan to .ctc/flightplan.json, which then narrows later writes.",
      inputSchema: {
        paths: z.array(z.string()).describe("Files or globs this task will touch."),
        milestone: z.string().optional().describe("Milestone id. Defaults to activeMilestone. Must match it."),
        intent: z.string().optional().describe("Short description of the task."),
        persist: z.boolean().optional().describe("Write the plan to .ctc/flightplan.json when it clears. Default false. Persisting resets read-zone counters."),
        sessionId: z.string().optional().describe("Session label stored on the plan. planId and createdAt are generated when omitted."),
        invariants: z
          .array(
            z.object({
              id: z.string(),
              text: z.string(),
              forbiddenPattern: z.string().optional(),
              requiredPattern: z.string().optional(),
              inPaths: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe("Architectural invariants. forbiddenPattern and requiredPattern are enforced. Plain text is recorded."),
        canaries: z
          .array(
            z.object({
              id: z.string(),
              description: z.string(),
              targetFileGlob: z.string(),
              requiredPattern: z.string(),
            }),
          )
          .optional()
          .describe("Patterns that must remain in matching files."),
        projectRoot: z.string().optional().describe("Project root. Defaults to the server working directory."),
      },
    },
    async ({ paths, milestone, intent, persist, sessionId, invariants, canaries, projectRoot }) => {
      const payload = checkFlightPlan({
        root: resolveRoot(projectRoot, defaultRoot),
        paths,
        ...(milestone ? { milestone } : {}),
        ...(intent ? { intent } : {}),
        ...(persist !== undefined ? { persist } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(invariants ? { invariants } : {}),
        ...(canaries ? { canaries } : {}),
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_log_decision",
    {
      title: "Log a radar decision",
      description:
        'Append a human or agent decision to the radar log. decision "waived" resets the circuit breaker unless resetCircuit is false. Use a waiver only when the user explicitly clears the breaker.',
      inputSchema: {
        decision: decisionSchema.describe("cleared, rejected, noted, or waived."),
        summary: z.string().describe("What was decided, in one or two sentences."),
        path: z.string().optional().describe("Repo-relative path this decision is about."),
        gate: z.string().optional().describe("Gate name, when the decision is about one."),
        resetCircuit: z.boolean().optional().describe('Defaults to true when decision is "waived", otherwise false.'),
        projectRoot: z.string().optional().describe("Project root. Defaults to the server working directory."),
      },
    },
    async ({ decision, summary, path: filePath, gate, resetCircuit, projectRoot }) => {
      const root = resolveRoot(projectRoot, defaultRoot);
      const state = loadState(root);
      const shouldReset = resetCircuit ?? decision === "waived";
      const next = shouldReset ? noteWaiver(state, summary) : noteLog(state, decision, summary);
      saveState(root, next);
      const entry = appendRadar(root, {
        source: "ctc_log_decision",
        decision: decision as RadarDecision,
        gate: gate === "lock" || gate === "scope" || gate === "ast" || gate === "circuit" || gate === "config" || gate === "none" ? gate : null,
        path: filePath ?? null,
        summary,
        strikes: filePath ? fileStrikes(next, filePath).consecutiveRejections : 0,
        circuitOpen: anyCircuitOpen(next),
        violations: [],
      });
      const fileBreaker = filePath ? fileStrikes(next, filePath) : { consecutiveRejections: 0, circuitOpen: anyCircuitOpen(next) };
      try {
        const config = loadConfig(root);
        remember(root, config, {
          content: `${decision}: ${summary}`,
          tags: ["ctc", "decision", decision],
          file: filePath ?? null,
        });
      } catch {
        // A missing config still keeps the local radar entry.
      }
      return textResult({
        protocol: RADAR_PROTOCOL,
        cleared: true,
        entry,
        strikes: fileBreaker.consecutiveRejections,
        circuit: anyCircuitOpen(next) ? "open" : "closed",
      });
    },
  );

  registerOnboardingTools(server, defaultRoot);
  registerSpecTools(server, defaultRoot);

  server.registerTool(
    "ctc_propose_patch",
    {
      title: "Propose a literal patch",
      description:
        "Replace one unique literal snippet in an existing file, then run the same Runway Gate as ctc_propose_write. The replacement is literal: $ is not a substitute. The search must match exactly once.",
      inputSchema: {
        path: z.string().describe("Repo-relative file path."),
        hunks: z
          .array(z.object({ search: z.string().min(1), replace: z.string() }))
          .min(1)
          .describe("Literal search/replace hunks applied in order."),
        rationale: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ path: filePath, hunks, rationale, projectRoot }) => {
      const payload = proposePatch({
        root: resolveRoot(projectRoot, defaultRoot),
        path: filePath,
        hunks,
        ...(rationale ? { rationale } : {}),
      });
      return textResult(payload, !payload.cleared);
    },
  );

  server.registerTool(
    "ctc_query_radar",
    {
      title: "Query the radar log",
      description: "Read recent radar entries, newest first. Filter by gate, path, decision, source, or an ISO timestamp.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Maximum entries to return. Default 50."),
        gate: z.string().optional().describe("Exact gate: lock, scope, ast, circuit, config, or none."),
        path: z.string().optional().describe("Exact repo-relative path."),
        decision: decisionSchema.optional().describe("cleared, rejected, noted, or waived."),
        source: z
          .enum([
            "ctc_propose_write",
            "ctc_propose_patch",
            "ctc_read_file",
            "ctc_check_flightplan",
            "ctc_log_decision",
            "ctc_hook",
            "ctc_write_file",
            "ctc_patch_file",
            "ctc_onboard_idea",
            "ctc_promote_task_to_flight_plan",
            "ctc_update_task",
          ])
          .optional()
          .describe("Which tool recorded the entry."),
        since: z.string().optional().describe("Include entries at or after this ISO-8601 timestamp."),
        projectRoot: z.string().optional().describe("Project root. Defaults to the server working directory."),
      },
    },
    async ({ limit, gate, path: filePath, decision, source, since, projectRoot }) => {
      const root = resolveRoot(projectRoot, defaultRoot);
      const entries = queryRadar(root, {
        ...(limit !== undefined ? { limit } : {}),
        ...(gate ? { gate } : {}),
        ...(filePath ? { path: filePath } : {}),
        ...(decision ? { decision } : {}),
        ...(source ? { source } : {}),
        ...(since ? { since } : {}),
      });
      let memories: unknown[] = [];
      try {
        memories = await recallMemories(loadConfig(root), filePath ?? "ctc runway gate");
      } catch {
        memories = [];
      }
      return textResult({
        protocol: RADAR_PROTOCOL,
        cleared: true,
        count: entries.length,
        entries,
        memories,
      });
    },
  );

  return server;
}
