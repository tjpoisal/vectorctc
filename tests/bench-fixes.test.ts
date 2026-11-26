import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeProposal } from "../src/gate/analyzer.js";
import { clearGateProjectsForTests } from "../src/gate/overlay.js";
import { FlightPlanSchema, type FlightPlanContract } from "../src/schemas/flightPlan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    clearGateProjectsForTests(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

export function tempRepo(files: Record<string, string>, tsconfig = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-fix-"));
  roots.push(root);
  if (tsconfig) {
    files["tsconfig.json"] ??= JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] });
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

export function plan(extra: Partial<FlightPlanContract> = {}): FlightPlanContract {
  return FlightPlanSchema.parse({ planId: "p", taskId: "t", createdAt: "2026-01-01T00:00:00Z", allowedFileGlobs: ["src/**"], thresholds: { maxFunctionLines: 40, maxCyclomaticComplexity: 3, duplicateJaccard: 0.85 }, ...extra });
}

const legacyComplex = `export function legacy(n: number): number {
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  if (n === 4) return 4;
  return n;
}
`;

describe("fix 1: diff-aware complexity and naming", () => {
  it("does not block an unrelated edit to a file with legacy complexity or naming", () => {
    const original = `${legacyComplex}export const Legacy_Name = 1;\n`;
    const root = tempRepo({ "src/a.ts": original });
    const result = analyzeProposal(root, "src/a.ts", `${original}export function added(): number { return 2; }\n`, plan());
    expect(result.violations.filter((v) => v.code === "COMPLEXITY" || v.code === "NAMING_DRIFT")).toEqual([]);
  });

  it("still blocks a new complex function, a function made more complex, and a new bad name", () => {
    const root = tempRepo({ "src/a.ts": legacyComplex });
    const worse = legacyComplex.replace("  return n;", "  if (n === 5) return 5;\n  return n;");
    const added = `${worse}export function fresh(n: number): number {\n  if (n === 1) return 1;\n  if (n === 2) return 2;\n  if (n === 3) return 3;\n  return n;\n}\nexport const Bad_Name = 1;\n`;
    const codes = analyzeProposal(root, "src/a.ts", added, plan()).violations.map((v) => `${v.code}:${v.message}`);
    expect(codes.some((c) => c.includes("COMPLEXITY") && c.includes("'legacy'"))).toBe(true);
    expect(codes.some((c) => c.includes("COMPLEXITY") && c.includes("'fresh'"))).toBe(true);
    expect(codes.some((c) => c.includes("NAMING_DRIFT") && c.includes("Bad_Name"))).toBe(true);
  });

  it("treats a brand-new file as all new, and baseline: null as no baseline", () => {
    const root = tempRepo({ "src/a.ts": legacyComplex });
    expect(analyzeProposal(root, "src/b.ts", legacyComplex, plan()).violations.some((v) => v.code === "COMPLEXITY")).toBe(true);
    expect(analyzeProposal(root, "src/a.ts", legacyComplex, plan(), { baseline: null }).violations.some((v) => v.code === "COMPLEXITY")).toBe(true);
  });
});

