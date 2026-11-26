import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config/schema.js";
import { fingerprint, jaccardSimilarity, minHashAgreement } from "../src/engine/hash/ast-hasher.js";
import { clearUtilityIndexForTests } from "../src/engine/hash/utility-index.js";
import { applyLiteralPatch } from "../src/engine/patch.js";
import { clearPhantomProjectsForTests, overlayText, runPhantomCheck } from "../src/engine/phantom-check.js";
import { readGuarded } from "../src/engine/read-zone.js";
import { checkFlightPlan, proposePatch, proposeWrite } from "../src/engine/runway-gate.js";
import { hookStdout } from "../src/hook.js";
import { simulateSource } from "../src/engine/simulate.js";
import { HttpUnimatrixClient } from "../src/memory/unimatrix.js";
import { recallMemories, setMemoryAdapterForTests } from "../src/memory/sync.js";
import { loadConfig } from "../src/config/load.js";
import { baseConfig, makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  setMemoryAdapterForTests(null);
  clearUtilityIndexForTests();
  clearPhantomProjectsForTests();
  for (const root of roots.splice(0)) removeProject(root);
});

function project(config: unknown = baseConfig): string {
  const root = makeProject(config);
  roots.push(root);
  return root;
}

const currency = [
  "export function formatCentsToUsd(cents: number): string {",
  "  const dollars = (cents / 100).toFixed(2);",
  "  return dollars;",
  "}",
  "",
].join("\n");

const renamedCurrency = [
  "export function renderMoney(amountInCents: number): string {",
  "  const val = (amountInCents / 100).toFixed(2);",
  "  return val;",
  "}",
  "",
].join("\n");

describe("structural hash", () => {
  it("alpha-renames params, keeps as-expression operands, and renames inner bindings", () => {
    const source = simulateSource(
      "src/hash.ts",
      [
        "export function outer(value: number): number {",
        "  const shown = value as number;",
        "  function inner(item: number): number { return item + 1; }",
        "  return inner(shown);",
        "}",
        "export function wrapped({ cents }: { cents: number }): number {",
        "  const dollars = cents + 1;",
        "  return dollars;",
        "}",
        "",
      ].join("\n"),
    );
    const outer = source?.getFunction("outer");
    const wrapped = source?.getFunction("wrapped");
    expect(outer && wrapped).toBeTruthy();
    const outerPrint = fingerprint(outer!, 4, 32);
    const wrappedPrint = fingerprint(wrapped!, 4, 32);
    expect(outerPrint.tokens.join(" ")).toContain("Id:$p0");
    expect(outerPrint.tokens.join(" ")).not.toContain("Ext:value");
    expect(outerPrint.tokens.join(" ")).not.toContain("Ext:item");
    expect(wrappedPrint.tokens.join(" ")).toContain("Id:$p0");
    expect(wrappedPrint.tokens.join(" ")).not.toContain("Ext:cents");
    expect(minHashAgreement(outerPrint.minHashSignature, outerPrint.minHashSignature)).toBe(1);

    const left = simulateSource("src/a.ts", "export function one(userList: string[]): number { const items = userList.filter(Boolean); return items.length; }\n");
    const right = simulateSource("src/b.ts", "export function two(rows: string[]): number { const found = rows.filter(Boolean); return found.length; }\n");
    const one = fingerprint(left!.getFunctions()[0]!, 4, 32);
    const two = fingerprint(right!.getFunctions()[0]!, 4, 32);
    expect(one.exactHash).toBe(two.exactHash);
    expect(jaccardSimilarity(one.shingles, two.shingles)).toBe(1);
  });
});

