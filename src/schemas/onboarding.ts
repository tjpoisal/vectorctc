import { z } from "zod";

export const TaskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]);

export const BlueprintTaskSchema = z.object({
  taskId: z.string().min(1),
  status: TaskStatusSchema.default("TODO"),
  dependsOn: z.array(z.string()).default([]),
  targetFiles: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  verifiedByGate: z.boolean().default(false),
  summary: z.string().default(""),
});

export const BlueprintComponentSchema = z.object({
  name: z.string().min(1),
  responsibility: z.string().default(""),
  files: z.array(z.string()).default([]),
});

export const BlueprintBoundarySchema = z.object({
  sourcePattern: z.string().min(1),
  forbiddenImports: z.array(z.string().min(1)).min(1),
});

export const PreFlightBlueprintSchema = z.object({
  projectName: z.string().min(1),
  rawIdea: z.string(),
  architectureSummary: z.string().default(""),
  components: z.array(BlueprintComponentSchema).default([]),
  globalInvariants: z.array(z.string()).default([]),
  boundaries: z.array(BlueprintBoundarySchema).default([]),
  globalBannedPackages: z.array(z.string()).default([]),
  tasks: z.array(BlueprintTaskSchema).default([]),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type BlueprintTask = z.infer<typeof BlueprintTaskSchema>;
export type BlueprintComponent = z.infer<typeof BlueprintComponentSchema>;
export type BlueprintBoundary = z.infer<typeof BlueprintBoundarySchema>;
export type PreFlightBlueprint = z.infer<typeof PreFlightBlueprintSchema>;

export function graphErrors(tasks: readonly Pick<BlueprintTask, "taskId" | "dependsOn">[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.taskId)) errors.push(`Duplicate taskId '${task.taskId}'.`);
    ids.add(task.taskId);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.taskId) errors.push(`Task '${task.taskId}' depends on itself.`);
      else if (!ids.has(dep)) errors.push(`Task '${task.taskId}' depends on missing task '${dep}'.`);
    }
  }
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const color = new Map<string, 0 | 1 | 2>();
  const reported = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
      if (!reported.has(cycle)) {
        reported.add(cycle);
        errors.push(`Dependency cycle: ${cycle}.`);
      }
      return;
    }
    if (state === 2) return;
    color.set(id, 1);
    const task = byId.get(id);
    for (const dep of task?.dependsOn ?? []) {
      if (ids.has(dep)) visit(dep, [...stack, id]);
    }
    color.set(id, 2);
  };
  for (const task of tasks) visit(task.taskId, []);
  return errors;
}