describe("fix 2: config enabled flags reach the gate", () => {
  const base = { version: 1, activeMilestone: { id: "m", title: "M", allowedPaths: ["src/**"], status: "active" }, circuitBreaker: { maxStrikes: 3 } };
  const badNameUnused = "const unusedTop = 1;\nexport function Bad_Name(): number {\n  return 2;\n}\n";

  it("honors naming, deadCode and phantom.gate switches and null degradation limits on the milestone path", async () => {
    const { checkContent } = await import("../src/universal/check.js");
    const off = tempRepo({ "ctc.config.json": JSON.stringify({ ...base, degradation: { maxFunctionLength: null, maxCyclomaticComplexity: null }, rules: { naming: { enabled: false }, deadCode: { enabled: false }, phantom: { gate: false } } }) });
    const offOutcome = checkContent(off, "src/a.ts", `${badNameUnused}export const x = missingThing;\n${legacyComplex}`);
    expect(offOutcome.exitCode).toBe(0);

    const on = tempRepo({ "ctc.config.json": JSON.stringify({ ...base, degradation: { maxFunctionLength: 80, maxCyclomaticComplexity: 3 }, rules: { naming: { enabled: true } } }) });
    const onOutcome = checkContent(on, "src/a.ts", `${badNameUnused}export const x = missingThing;\n${legacyComplex}`);
    const codes = JSON.stringify(onOutcome.payload);
    for (const code of ["NAMING_DRIFT", "DEAD_CODE_REGRESSION", "PHANTOM_SYMBOL", "COMPLEXITY"]) expect(codes).toContain(code);
  });

  it("applies explicit enabled: false to a blueprint flight plan", async () => {
    const { resolveContract } = await import("../src/universal/contract.js");
    const root = tempRepo({ "ctc.config.json": JSON.stringify({ ...base, rules: { naming: { enabled: false }, duplicates: { enabled: false } } }), ".ctc/flight-plan.json": JSON.stringify(plan()) });
    const contract = resolveContract(root);
    expect(contract.ok && contract.plan.disabledRules).toEqual(expect.arrayContaining(["naming", "duplicates"]));
    expect(analyzeProposal(root, "src/a.ts", badNameUnused, contract.ok ? contract.plan : plan()).violations.some((v) => v.code === "NAMING_DRIFT")).toBe(false);
  });
});

describe("fix 3: phantom catches hallucinated imports", () => {
  const files = () => ({
    "package.json": JSON.stringify({ name: "x", dependencies: { "declared-pkg": "1.0.0" } }),
    "node_modules/.keep": "",
    "src/lib/http.ts": "export function request(): number { return 1; }\nexport const items = { size: 1 };\n",
  });

  it("blocks a missing named export (2305/2724), an undeclared package (2307) and did-you-mean misses (2551/2552)", () => {
    const root = tempRepo(files());
    const codes = (content: string) => analyzeProposal(root, "src/a.ts", content, plan()).violations.filter((v) => v.code === "PHANTOM_SYMBOL").map((v) => v.tsDiagnosticCode);
    expect(codes('import { retryWithBackoff } from "./lib/http";\nexport const r = retryWithBackoff;\n')).toContain(2305);
    expect(codes('import { requst } from "./lib/http";\nexport const r = requst;\n')).toContain(2724);
    expect(codes('import { v4 } from "uuid";\nexport const r = v4;\n')).toContain(2307);
    expect(codes("export const r = Math.flor(1.5);\n")).toContain(2551);
    expect(codes('import { request } from "./lib/http";\nexport const r = requst();\nexport const s = request;\n')).toContain(2552);
  });

  it("does not block declared-but-uninstalled packages, Node built-ins, or imports already in the file", () => {
    const root = tempRepo({ ...files(), "src/a.ts": 'import { legacy } from "legacy-missing";\nexport const l = legacy;\n' });
    const content = 'import { legacy } from "legacy-missing";\nimport { thing } from "declared-pkg";\nimport { readFileSync } from "node:fs";\nexport const l = [legacy, thing, readFileSync];\n';
    expect(analyzeProposal(root, "src/a.ts", content, plan()).violations.filter((v) => v.tsDiagnosticCode === 2307)).toEqual([]);
    const noModules = tempRepo({ "src/lib/x.ts": "export const x = 1;\n" });
    expect(analyzeProposal(noModules, "src/a.ts", 'import { v4 } from "uuid";\nexport const r = v4;\n', plan()).violations.filter((v) => v.tsDiagnosticCode === 2307)).toEqual([]);
  });
});