describe("duplicate logic", () => {
  it("blocks an exact renamed copy and points at a module specifier", () => {
    const root = project({
      ...baseConfig,
      activeMilestone: { ...baseConfig.activeMilestone, allowedPaths: ["src/**"] },
      rules: { duplicates: { minAstNodes: 5 }, deadCode: { enabled: false } },
    });
    expect(proposeWrite({ root, path: "src/utils/currency.ts", content: currency }).cleared).toBe(true);
    const clone = proposeWrite({ root, path: "src/components/InvoiceRow.tsx", content: renamedCurrency });
    const hit = clone.violations.find((item) => item.code === "DUPLICATE_LOGIC");
    expect(hit?.useInstead).toBe('import { formatCentsToUsd } from "src/utils/currency.ts"');
    expect(hit?.useInstead).not.toContain(root);
    expect(fs.existsSync(path.join(root, "src/components/InvoiceRow.tsx"))).toBe(false);
  });

  it("warns on a near duplicate below the block threshold", () => {
    const root = project({
      ...baseConfig,
      rules: {
        duplicates: { minAstNodes: 5, duplicateWarnThreshold: 0.4, duplicateBlockThreshold: 0.99 },
        deadCode: { enabled: false },
      },
    });
    expect(proposeWrite({ root, path: "src/utils/currency.ts", content: currency }).cleared).toBe(true);
    const near = [
      "export function renderMoney(amountInCents: number): string {",
      "  if (amountInCents < 0) return \"0\";",
      "  const val = (amountInCents / 100).toFixed(2);",
      "  return val;",
      "}",
      "",
    ].join("\n");
    const result = proposeWrite({ root, path: "src/components/InvoiceRow.tsx", content: near });
    expect(result.cleared).toBe(true);
    expect(result.warnings.some((item) => item.code === "DUPLICATE_LOGIC" && item.severity === "warn")).toBe(true);
  });

  it("does not treat a different file as the canonical copy just because the path is a suffix", () => {
    const root = project({
      ...baseConfig,
      activeMilestone: { ...baseConfig.activeMilestone, allowedPaths: ["src/**", "utils/**"] },
      rules: { duplicates: { minAstNodes: 5, utilityGlobs: ["src/utils/**"] }, deadCode: { enabled: false } },
    });
    expect(proposeWrite({ root, path: "src/utils/format.ts", content: currency }).cleared).toBe(true);
    const other = currency.replace("formatCentsToUsd", "formatCentsToUsd");
    const result = proposeWrite({ root, path: "utils/format.ts", content: other });
    expect(result.violations.some((item) => item.code === "DUPLICATE_LOGIC")).toBe(true);
  });
});

