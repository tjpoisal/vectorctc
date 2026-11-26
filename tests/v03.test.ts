import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeProposal } from "../src/gate/analyzer.js";
import { applyWrite, applyWriteReviewed } from "../src/gate/apply.js";
import { diffLines } from "../src/gate/diff.js";
import { clearGateProjectsForTests } from "../src/gate/overlay.js";
import { semanticProviderFromEnv } from "../src/gate/semantic/config.js";
import { filterFindings, parseReply } from "../src/gate/semantic/filter.js";
import { httpModelClient, type ModelClient } from "../src/gate/semantic/provider.js";
import { semanticReview } from "../src/gate/semantic/review.js";
import { FlightPlanSchema, type FlightPlanContract } from "../src/schemas/flightPlan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    clearGateProjectsForTests(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-v03-"));
  roots.push(root);
  files["tsconfig.json"] ??= JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

function plan(extra: Partial<FlightPlanContract> = {}): FlightPlanContract {
  return FlightPlanSchema.parse({ planId: "p", taskId: "t", createdAt: "2026-01-01T00:00:00Z", allowedFileGlobs: ["src/**"], ...extra });
}

const codes = (root: string, file: string, content: string, p = plan()): string[] => analyzeProposal(root, file, content, p).violations.map((v) => `${v.code}@${v.line}: ${v.message}`);

const MONEY = `/** Total of all line items, in cents. */
export function total(items: { qty: number; priceCents: number }[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);
}
`;

const DATES = `const DAY_MS = 24 * 60 * 60 * 1000;

/** True when \`due\` is strictly before \`now\`. */
export function isLate(due: Date, now: Date): boolean {
  return due.getTime() < now.getTime();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
`;

describe("v0.3 diff helper", () => {
  it("reports added and modified lines of the new text only", () => {
    const { changedNewLines, hunks } = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect([...changedNewLines].sort()).toEqual([2, 4]);
    expect(hunks.length).toBe(2);
    expect([...diffLines(null, "x\ny\n").changedNewLines]).toEqual([1, 2]);
  });
});

describe("v0.3 learned conventions: units", () => {
  it("holds a function that was documented in cents and now returns dollars, even if the comment is dropped", () => {
    const root = repo({ "src/money.ts": MONEY });
    const after = `/** Total of all line items. */
export function total(items: { qty: number; priceCents: number }[]): number {
  let sum = 0;
  for (const item of items) sum += item.qty * item.priceCents;
  return sum / 100;
}
`;
    const found = codes(root, "src/money.ts", after);
    expect(found.some((c) => c.startsWith("UNIT_CHANGE@5") && c.includes("cents") && c.includes("dollars"))).toBe(true);
  });

  it("holds seconds added to milliseconds and a seconds value passed to setTimeout", () => {
    const root = repo({ "src/dates.ts": DATES });
    const after = DATES.replace("days * DAY_MS", "days * 24 * 60 * 60") + `\nexport function later(fn: () => void, retrySeconds: number): void {\n  setTimeout(fn, retrySeconds);\n}\n`;
    const found = codes(root, "src/dates.ts", after);
    expect(found.some((c) => c.startsWith("UNIT_MISMATCH@9") && c.includes("milliseconds") && c.includes("seconds"))).toBe(true);
    expect(found.some((c) => c.startsWith("UNIT_MISMATCH@13") && c.includes("setTimeout"))).toBe(true);
  });

  it("holds a value named in cents that is assigned dollars", () => {
    const root = repo({ "src/money.ts": MONEY });
    const after = `${MONEY}\nexport function summary(items: { qty: number; priceCents: number }[]): { totalCents: number } {\n  const cents = total(items);\n  return { totalCents: cents / 100 };\n}\n`;
    expect(codes(root, "src/money.ts", after).some((c) => c.startsWith("UNIT_MISMATCH") && c.includes("totalCents"))).toBe(true);
  });

  it("does not flag correct conversions, display formatting, legacy code, or a unit change the task asks for", () => {
    const root = repo({ "src/money.ts": MONEY, "src/dates.ts": DATES });
    const fine = `${DATES}\nexport function timeoutFor(seconds: number): number {\n  return seconds * 1000;\n}\nexport function wait(ms: number): Promise<void> {\n  return new Promise((resolve) => setTimeout(resolve, ms ?? 10_000));\n}\nexport function hoursFromNow(now: Date, hours: number): Date {\n  return new Date(now.getTime() + hours * 3600 * 1000);\n}\n`;
    expect(codes(root, "src/dates.ts", fine).filter((c) => c.startsWith("UNIT"))).toEqual([]);
    const display = `${MONEY}\nexport function formatDollars(cents: number): string {\n  return \`$\${(cents / 100).toFixed(2)}\`;\n}\n`;
    expect(codes(root, "src/money.ts", display).filter((c) => c.startsWith("UNIT"))).toEqual([]);
    const asked = MONEY.replace("return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);", "return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0) / 100;");
    expect(codes(root, "src/money.ts", asked, plan({ objective: "Return the total in dollars instead of cents" })).filter((c) => c.startsWith("UNIT"))).toEqual([]);
    const legacy = `export function legacy(start: Date): number {\n  return start.getTime() + 86400;\n}\n`;
    const legacyRoot = repo({ "src/legacy.ts": legacy });
    expect(codes(legacyRoot, "src/legacy.ts", `${legacy}export const unrelated = 1;\n`).filter((c) => c.startsWith("UNIT"))).toEqual([]);
  });
});

