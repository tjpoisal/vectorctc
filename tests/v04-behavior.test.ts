import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { behaviorViolations } from "../src/behavior/checks.js";
import { runSandbox } from "../src/behavior/sandbox.js";
import { effectivePolicy } from "../src/policy/policy.js";
import { plan, repo } from "./v04-helpers.js";

function check(root: string, file: string, after: string, objective: string) {
  const absolute = path.join(root, file);
  const before = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
  return behaviorViolations({ root, relativePath: file, before, after, plan: plan({ objective }), policy: effectivePolicy(root, file) });
}

const strings = `export function hasLeadingSlash(input = ""): boolean {
  return input.startsWith("/");
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return input.slice(0, Math.max(0, max - 1)) + "…";
}
`;

describe("v0.4 behavioural layer", () => {
  it("catches a reworded duplicate that token similarity misses, and leaves a genuinely different helper alone", () => {
    const root = repo({ "src/utils/strings.ts": strings, "src/parse.ts": "export const x = 1;\n" });
    const copy = `export const x = 1;\nconst beginsWithSlash = (value = ""): boolean => value.charAt(0) === "/";\nexport const isRoot = (s = "") => beginsWithSlash(s) && !s.startsWith("//");\n`;
    const found = check(root, "src/parse.ts", copy, "Add isRoot.");
    expect(found.map((v) => [v.code, v.line])).toEqual([["DUPLICATE_BEHAVIOR", 2]]);
    expect(found[0]?.message).toContain("hasLeadingSlash");
    const different = `export const x = 1;\nconst endsWithSlash = (value = ""): boolean => value.endsWith("/");\n`;
    expect(check(root, "src/parse.ts", different, "Add endsWithSlash.")).toEqual([]);
  });

  it("blocks an unrequested output change when the objective preserves behaviour, and points at the responsible line", () => {
    const root = repo({ "src/utils/strings.ts": strings });
    const after = strings.replace("export function truncate(input: string, max: number): string {", "export function truncate(input: string, max: number, ellipsis = \"…\"): string {").replace("input.length <= max", "input.length < max");
    const found = check(root, "src/utils/strings.ts", after, "Let truncate take an optional ellipsis argument.");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "BEHAVIOR_CHANGED", line: 6 });
    expect(found[0]?.severity).toBeUndefined();
    expect(found[0]?.message).toContain("only adds optional parameters");
  });

  it("stays silent when the objective asks for the change, and warns (does not block) when it is merely unmentioned", () => {
    const root = repo({ "src/utils/strings.ts": strings });
    const after = strings.replace("input.length <= max", "input.length < max");
    expect(check(root, "src/utils/strings.ts", after, "Change truncate so text exactly max long is cut (use <).")).toEqual([]);
    const unmentioned = check(root, "src/utils/strings.ts", after, "Speed up the string helpers.");
    expect(unmentioned.map((v) => [v.code, v.severity])).toEqual([["BEHAVIOR_CHANGED", "warn"]]);
    expect(check(root, "src/utils/strings.ts", after, "Speed up the string helpers. Behaviour must not change.")[0]?.severity).toBeUndefined();
  });

  it("treats a pure refactor and an additive optional parameter that keeps old results as clean", () => {
    const root = repo({ "src/utils/strings.ts": strings });
    const refactor = strings.replace("  if (input.length <= max) {\n    return input;\n  }\n  return input.slice(0, Math.max(0, max - 1)) + \"…\";", "  return input.length <= max ? input : `${input.slice(0, Math.max(0, max - 1))}…`;");
    expect(check(root, "src/utils/strings.ts", refactor, "Refactor truncate. Behaviour must not change.")).toEqual([]);
    const additive = strings
      .replace("export function truncate(input: string, max: number): string {", "export function truncate(input: string, max: number, ellipsis = \"…\"): string {")
      .replace("max - 1)) + \"…\"", "max - ellipsis.length)) + ellipsis");
    expect(check(root, "src/utils/strings.ts", additive, "Let truncate take an optional ellipsis.")).toEqual([]);
  });

  it("flags an exported function whose required arity grows", () => {
    const root = repo({ "src/utils/strings.ts": strings });
    const after = strings.replace('export function hasLeadingSlash(input = ""): boolean {', "export function hasLeadingSlash(input: string, strict: boolean): boolean {");
    expect(check(root, "src/utils/strings.ts", after, "Add a strict mode.").map((v) => v.code)).toEqual(["SIGNATURE_BREAK"]);
  });

  it("runs code in a locked-down child: no file system, no process, a frozen clock, and loops time out", () => {
    const code = `
      function readsFs() { return typeof require === "function" ? String(require("node:fs").readFileSync) : "none"; }
      function seesProcess() { return typeof process; }
      function now() { return Date.now(); }
      function spins() { for (;;) {} }
    `;
    const result = runSandbox([{ code, names: ["readsFs", "seesProcess", "now", "spins"] }], [
      { module: 0, ref: ["readsFs"], inputs: ["[]"] },
      { module: 0, ref: ["seesProcess"], inputs: ["[]"] },
      { module: 0, ref: ["now"], inputs: ["[]"] },
      { module: 0, ref: ["spins"], inputs: ["[]"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.outputs[0]?.[0]?.[0]).toMatch(/^"«import:node:fs\.readFileSync»"$|stub/);
    expect(result.outputs[1]?.[0]?.[0]).toBe('"undefined"');
    expect(result.outputs[2]?.[0]?.[0]).toBe("1767225600000");
    expect(result.outputs[3]?.[0]?.[0]).toBe("timeout");
  });

  it("can be switched off", () => {
    const root = repo({ "src/utils/strings.ts": strings });
    const after = strings.replace("input.length <= max", "input.length < max");
    process.env.CTC_BEHAVIOR = "off";
    try {
      expect(check(root, "src/utils/strings.ts", after, "Behaviour must not change.")).toEqual([]);
    } finally {
      delete process.env.CTC_BEHAVIOR;
    }
  });
});