describe("naming, boundaries, canaries, and dead code", () => {
  it("checks const arrows and hook prefixes, and skips PascalCase components", () => {
    const root = project({
      ...baseConfig,
      rules: { naming: { enabled: true, customHookPrefix: "use" }, deadCode: { enabled: false } },
    });
    const content = [
      "export const Button = () => null;",
      "export const render_dashboard = () => 1;",
      "export function loadUser(): unknown { return useQuery(); }",
      "",
    ].join("\n");
    const result = proposeWrite({ root, path: "src/Widget.tsx", content });
    const messages = result.violations.map((item) => item.message);
    expect(messages.some((message) => message.includes("Button"))).toBe(false);
    expect(messages.some((message) => message.includes("render_dashboard"))).toBe(true);
    expect(messages.some((message) => message.includes("loadUser") && message.includes("use"))).toBe(true);
  });

  it("resolves package names and relative imports without substring matches", () => {
    const root = project({
      ...baseConfig,
      rules: {
        boundaries: [{ sourcePattern: "src/components/**", forbiddenImports: ["pg", "src/db"] }],
        deadCode: { enabled: false },
      },
    });
    const content = ['import pg from "pg";', 'import client from "postgres";', 'import pool from "pg-pool";', 'import { db } from "../../db/client";', "export const view = db;", ""].join("\n");
    const result = proposeWrite({ root, path: "src/components/pages/Dashboard.tsx", content });
    const specs = result.violations.filter((item) => item.code === "BOUNDARY_VIOLATION").map((item) => item.message);
    expect(specs.some((message) => message.includes("'pg'"))).toBe(true);
    expect(specs.some((message) => message.includes("db/client"))).toBe(true);
    expect(specs.some((message) => message.includes("postgres"))).toBe(false);
    expect(specs.some((message) => message.includes("pg-pool"))).toBe(false);
  });

  it("enforces canaries and invariant patterns", () => {
    const root = project({ ...baseConfig, rules: { deadCode: { enabled: false } } });
    const plan = checkFlightPlan({
      root,
      paths: ["src/**"],
      intent: "Keep the Drizzle boundary",
      persist: true,
      invariants: [{ id: "no-sql", text: "No raw SQL", forbiddenPattern: "sql\\.raw" }],
      canaries: [{ id: "driver", description: "Drizzle import stays", targetFileGlob: "src/db.ts", requiredPattern: "drizzle-orm" }],
    });
    expect(plan.cleared).toBe(true);
    expect(plan.flightPlan?.planId).toMatch(/[0-9a-f-]{36}/);
    expect(plan.flightPlan?.createdAt).toContain("T");
    const dropped = proposeWrite({ root, path: "src/db.ts", content: "export const db = {};\n" });
    expect(dropped.violations.some((item) => item.code === "CANARY_AMNESIA")).toBe(true);
    const raw = proposeWrite({ root, path: "src/query.ts", content: "export const q = sql.raw(`select 1`);\n" });
    expect(raw.violations.some((item) => item.code === "INVARIANT_VIOLATION")).toBe(true);
    const kept = proposeWrite({ root, path: "src/db.ts", content: 'import { drizzle } from "drizzle-orm";\nexport const db = drizzle;\n' });
    expect(kept.violations.some((item) => item.code === "CANARY_AMNESIA")).toBe(false);
  });

  it("blocks only new unused symbols and does not write a baseline into the project", () => {
    const root = project();
    const original = "export function keep(n: number): number { return n; }\nconst legacy = 1;\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "old.ts"), original);
    const same = proposeWrite({ root, path: "src/old.ts", content: original });
    expect(same.cleared).toBe(true);
    const added = proposeWrite({ root, path: "src/old.ts", content: `${original}const fresh = 2;\n` });
    expect(added.violations.some((item) => item.code === "DEAD_CODE_REGRESSION" && item.message.includes("fresh"))).toBe(true);
    expect(added.violations.some((item) => item.message.includes("legacy"))).toBe(false);
    expect(fs.readdirSync(root).some((name) => name.includes("baseline"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "old.ts.ctc-baseline.ts"))).toBe(false);
  });
});