describe("v0.3 learned conventions: boundary comparisons", () => {
  const caller = `import { isLate } from "./dates";\nexport const late = (d: Date) => isLate(d, new Date());\n`;

  it("holds a < to <= flip and names the call sites and tests that rely on the boundary", () => {
    const root = repo({ "src/dates.ts": DATES, "src/use.ts": caller, "test/dates.test.ts": `import { isLate } from "../src/dates";\nisLate(new Date(0), new Date(0));\n` });
    const after = DATES.replace("return due.getTime() < now.getTime();", "return due <= now;");
    const found = codes(root, "src/dates.ts", after);
    const flip = found.find((c) => c.startsWith("BOUNDARY_FLIP@5"));
    expect(flip).toBeDefined();
    expect(flip).toContain("src/use.ts:2");
    expect(flip).toContain("test/dates.test.ts");
  });

  it("catches >= to > on a loop bound", () => {
    const src = `export function last(parts: string[]): string {\n  for (let i = parts.length - 1; i >= 0; i--) {\n    if (parts[i]) return parts[i] ?? "";\n  }\n  return "";\n}\n`;
    const root = repo({ "src/a.ts": src });
    expect(codes(root, "src/a.ts", src.replace("i >= 0", "i > 0")).some((c) => c.startsWith("BOUNDARY_FLIP@2"))).toBe(true);
  });

  it("allows the flip when the plan asks for an inclusive boundary, and ignores new or untouched comparisons", () => {
    const root = repo({ "src/dates.ts": DATES, "src/use.ts": caller });
    const after = DATES.replace("return due.getTime() < now.getTime();", "return due <= now;");
    expect(codes(root, "src/dates.ts", after, plan({ objective: "isLate: an invoice due exactly now counts as late (inclusive)" })).filter((c) => c.startsWith("BOUNDARY"))).toEqual([]);
    const added = `${DATES}\nexport function isEarly(due: Date, now: Date): boolean {\n  return due.getTime() > now.getTime();\n}\n`;
    expect(codes(root, "src/dates.ts", added).filter((c) => c.startsWith("BOUNDARY"))).toEqual([]);
  });
});

