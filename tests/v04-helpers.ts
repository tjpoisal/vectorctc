import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import { clearGateProjectsForTests } from "../src/gate/overlay.js";
import { FlightPlanSchema, type FlightPlanContract } from "../src/schemas/flightPlan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    clearGateProjectsForTests(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export function repo(files: Record<string, string>, opts: { tsconfig?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-v04-"));
  roots.push(root);
  if (opts.tsconfig !== false) {
    files["tsconfig.json"] ??= JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] });
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

export function plan(extra: Partial<FlightPlanContract> = {}): FlightPlanContract {
  return FlightPlanSchema.parse({ planId: "p", taskId: "t", createdAt: "2026-01-01T00:00:00Z", allowedFileGlobs: ["src/**"], ...extra });
}