describe("fix 4: duplicate search uses configured paths and single-file utility modules", () => {
  const helper = `export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 100) / 100;
}
`;
  const copy = helper.replace("clampPercent", "boundPercent").replace("export ", "");
  const dupes = (root: string, p: FlightPlanContract) => analyzeProposal(root, "src/feature.ts", `${copy}export const y = boundPercent(5);\n`, p).violations.filter((v) => v.code === "DUPLICATE_LOGIC");

  it("expands folder globs to the single-file module form", async () => {
    const { expandUtilityGlobs } = await import("../src/gate/rules/duplicates.js");
    expect(expandUtilityGlobs(["src/utils/**"])).toEqual(expect.arrayContaining(["src/utils/**", "src/utils.ts", "src/utils.tsx", "src/utils.js"]));
    expect(expandUtilityGlobs(["src/**/*.helper.ts"])).toEqual(["src/**/*.helper.ts"]);
  });

  it("finds a helper in src/utils.ts with the default globs", () => {
    const root = tempRepo({ "src/utils.ts": helper });
    expect(dupes(root, plan())).toHaveLength(1);
  });

  it("uses rules.duplicates.utilityGlobs from the config, also for blueprint plans", async () => {
    const { resolveContract } = await import("../src/universal/contract.js");
    const config = { version: 1, activeMilestone: { id: "m", title: "M", allowedPaths: ["src/**"], status: "active" }, circuitBreaker: { maxStrikes: 3 }, rules: { duplicates: { utilityGlobs: ["src/mathkit/**"] } } };
    // v0.3 indexes src/**/helpers/** by default, so this test uses a folder only the config names.
    const root = tempRepo({ "src/mathkit/math.ts": helper, "ctc.config.json": JSON.stringify(config), ".ctc/flight-plan.json": JSON.stringify(plan()) });
    expect(dupes(root, plan())).toHaveLength(0);
    const contract = resolveContract(root);
    expect(contract.ok && contract.plan.utilityGlobs).toEqual(["src/mathkit/**"]);
    expect(dupes(root, contract.ok ? contract.plan : plan())).toHaveLength(1);
  });

  it("refreshes the cached index when a utility file changes", () => {
    const root = tempRepo({ "src/lib/a.ts": "export const nothing = 1;\n" });
    expect(dupes(root, plan())).toHaveLength(0);
    fs.writeFileSync(path.join(root, "src/lib/a.ts"), helper);
    expect(dupes(root, plan())).toHaveLength(1);
    fs.rmSync(path.join(root, "src/lib/a.ts"));
    expect(dupes(root, plan())).toHaveLength(0);
  });
});

describe("fix 5: cross-file breaking changes", () => {
  const lib = "export function formatPrice(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\nexport const VERSION = 1;\n";
  const files = () => ({
    "src/lib/price.ts": lib,
    "src/index.ts": 'export * from "./lib/price";\n',
    "src/cart.ts": 'import { formatPrice } from "./lib/price";\nexport const label = formatPrice(250);\n',
    "src/page.ts": 'import { formatPrice } from "./index";\nexport const title: string = formatPrice(100);\n',
  });
  const breaking = (root: string, content: string) => analyzeProposal(root, "src/lib/price.ts", content, plan()).violations.filter((v) => v.code === "BREAKING_CHANGE");

  it("blocks a new required parameter, naming each broken caller (direct and through a barrel)", () => {
    const root = tempRepo(files());
    const found = breaking(root, lib.replace("(cents: number)", "(cents: number, currency: string)"));
    expect(found.map((v) => v.message).join("\n")).toMatch(/breaks caller src\/cart\.ts:2/);
    expect(found.map((v) => v.message).join("\n")).toMatch(/breaks caller src\/page\.ts:2/);
    expect(found.every((v) => v.file === "src/lib/price.ts" && v.line === 1)).toBe(true);
  });

  it("blocks a removed export and a changed return type", () => {
    const root = tempRepo(files());
    expect(breaking(root, "export const VERSION = 1;\n").length).toBeGreaterThan(0);
    expect(breaking(root, lib.replace("): string {\n  return `$${(cents / 100).toFixed(2)}`;", "): number {\n  return cents / 100;")).some((v) => v.message.includes("src/page.ts"))).toBe(true);
  });

  it("allows compatible changes and changes with no callers", () => {
    const root = tempRepo(files());
    expect(breaking(root, lib.replace("(cents: number)", "(cents: number, currency = \"USD\")"))).toEqual([]);
    expect(breaking(root, `${lib}export function extra(): number { return 1; }\n`)).toEqual([]);
    expect(breaking(root, lib.replace("export const VERSION = 1;\n", ""))).toEqual([]);
  });
});