describe("v0.3 duplicate detection", () => {
  const internal = `export function normalizeSlashes(input = "") {\n  if (!input) {\n    return input;\n  }\n  let out = input;\n  if (out.includes("\\\\")) {\n    out = out.replace(/\\\\/g, "/");\n  }\n  return out.toLowerCase();\n}\n`;

  it("indexes _internal / private helper modules", () => {
    const root = repo({ "src/_internal.ts": internal, "src/feature.ts": "export const x = 1;\n" });
    const copy = `function toPosix(value = "") {\n  if (!value) {\n    return value;\n  }\n  let result = value;\n  if (result.includes("\\\\")) {\n    result = result.replace(/\\\\/g, "/");\n  }\n  return result.toLowerCase();\n}\nexport const x = toPosix("a");\n`;
    expect(codes(root, "src/feature.ts", copy).some((c) => c.startsWith("DUPLICATE_LOGIC@1") && c.includes("normalizeSlashes"))).toBe(true);
  });

  it("finds a new function that copies one already in the same file, exported or private", () => {
    const src = `export function upperFirst(str: string): string {\n  return str ? str[0]!.toUpperCase() + str.slice(1) : "";\n}\nfunction endsWithSlash(path = "/") {\n  const last = path[path.length - 1];\n  return last === "/" || last === "\\\\";\n}\nexport const used = endsWithSlash("a/");\n`;
    const root = repo({ "src/strings.ts": src });
    const after = `${src}export function capitalize(input: string): string {\n  return input ? input[0]!.toUpperCase() + input.slice(1) : "";\n}\nfunction hasSep(p = "/") {\n  const c = p[p.length - 1];\n  return c === "/" || c === "\\\\";\n}\nexport const also = hasSep("b");\n`;
    const found = codes(root, "src/strings.ts", after);
    expect(found.some((c) => c.startsWith("DUPLICATE_LOGIC@9") && c.includes("upperFirst"))).toBe(true);
    expect(found.some((c) => c.startsWith("DUPLICATE_LOGIC@12") && c.includes("endsWithSlash"))).toBe(true);
  });

  it("does not flag parametric siblings or one-call wrappers, nor legacy look-alikes", () => {
    const src = `export function joinWith(parts: string[], sep: string): string {\n  return parts.filter(Boolean).map((p) => p.toLowerCase()).join(sep);\n}\nexport function snake(parts: string[]): string {\n  return joinWith(parts, "_");\n}\nexport function flat(parts: string[]): string {\n  return joinWith(parts, "");\n}\n`;
    const root = repo({ "src/case.ts": src });
    const after = `${src}export function dot(parts: string[]): string {\n  return joinWith(parts, ".");\n}\nexport const unrelated = 2;\n`;
    expect(codes(root, "src/case.ts", after).filter((c) => c.startsWith("DUPLICATE"))).toEqual([]);
  });

  it("follows barrel re-exports for layer boundaries", () => {
    const root = repo({
      "src/db/repo.ts": "export class Repo {\n  list(): string[] {\n    return [];\n  }\n}\n",
      "src/index.ts": 'export { Repo } from "./db/repo";\n',
      "src/routes/a.ts": "export const a = 1;\n",
    });
    const p = plan({ boundaries: [{ sourcePattern: "src/routes/**", forbiddenImports: ["src/db"] }] });
    const after = 'import { Repo } from "../index";\n\nexport const a = new Repo().list();\n';
    const found = codes(root, "src/routes/a.ts", after, p);
    expect(found.some((c) => c.startsWith("BOUNDARY_VIOLATION@1") && c.includes("src/db/repo.ts") && c.includes("re-export"))).toBe(true);
    const direct = codes(root, "src/routes/a.ts", 'import { Repo } from "../db/repo";\n\nexport const a = new Repo().list();\n', p);
    expect(direct.filter((c) => c.startsWith("BOUNDARY_VIOLATION")).length).toBe(1);
  });
});

