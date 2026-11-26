import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig } from "../config/load.js";
import { findProjectRoot } from "../paths.js";
import { onboardIdea, promoteTask, updateTaskStatus } from "../blueprint/store.js";
import { remember } from "../memory/sync.js";
import type { FlightPlanCanary } from "../schemas/flightPlan.js";

function textResult(payload: unknown, isError = false): CallToolResult {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function rootOf(projectRoot: string | undefined, fallback: string): string {
  return findProjectRoot(projectRoot ?? fallback);
}

function rememberSafe(root: string, content: string, tags: string[]): void {
  try {
    remember(root, loadConfig(root), { content, tags });
  } catch {
    // Unimatrix and a missing config never block onboarding.
  }
}

const taskShape = {
  taskId: z.string(),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).optional(),
  dependsOn: z.array(z.string()).optional(),
  targetFiles: z.array(z.string()).min(1),
  acceptanceCriteria: z.array(z.string()).optional(),
  summary: z.string().optional(),
};

const canaryShape = z.object({
  id: z.string(),
  description: z.string().optional(),
  targetFileGlob: z.string(),
  requiredPattern: z.string(),
});

export function registerOnboardingTools(server: McpServer, defaultRoot: string): void {
  server.registerTool(
    "ctc_onboard_idea",
    {
      title: "Onboard a feature idea",
      description:
        "Validate a structured blueprint and write .ctc/blueprint.json. No model is called. A raw idea with no tasks returns questions and a template. The dependency graph must be acyclic and every dependsOn id must exist.",
      inputSchema: {
        projectName: z.string().optional(),
        rawIdea: z.string(),
        architectureSummary: z.string().optional(),
        components: z.array(z.object({ name: z.string(), responsibility: z.string().optional(), files: z.array(z.string()).optional() })).optional(),
        globalInvariants: z.array(z.string()).optional(),
        boundaries: z.array(z.object({ sourcePattern: z.string(), forbiddenImports: z.array(z.string()).min(1) })).optional(),
        globalBannedPackages: z.array(z.string()).optional(),
        tasks: z.array(z.object(taskShape)).optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ projectName, rawIdea, architectureSummary, components, globalInvariants, boundaries, globalBannedPackages, tasks, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const name = projectName?.trim() || "project";
      const result = onboardIdea(
        root,
        {
          rawIdea,
          ...(architectureSummary ? { architectureSummary } : {}),
          ...(components ? { components: components.map((item) => ({ name: item.name, responsibility: item.responsibility ?? "", files: item.files ?? [] })) } : {}),
          ...(globalInvariants ? { globalInvariants } : {}),
          ...(boundaries ? { boundaries } : {}),
          ...(globalBannedPackages ? { globalBannedPackages } : {}),
          ...(tasks
            ? {
                tasks: tasks.map((task) => ({
                  taskId: task.taskId,
                  status: task.status ?? "TODO",
                  dependsOn: task.dependsOn ?? [],
                  targetFiles: task.targetFiles,
                  acceptanceCriteria: task.acceptanceCriteria ?? [],
                  verifiedByGate: false,
                  summary: task.summary ?? "",
                })),
              }
            : {}),
        },
        name,
      );
      if ("questions" in result) {
        return textResult({ protocol: "ctc.blueprint.v1", cleared: false, persisted: false, questions: result.questions, template: result.template });
      }
      if ("errors" in result) return textResult({ protocol: "ctc.blueprint.v1", cleared: false, persisted: false, errors: result.errors }, true);
      rememberSafe(root, `Blueprint ${result.blueprint.projectName}: ${result.blueprint.rawIdea}`, ["ctc", "blueprint", "invariant"]);
      return textResult({ protocol: "ctc.blueprint.v1", cleared: true, persisted: true, blueprint: result.blueprint });
    },
  );

  server.registerTool(
    "ctc_promote_task_to_flight_plan",
    {
      title: "Promote a task to a flight plan",
      description:
        "Check dependsOn, mark one task IN_PROGRESS, and write .ctc/flight-plan.json locked to that task's targetFiles as allowedFileGlobs.",
      inputSchema: {
        taskId: z.string(),
        sessionId: z.string().optional(),
        canaries: z.array(canaryShape).optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ taskId, sessionId, canaries, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const prepared: FlightPlanCanary[] = (canaries ?? []).map((canary) => ({
        id: canary.id,
        description: canary.description ?? "",
        targetFileGlob: canary.targetFileGlob,
        requiredPattern: canary.requiredPattern,
      }));
      const result = promoteTask(root, taskId, sessionId ?? "local", prepared);
      if (!result.ok) return textResult({ protocol: "ctc.flightplan.v1", cleared: false, errors: result.errors }, true);
      rememberSafe(root, `Task ${taskId} is IN_PROGRESS. ${result.plan.objective}`, ["ctc", "task", "IN_PROGRESS", "invariant"]);
      return textResult({ protocol: "ctc.flightplan.v1", cleared: true, taskId, plan: result.plan, blueprint: result.blueprint });
    },
  );

  server.registerTool(
    "ctc_update_task",
    {
      title: "Update a blueprint task",
      description: "Change a task's status. DONE is rejected until every concrete targetFile passes RunwayGateAnalyzer. Glob targets are not required to exist as files.",
      inputSchema: {
        taskId: z.string(),
        status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]),
        projectRoot: z.string().optional(),
      },
    },
    async ({ taskId, status, projectRoot }) => {
      const root = rootOf(projectRoot, defaultRoot);
      const result = updateTaskStatus(root, taskId, status);
      if (!result.ok) {
        return textResult({ protocol: "ctc.blueprint.v1", cleared: false, taskId, errors: result.errors, violations: result.violations }, true);
      }
      const task = result.blueprint.tasks.find((item) => item.taskId === taskId);
      rememberSafe(root, `Task ${taskId} is ${status}. ${task?.summary ?? ""}`, ["ctc", "task", status]);
      return textResult({ protocol: "ctc.blueprint.v1", cleared: true, taskId, status, verifiedByGate: task?.verifiedByGate ?? false, blueprint: result.blueprint });
    },
  );
}