describe("fix 6: export scope against the flight plan", () => {
  const original = "export function slugify(value: string): string {\n  return value.toLowerCase();\n}\n";
  const scoped = (root: string, content: string, allowed?: string[]) =>
    analyzeProposal(root, "src/lib/text.ts", content, plan(allowed ? { allowedNewExports: allowed } : {})).violations.filter((v) => v.code === "EXPORT_NOT_IN_PLAN");

  it("blocks new exports that the plan does not list, and only those", () => {
    const root = tempRepo({ "src/lib/text.ts": original });
    const content = `${original}export function titleCase(value: string): string {\n  return value.toUpperCase();\n}\nexport const SECRET_HELPER = 1;\n`;
    const found = scoped(root, content, ["titleCase"]);
    expect(found.map((v) => v.message)).toEqual([expect.stringContaining("'SECRET_HELPER'")]);
    expect(found[0]?.line).toBe(7);
  });

  it("is off when the plan has no allowedNewExports, and never flags existing exports", () => {
    const root = tempRepo({ "src/lib/text.ts": original });
    expect(scoped(root, `${original}export const extra = 1;\n`)).toEqual([]);
    expect(scoped(root, original.replace("toLowerCase", "trim().toLowerCase"), [])).toEqual([]);
    expect(scoped(root, `${original}const inner = 1;\nexport { inner as renamed };\n`, [])).toHaveLength(1);
  });

  it("does not treat a barrel's existing star re-exports as new, but does flag a new star re-export", () => {
    const root = tempRepo({ "src/lib/text.ts": original, "src/lib/more.ts": "export const extra = 1;\n", "src/index.ts": 'export * from "./lib/text";\n' });
    const barrel = (content: string) => analyzeProposal(root, "src/index.ts", content, plan({ allowedNewExports: [] })).violations.filter((v) => v.code === "EXPORT_NOT_IN_PLAN");
    expect(barrel('// barrel\nexport * from "./lib/text";\n')).toEqual([]);
    expect(barrel('export * from "./lib/text";\nexport * from "./lib/more";\n').map((v) => v.message)).toEqual([expect.stringContaining("'extra'")]);
  });
});

describe("fix 7: the gate reuses its project between checks and stays fresh", () => {
  it("returns the same cached project on consecutive outer calls (the cache used to be bypassed)", async () => {
    const { withOverlay } = await import("../src/gate/overlay.js");
    const root = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    const first = withOverlay(root, "src/a.ts", "export const a = 2;\n", (_s, project) => project);
    const second = withOverlay(root, "src/a.ts", "export const a = 3;\n", (_s, project) => project);
    expect(second).toBe(first);
    const nested = withOverlay(root, "src/a.ts", "export const a = 4;\n", (_s, outer) => withOverlay(root, "src/a.ts", "export const a = 5;\n", (_t, inner) => inner !== outer));
    expect(nested).toBe(true);
  });

  it("picks up files edited or deleted on disk between checks", async () => {
    const lib = "export function total(a: number): number {\n  return a;\n}\n";
    const root = tempRepo({ "src/lib/m.ts": lib, "src/use.ts": 'export const ok = 1;\n' });
    const change = lib.replace("(a: number)", "(a: number, b: number)").replace("return a;", "return a + b;");
    const breaks = () => analyzeProposal(root, "src/lib/m.ts", change, plan()).violations.filter((v) => v.code === "BREAKING_CHANGE");
    expect(breaks()).toEqual([]);
    const later = Date.now() / 1000 + 5;
    fs.writeFileSync(path.join(root, "src/use.ts"), 'import { total } from "./lib/m";\nexport const t = total(1);\n');
    fs.utimesSync(path.join(root, "src/use.ts"), later, later);
    expect(breaks()).toHaveLength(1);
    fs.rmSync(path.join(root, "src/use.ts"));
    expect(breaks()).toEqual([]);
  });

  it("compares unused locals with the same compiler options when the project sets noUnusedLocals", () => {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] });
    const original = "export function f(): number {\n  const legacy = 1;\n  return 2;\n}\n";
    const root = tempRepo({ "tsconfig.json": tsconfig, "src/a.ts": original });
    const dead = (content: string) => analyzeProposal(root, "src/a.ts", content, plan()).violations.filter((v) => v.code === "DEAD_CODE_REGRESSION").map((v) => v.message);
    expect(dead(`${original}export const g = 3;\n`)).toEqual([]);
    expect(dead(original.replace("return 2;", "const fresh = 3;\n  return 2;"))).toEqual([expect.stringContaining("'fresh'")]);
  });
});