describe("v0.3 unused private members and scope creep", () => {
  const service = `export class Service {\n  private readonly cache = new Map<string, number>();\n\n  get(id: string): number | undefined {\n    return this.cache.get(id);\n  }\n\n  list(): number[] {\n    return [...this.cache.values()];\n  }\n}\n`;

  it("holds a new private method or #field nobody uses, and keeps used and legacy ones", () => {
    const root = repo({ "src/service.ts": service });
    const after = service.replace("  list(): number[] {", "  private label(id: string): string {\n    return `#${id}`;\n  }\n\n  #hits = 0;\n\n  private used(): number {\n    return 1;\n  }\n\n  count(): number {\n    return this.used();\n  }\n\n  list(): number[] {");
    const found = codes(root, "src/service.ts", after);
    expect(found.some((c) => c.startsWith("DEAD_CODE_REGRESSION@8") && c.includes("label"))).toBe(true);
    expect(found.some((c) => c.includes("#hits"))).toBe(true);
    expect(found.some((c) => c.includes("'used'"))).toBe(false);
    const legacyRoot = repo({ "src/service.ts": after });
    expect(codes(legacyRoot, "src/service.ts", `${after}export const more = 1;\n`).filter((c) => c.startsWith("DEAD_CODE"))).toEqual([]);
  });

  it("holds edits to existing declarations outside allowedEditSymbols, with no export added", () => {
    const root = repo({ "src/service.ts": service });
    const after = service.replace("return [...this.cache.values()];", "return [...this.cache.values()].map((v) => v * 2);").replace("return this.cache.get(id);", "return this.cache.get(id) ?? 0;");
    const scoped = codes(root, "src/service.ts", after, plan({ allowedEditSymbols: ["get"] }));
    expect(scoped.some((c) => c.startsWith("EDIT_OUTSIDE_PLAN_SCOPE@9") && c.includes("Service.list"))).toBe(true);
    expect(scoped.some((c) => c.includes("Service.get"))).toBe(false);
    expect(codes(root, "src/service.ts", after, plan({ allowedEditSymbols: ["Service"] })).filter((c) => c.startsWith("EDIT_OUTSIDE"))).toEqual([]);
    expect(codes(root, "src/service.ts", after).filter((c) => c.startsWith("EDIT_OUTSIDE"))).toEqual([]);
  });

  it("holds a write to a file outside the flight plan even when it adds no export", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" });
    const result = applyWrite(root, { path: "src/b.ts", content: "export const b = 2;\n", plan: plan({ allowedFileGlobs: ["src/a.ts"] }) });
    expect(result.written).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("OUTSIDE_FLIGHT_PLAN");
    expect(fs.readFileSync(path.join(root, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
  });
});

describe("v0.3 semantic review step", () => {
  const before = "// header\n".repeat(6) + MONEY;
  const after = before.replace("return items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);", "return items.reduce((sum, item) => sum + item.qty * item.priceCents, 1);");

  it("is skipped cleanly with no API key, and picks a provider from the environment otherwise", async () => {
    expect(semanticProviderFromEnv({})).toEqual({ enabled: false, reason: expect.stringContaining("off by default") });
    expect(semanticProviderFromEnv({ OPENAI_API_KEY: "k", CTC_SEMANTIC: "off" })).toMatchObject({ enabled: false });
    expect(semanticProviderFromEnv({ ANTHROPIC_API_KEY: "a" })).toMatchObject({ enabled: false });
    expect(semanticProviderFromEnv({ OPENAI_API_KEY: "k" })).toMatchObject({ enabled: false });
    expect(semanticProviderFromEnv({ ANTHROPIC_API_KEY: "a", CTC_SEMANTIC: "on" })).toMatchObject({ enabled: true, config: { provider: "anthropic", apiKey: "a" } });
    expect(semanticProviderFromEnv({ CTC_SEMANTIC_API_KEY: "c", CTC_SEMANTIC_BASE_URL: "http://localhost:1234/v1/", CTC_SEMANTIC_MODEL: "m" })).toMatchObject({ enabled: true, config: { provider: "openai", baseUrl: "http://localhost:1234/v1", model: "m" } });
    const root = repo({ "src/money.ts": before });
    const outcome = await semanticReview({ root, relativePath: "src/money.ts", before, after, plan: plan(), deterministic: [], env: {} });
    expect(outcome.summary.status).toBe("skipped");
    expect(outcome.findings).toEqual([]);
    const written = await applyWriteReviewed(root, { path: "src/money.ts", content: after, plan: plan() }, { env: {} });
    expect(written.written).toBe(true);
    expect(written.semanticReview?.status).toBe("skipped");
  });

  it("keeps only findings on changed lines with verbatim evidence, confidence and a concrete category", () => {
    const changed = diffLines(before, after).changedNewLines;
    const raw = [
      { line: 9, category: "behaviour_change", confidence: 0.95, evidence: "item.priceCents, 1)", message: "The reduce now starts at 1, so every total is one cent too high." },
      { line: 1, category: "behaviour_change", confidence: 0.99, evidence: "// header", message: "Header is wrong." },
      { line: 9, category: "behaviour_change", confidence: 0.4, evidence: "item.priceCents, 1)", message: "Low confidence." },
      { line: 9, category: "unit_change", confidence: 0.9, evidence: "return dollars", message: "Returns dollars." },
      { line: 9, category: "style", confidence: 0.99, evidence: "reduce", message: "Use a loop." },
      { line: 9, category: "scope_creep", confidence: 0.9, evidence: "reduce", message: "You might consider splitting this." },
      "garbage",
    ];
    const { kept, dropped } = filterFindings(raw, { relativePath: "src/money.ts", after, changedLines: changed, deterministic: [], minConfidence: 0.8, maxFindings: 3 });
    expect(kept.map((k) => [k.line, k.code])).toEqual([[9, "SEMANTIC_BEHAVIOUR_CHANGE"]]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "line is not part of this edit",
      "confidence 0.4 below 0.8",
      "evidence is not on the reported line",
      "category 'style' is not reportable",
      "speculative or style-only message",
      "malformed finding",
    ]);
    expect(parseReply('```json\n{"findings": []}\n```')).toEqual({ findings: [] });
    expect(parseReply("no json")).toBeNull();
  });

  it("blocks in block mode, reports in warn mode, and fails open when the provider errors", async () => {
    const reply = JSON.stringify({ findings: [{ line: 9, category: "behaviour_change", confidence: 0.95, evidence: "item.priceCents, 1)", message: "The reduce now starts at 1, so totals are off by one cent." }] });
    const client: ModelClient = async () => reply;
    const root = repo({ "src/money.ts": before });
    const blocked = await applyWriteReviewed(root, { path: "src/money.ts", content: after, plan: plan() }, { client });
    expect(blocked.written).toBe(false);
    expect(blocked.violations.map((v) => v.rule)).toEqual(["SemanticReview"]);
    expect(blocked.semanticReview).toMatchObject({ status: "ran", kept: 1 });

    const warnRoot = repo({ "src/money.ts": before, "ctc.config.json": JSON.stringify({ version: 1, activeMilestone: { id: "m", title: "m", allowedPaths: ["src/**"], status: "active" }, rules: { semantic: { mode: "warn" } } }) });
    const warned = await applyWriteReviewed(warnRoot, { path: "src/money.ts", content: after, plan: plan() }, { client });
    expect(warned.written).toBe(true);
    // v0.4: the deterministic differential layer also reports the changed output (as a warning, since this
    // objective does not say behaviour must be preserved); the semantic finding is the other one.
    expect(warned.warnings?.filter((w) => w.rule === "SemanticReview").length).toBe(1);

    const failRoot = repo({ "src/money.ts": before });
    const failing: ModelClient = async () => {
      throw new Error("provider down");
    };
    const open = await applyWriteReviewed(failRoot, { path: "src/money.ts", content: after, plan: plan() }, { client: failing });
    expect(open.written).toBe(true);
    expect(open.semanticReview).toMatchObject({ status: "error", reason: "provider down" });

    const heldRoot = repo({ "src/money.ts": before });
    let called = 0;
    const counting: ModelClient = async () => {
      called += 1;
      return reply;
    };
    const deterministic = await applyWriteReviewed(heldRoot, { path: "src/money.ts", content: `${after}import missing from "./nope";\n`, plan: plan() }, { client: counting });
    expect(deterministic.written).toBe(false);
    expect(called).toBe(0);
  });

  it("speaks the OpenAI-compatible and Anthropic wire formats", async () => {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/messages") res.end(JSON.stringify({ content: [{ type: "text", text: '{"findings":[]}' }] }));
        else res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const openai = httpModelClient({ provider: "openai", apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1`, model: "m1", jsonMode: true });
      expect(await openai({ system: "s", user: "u", timeoutMs: 5000 })).toBe('{"findings":[]}');
      const anthropic = httpModelClient({ provider: "anthropic", apiKey: "ak-test", baseUrl: `http://127.0.0.1:${port}`, model: "m2", jsonMode: true });
      expect(await anthropic({ system: "s", user: "u", timeoutMs: 5000 })).toBe('{"findings":[]}');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(seen[0]).toMatchObject({ url: "/v1/chat/completions", headers: { authorization: "Bearer sk-test" }, body: { model: "m1", temperature: 0, response_format: { type: "json_object" } } });
    expect(seen[1]).toMatchObject({ url: "/v1/messages", headers: { "x-api-key": "ak-test" }, body: { model: "m2", system: "s" } });
  });
});

describe("v0.3 latency", () => {
  it("keeps warm deterministic checks fast with the new rules on", () => {
    const files: Record<string, string> = { "src/dates.ts": DATES, "src/money.ts": MONEY, "test/dates.test.ts": "import { isLate } from '../src/dates';\nisLate(new Date(), new Date());\n" };
    for (let i = 0; i < 20; i += 1) files[`src/mod${i}.ts`] = `import { isLate } from "./dates";\nexport function f${i}(d: Date): boolean {\n  return isLate(d, new Date());\n}\n`;
    const root = repo(files);
    const p = plan({ allowedEditSymbols: ["addDays"], allowedNewExports: [] });
    const content = DATES.replace("days * DAY_MS", "days * DAY_MS + 0");
    analyzeProposal(root, "src/dates.ts", content, p);
    const times: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const t0 = performance.now();
      analyzeProposal(root, "src/dates.ts", content, p);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[4]).toBeLessThan(150);
  });
});
