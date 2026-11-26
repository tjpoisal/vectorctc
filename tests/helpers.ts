import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const baseConfig = {
  version: 1,
  activeMilestone: {
    id: "foundation",
    title: "Foundation",
    allowedPaths: ["src/**"],
    status: "active",
  },
  lockedFiles: ["src/locked.ts"],
  bannedImports: [
    {
      pattern: "axios",
      reason: "Use the project fetch client.",
      useInstead: "src/lib/http.ts",
    },
  ],
  restrictedCalls: [
    {
      callPattern: "eval",
      inPaths: ["**"],
      useInstead: "a named function, never eval",
    },
  ],
  degradation: {
    maxFunctionLength: null,
    maxCyclomaticComplexity: null,
    flagUnusedImports: false,
  },
  circuitBreaker: { maxStrikes: 3 },
  // Naming is documented as off by default. Several tests use a naming violation as their "bad write",
  // so the shared fixture opts in explicitly (before bench-fixes the gate ignored this flag).
  rules: { naming: { enabled: true } },
};

export function makeProject(config: unknown = baseConfig): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-"));
  fs.writeFileSync(path.join(root, "ctc.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return root;
}

export function removeProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export const bannedImportSource = ["const ready = true;", "", 'import axios from "axios";', "", "export const value = ready;", ""].join("\n");

export const restrictedCallSource = [
  "export function run(input: string): unknown {",
  "  const wrapped = input;",
  "  return eval(wrapped);",
  "}",
  "",
].join("\n");

export const cleanSource = "export const ok = true;\n";