describe("patches and reads", () => {
  it("applies a unique literal patch and rejects ambiguous or escaped paths", () => {
    expect(applyLiteralPatch("const price = 1;\n", [{ search: "price", replace: 'cost = "$1"' }]).content).toBe('const cost = "$1" = 1;\n');
    const root = project({ ...baseConfig, rules: { deadCode: { enabled: false } } });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "price.ts"), "export const price = 1;\n");
    const landed = proposePatch({ root, path: "src/price.ts", hunks: [{ search: "1", replace: '"$1"' }] });
    expect(landed.cleared).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "price.ts"), "utf8")).toBe('export const price = "$1";\n');
    fs.writeFileSync(path.join(root, "src", "price.ts"), "export const price = price;\n");
    const ambiguous = proposePatch({ root, path: "src/price.ts", hunks: [{ search: "price", replace: "cost" }] });
    expect(ambiguous.violations.some((item) => item.code === "PATCH_AMBIGUOUS")).toBe(true);
    const escaped = proposePatch({ root, path: "../secret.ts", hunks: [{ search: "a", replace: "b" }] });
    expect(escaped.violations.some((item) => item.code === "PATH_ESCAPE")).toBe(true);
  });

  it("warns on re-reads, distills in yellow, and resets when a flight plan is registered", () => {
    const root = project({
      ...baseConfig,
      rules: {
        readZones: { contextWindowTokens: 1000, yellowAt: 0.01, redAt: 0.9, lockOnRed: false, lockOnReRead: false },
        deadCode: { enabled: false },
      },
    });
    const body = "export function longOne(): number {\n  const value = 1;\n  return value + 2;\n}\n";
    expect(proposeWrite({ root, path: "src/body.ts", content: body }).cleared).toBe(true);
    const config = loadConfig(root);
    const first = readGuarded(root, config, { path: "src/body.ts" });
    expect(first.tokenEstimate).toBe(true);
    expect(first.distilled).toBe(false);
    expect(first.locked).toBe(false);
    const second = readGuarded(root, config, { path: "src/body.ts" });
    expect(second.warning).toContain("Re-read");
    expect(second.locked).toBe(false);
    expect(second.distilled).toBe(true);
    expect(second.content).toContain("body elided");
    const full = readGuarded(root, config, { path: "src/body.ts", forceFull: true });
    expect(full.content).toContain("return value + 2");
    checkFlightPlan({ root, paths: ["src/**"], persist: true, intent: "Reset the zone counters now" });
    const reset = readGuarded(root, loadConfig(root), { path: "src/body.ts" });
    expect(reset.distilled).toBe(false);
    expect(reset.content).toContain("return value + 2");
  });

  it("writes a saturation handoff whose pending files are real files and whose violations are included", () => {
    const root = project({
      ...baseConfig,
      rules: { readZones: { contextWindowTokens: 40, yellowAt: 0.2, redAt: 0.5, lockOnRed: false }, deadCode: { enabled: false } },
    });
    checkFlightPlan({ root, paths: ["src/**"], persist: true, intent: "Saturate on purpose" });
    const body = `export const blob = "${"x".repeat(400)}";\n`;
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "blob.ts"), body);
    proposeWrite({ root, path: "src/bad.ts", content: 'import axios from "axios";\nexport const client = axios;\n' });
    const config = loadConfig(root);
    const read = readGuarded(root, config, { path: "src/blob.ts" });
    expect(read.zone).toBe("RED");
    expect(read.locked).toBe(false);
    const handoff = JSON.parse(fs.readFileSync(path.join(root, ".ctc", "handoff.json"), "utf8")) as {
      triggerReason: string;
      pendingFiles: string[];
      unresolvedViolations: string[];
    };
    expect(handoff.triggerReason).toBe("CONTEXT_SATURATION");
    expect(handoff.pendingFiles).toContain("src/blob.ts");
    expect(handoff.pendingFiles.some((file) => file.includes("*"))).toBe(false);
    expect(handoff.unresolvedViolations.some((line) => line.includes("BANNED_IMPORT"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".ctc", "state.json"))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, ".ctc", "state.json"), "utf8")) as { files?: unknown };
    expect(state.files).toBeTypeOf("object");
  });
});

describe("phantom symbols", () => {
  it("reports a missing property and rolls the overlay back", () => {
    const root = project({ ...baseConfig, rules: { phantom: { enabled: true, timeoutMs: 5000 }, deadCode: { enabled: false } } });
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const good = 'import type { Invoice } from "./types";\nexport function bill(invoice: Invoice): number { return invoice.totalCents; }\n';
    fs.writeFileSync(path.join(root, "src", "types.ts"), "export interface Invoice { id: string; totalCents: number }\n");
    fs.writeFileSync(path.join(root, "src", "bill.ts"), good);
    const bad = 'import type { Invoice } from "./types";\nexport function bill(invoice: Invoice): number { return invoice.amountDue; }\n';
    const result = proposeWrite({ root, path: "src/bill.ts", content: bad });
    expect(result.violations.some((item) => item.code === "PHANTOM_SYMBOL")).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "bill.ts"), "utf8")).toBe(good);
    expect(overlayText(root, "src/bill.ts")).toBe(good);
    const skipped = runPhantomCheck(root, "src/bill.ts", bad, { timeoutMs: 0, strictCallSignatures: true });
    expect(skipped.some((item) => item.code === "PHANTOM_TIMEOUT")).toBe(true);
    expect(overlayText(root, "src/bill.ts")).toBe(good);
  });
});

