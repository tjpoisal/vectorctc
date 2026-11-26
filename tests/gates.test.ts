import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadState } from "../src/engine/circuit-breaker.js";
import { WAVE_OFF_HEADER } from "../src/engine/payload.js";
import { proposeWrite } from "../src/engine/runway-gate.js";
import { bannedImportSource, baseConfig, cleanSource, makeProject, removeProject, restrictedCallSource } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

describe("lock gate", () => {
  it("rejects a locked file and does not write it", () => {
    const root = makeProject();
    roots.push(root);
    const target = path.join(root, "src", "locked.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const original = 1;\n");

    const result = proposeWrite({ root, path: "src/locked.ts", content: cleanSource });

    expect(result.cleared).toBe(false);
    expect(result.written).toBe(false);
    expect(result.protocol).toBe("ctc.hold.v1");
    expect(result.gate).toBe("lock");
    expect(result.violations[0]?.code).toBe("LOCKED_FILE");
    expect(result.violations[0]?.line).toBeNull();
    expect(result.selfCorrection?.startsWith(WAVE_OFF_HEADER)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("export const original = 1;\n");
  });

  it("always locks CTC control files", () => {
    const root = makeProject({ ...baseConfig, lockedFiles: [] });
    roots.push(root);
    const before = fs.readFileSync(path.join(root, "ctc.config.json"), "utf8");
    const result = proposeWrite({ root, path: "ctc.config.json", content: "{}\n" });
    expect(result.gate).toBe("lock");
    expect(result.violations.some((item) => item.code === "LOCKED_FILE")).toBe(true);
    expect(fs.readFileSync(path.join(root, "ctc.config.json"), "utf8")).toBe(before);
  });
});

describe("flight-plan scope gate", () => {
  it("rejects a path outside the active milestone", () => {
    const root = makeProject();
    roots.push(root);
    const result = proposeWrite({ root, path: "lib/other.ts", content: cleanSource });
    expect(result.cleared).toBe(false);
    expect(result.written).toBe(false);
    expect(result.gate).toBe("scope");
    expect(result.violations.some((item) => item.code === "RUNWAY_INCURSION")).toBe(true);
    expect(result.violations[0]?.message.startsWith("RUNWAY INCURSION:")).toBe(true);
    expect(fs.existsSync(path.join(root, "lib", "other.ts"))).toBe(false);
  });

  it("rejects a path outside a persisted flight plan even when the milestone ceiling allows it", async () => {
    const { checkFlightPlan } = await import("../src/engine/runway-gate.js");
    const root = makeProject();
    roots.push(root);
    const plan = checkFlightPlan({
      root,
      paths: ["src/ok/**"],
      intent: "Only the ok folder",
      persist: true,
    });
    expect(plan.cleared).toBe(true);
    expect(plan.persisted).toBe(true);

    const inside = proposeWrite({ root, path: "src/ok/a.ts", content: cleanSource });
    const outside = proposeWrite({ root, path: "src/other/a.ts", content: cleanSource });
    expect(inside.cleared).toBe(true);
    expect(outside.gate).toBe("scope");
    expect(outside.violations.some((item) => item.code === "RUNWAY_INCURSION")).toBe(true);
    expect(outside.selfCorrection).toContain("RUNWAY INCURSION:");
    expect(fs.existsSync(path.join(root, "src", "other", "a.ts"))).toBe(false);
  });

  it("rejects a flight plan that names a locked file", async () => {
    const { checkFlightPlan } = await import("../src/engine/runway-gate.js");
    const root = makeProject();
    roots.push(root);
    const plan = checkFlightPlan({ root, paths: ["src/locked.ts"], persist: true });
    expect(plan.cleared).toBe(false);
    expect(plan.persisted).toBe(false);
    expect(plan.violations.some((item) => item.code === "LOCKED_FILE")).toBe(true);
    expect(loadState(root).files).toEqual({});
  });

  it("rejects every write when the milestone is locked", () => {
    const root = makeProject({
      ...baseConfig,
      activeMilestone: { ...baseConfig.activeMilestone, status: "locked" },
    });
    roots.push(root);
    const result = proposeWrite({ root, path: "src/ok.ts", content: cleanSource });
    expect(result.cleared).toBe(false);
    expect(result.written).toBe(false);
    expect(result.violations.some((item) => item.code === "RUNWAY_INCURSION")).toBe(true);
    expect(result.selfCorrection).toContain("RUNWAY INCURSION:");
    expect(fs.existsSync(path.join(root, "src", "ok.ts"))).toBe(false);
  });
});

describe("AST contract gate", () => {
  it("rejects a banned import and reports the specifier line and column", () => {
    const root = makeProject();
    roots.push(root);
    const result = proposeWrite({ root, path: "src/api.ts", content: bannedImportSource });
    const hit = result.violations.find((item) => item.code === "BANNED_IMPORT");
    expect(result.written).toBe(false);
    expect(hit).toMatchObject({
      rule: "bannedImports",
      gate: "ast",
      file: "src/api.ts",
      line: 3,
      column: 19,
    });
    expect(hit?.message).toContain('Import "axios" is banned');
    expect(hit?.message).toContain("Use the project fetch client.");
    expect(hit?.useInstead).toBe("src/lib/http.ts");
    expect(result.selfCorrection?.startsWith(WAVE_OFF_HEADER)).toBe(true);
    expect(result.selfCorrection).toContain("File: src/api.ts");
    expect(result.selfCorrection).toContain("Violation: BANNED_IMPORT at line 3:");
    expect(result.selfCorrection).toContain("Required Action: src/lib/http.ts");
    expect(fs.existsSync(path.join(root, "src", "api.ts"))).toBe(false);
  });

  it("rejects a restricted call and reports the call line and column", () => {
    const root = makeProject();
    roots.push(root);
    const result = proposeWrite({ root, path: "src/run.ts", content: restrictedCallSource });
    const hit = result.violations.find((item) => item.code === "RESTRICTED_CALL");
    expect(hit).toMatchObject({
      file: "src/run.ts",
      line: 3,
      column: 10,
    });
    expect(hit?.message).toContain('Call to "eval" is restricted');
    expect(fs.existsSync(path.join(root, "src", "run.ts"))).toBe(false);
  });

  it("rejects new Function when Function is restricted", () => {
    const root = makeProject({
      ...baseConfig,
      restrictedCalls: [{ callPattern: "Function", inPaths: ["**"], useInstead: "a named function, never new Function" }],
    });
    roots.push(root);
    const result = proposeWrite({
      root,
      path: "src/make.ts",
      content: 'export const make = new Function("return 1");\n',
    });
    expect(result.violations.some((item) => item.code === "RESTRICTED_CALL" && item.line === 1)).toBe(true);
    expect(fs.existsSync(path.join(root, "src", "make.ts"))).toBe(false);
  });

  it("rejects a function that is too long or too complex when those rules are enabled", () => {
    const root = makeProject({
      ...baseConfig,
      degradation: { maxFunctionLength: 5, maxCyclomaticComplexity: 2, flagUnusedImports: false },
    });
    roots.push(root);
    const body = Array.from({ length: 8 }, (_, index) => `  const v${index} = ${index};`);
    const content = ["export function longOne(n: number): number {", ...body, "  if (n > 0 && n < 10) return n;", "  return 1;", "}", ""].join("\n");
    const result = proposeWrite({ root, path: "src/long.ts", content });
    expect(result.written).toBe(false);
    const length = result.violations.find((item) => item.code === "FUNCTION_TOO_LONG");
    const complexity = result.violations.find((item) => item.code === "COMPLEXITY");
    expect(length?.line).toBe(1);
    expect(length?.message).toContain("longOne");
    expect(complexity?.line).toBe(1);
    expect(complexity?.message).toMatch(/cyclomatic complexity 3/);
  });

  it("rejects an unused import and leaves used imports alone", () => {
    const root = makeProject({
      ...baseConfig,
      degradation: { maxFunctionLength: null, maxCyclomaticComplexity: null, flagUnusedImports: true },
    });
    roots.push(root);
    const content = [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "",
      'export const label = join("a", "b");',
      "",
    ].join("\n");
    const result = proposeWrite({ root, path: "src/paths.ts", content });
    const unused = result.violations.filter((item) => item.code === "UNUSED_IMPORT");
    expect(unused).toHaveLength(1);
    expect(unused[0]).toMatchObject({ line: 1, message: 'Import "readFileSync" is unused.' });
    expect(fs.existsSync(path.join(root, "src", "paths.ts"))).toBe(false);
  });
});