describe("config guards and Unimatrix", () => {
  it("rejects inverted duplicate thresholds and nested quantifiers", () => {
    expect(() =>
      normalizeConfig({
        ...baseConfig,
        rules: { duplicates: { duplicateWarnThreshold: 0.9, duplicateBlockThreshold: 0.85 } },
      }),
    ).toThrow(/duplicateWarnThreshold/);
    expect(() => normalizeConfig({ ...baseConfig, rules: { naming: { enabled: true, functions: "(a+)+" } } })).toThrow(/regular expression/);
  });

  it("stores wave-offs through the adapter and still lands when the adapter throws", async () => {
    const stored: Array<{ tags: string[]; content: string }> = [];
    setMemoryAdapterForTests({
      store(input) {
        stored.push(input);
      },
      search() {
        return [{ id: "m1", content: "Prefer src/lib/http.ts", tags: ["ctc"] }];
      },
      recall() {
        return [];
      },
      getContext() {
        return [{ id: "m2", content: "Drizzle only", tags: ["invariant"] }];
      },
      feedback() {
        return undefined;
      },
    });
    const root = project({ ...baseConfig, unimatrix: { enabled: true }, rules: { deadCode: { enabled: false } } });
    const held = proposeWrite({ root, path: "src/api.ts", content: 'import axios from "axios";\nexport const client = axios;\n' });
    expect(held.cleared).toBe(false);
    expect(stored.some((item) => item.tags.includes("gate-failure"))).toBe(true);
    const memories = await recallMemories(loadConfig(root), "axios");
    expect(memories.map((item) => item.content)).toContain("Prefer src/lib/http.ts");
    setMemoryAdapterForTests({
      store() {
        throw new Error("unimatrix down");
      },
      search() {
        throw new Error("unimatrix down");
      },
      recall() {
        throw new Error("unimatrix down");
      },
      getContext() {
        throw new Error("unimatrix down");
      },
      feedback() {
        throw new Error("unimatrix down");
      },
    });
    const landed = proposeWrite({ root, path: "src/ok.ts", content: "export const ok = true;\n" });
    expect(landed.cleared).toBe(true);
    expect(await recallMemories(loadConfig(root), "ok")).toEqual([]);
  });

  it("calls the verified REST shapes and the documented tool names", async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ memories: [{ id: "1", content: "stored", tags: ["ctc"] }] }), { status: 201 });
    };
    const bySpace = new HttpUnimatrixClient({ endpoint: "https://www.deployunimatrix.com/api", apiKey: "umx_test", spaceId: "space_1", fetchImpl });
    await bySpace.store({ content: "invariant", tags: ["ctc", "invariant"] });
    await bySpace.search("invariant");
    const byLocation = new HttpUnimatrixClient({
      endpoint: "https://www.deployunimatrix.com/api/",
      apiKey: "umx_test",
      locationId: "loc_1",
      fetchImpl,
    });
    await byLocation.store({ content: "wave off", tags: ["ctc", "gate-failure"] });
    await byLocation.feedback({ rating: "wrong", query: "axios", note: "third strike" });
    expect(calls[0]?.url).toBe("https://www.deployunimatrix.com/api/memories");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ spaceId: "space_1", content: "invariant" });
    expect(calls[1]?.url).toContain("/search?q=invariant");
    const tool = JSON.parse(calls[2]?.body ?? "{}") as { toolName: string; args: { location_id: string } };
    expect(tool.toolName).toBe("unimatrix_store_memory");
    expect(tool.args.location_id).toBe("loc_1");
    expect(JSON.parse(calls[3]?.body ?? "{}")).toMatchObject({ toolName: "unimatrix_feedback" });
  });

  it("emits a Cursor preToolUse denial", () => {
    const body = JSON.parse(hookStdout({ permission: "deny", exitCode: 2, reason: "wave off", payload: null }, "cursor")) as {
      permission: string;
      agent_message: string;
    };
    expect(body.permission).toBe("deny");
    expect(body.agent_message).toBe("wave off");
  });
});
