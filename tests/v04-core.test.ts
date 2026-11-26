import { describe, expect, it } from "vitest";

import { analyzeProposal } from "../src/gate/analyzer.js";
import { plan, repo } from "./v04-helpers.js";

const PARSE = `export interface ParsedHost { hostname: string; port?: string }

export function other(): number {
  return 1;
}

export function parseHost(input = ""): ParsedHost {
  const [hostname, port] = input.split(":");
  return { hostname: hostname ?? "", port };
}
`;

describe("v0.4 item 1: finding locations", () => {
  it("reports a breaking signature change at the changed export, not line 1 (ufo-x02 shape)", () => {
    const root = repo({
      "src/parse.ts": PARSE,
      "src/url.ts": `import { parseHost, other } from "./parse";\nexport const host = parseHost("a:1").hostname + other();\n`,
    });
    const after = PARSE.replace(`export function other(): number {\n  return 1;\n}`, `export function other(): string {\n  return "1";\n}`).replace(
      `parseHost(input = ""): ParsedHost`,
      `parseHost(input = "", defaultPort: string): ParsedHost`,
    ).replace("port };", "port: port ?? defaultPort };");
    const found = analyzeProposal(root, "src/parse.ts", after, plan()).violations.filter((v) => v.code === "BREAKING_CHANGE");
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((v) => v.line === 7 && v.message.includes("parseHost"))).toBe(true);
    expect(found.every((v) => v.line !== 1)).toBe(true);
  });
});

const HTTP = `export interface RequestOptions {
  method?: string;
  retries?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
  });
  return res.json();
}

export function unrelated(): number {
  return 1;
}
`;

describe("v0.4 item 1: edit scope follows type users and callees", () => {
  it("allows the function that reads a member the plan just added (app-x04 shape)", () => {
    const root = repo({ "src/http.ts": HTTP });
    const after = HTTP.replace("  retries?: number;\n}", "  retries?: number;\n  timeoutMs?: number;\n}").replace(
      `    method: options.method ?? "GET",\n`,
      `    method: options.method ?? "GET",\n    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),\n`,
    );
    const found = analyzeProposal(root, "src/http.ts", after, plan({ allowedEditSymbols: ["RequestOptions", "timeoutMs", "Add", "an"] })).violations;
    expect(found.filter((v) => v.code === "EDIT_OUTSIDE_PLAN_SCOPE")).toEqual([]);
  });

  it("still holds an unrelated rewrite in the same file", () => {
    const root = repo({ "src/http.ts": HTTP });
    const after = HTTP.replace("  retries?: number;\n}", "  retries?: number;\n  timeoutMs?: number;\n}").replace("return 1;", "return 2;");
    const found = analyzeProposal(root, "src/http.ts", after, plan({ allowedEditSymbols: ["RequestOptions", "timeoutMs"] })).violations;
    expect(found.some((v) => v.code === "EDIT_OUTSIDE_PLAN_SCOPE" && v.message.includes("unrelated") && v.line === 15)).toBe(true);
  });
});

import fs from "node:fs";
import path from "node:path";

import { applyFix } from "../src/explain/apply-fix.js";
import { applyExplainedFixes, explainViolations } from "../src/explain/explain.js";
import { readLedger } from "../src/explain/ledger.js";
import { applyWrite } from "../src/gate/apply.js";
import { effectivePolicy, modeFor } from "../src/policy/policy.js";
import { importRuleFiles } from "../src/policy/rulefiles.js";
import { affects, scaViolations } from "../src/security/advisories.js";
import { sastViolations } from "../src/security/sast.js";
import { secretViolations } from "../src/security/secrets.js";
import { inRange, minVersionOf } from "../src/security/semver.js";
import { readFindings, verifyChain } from "../src/telemetry/findings-log.js";

process.env.CTC_ORG_POLICY = "/nonexistent/ctc-org-policy.json";

const DATES = `const DAY_MS = 24 * 60 * 60 * 1000;

/** True when \`due\` is strictly before \`now\`. */
export function isLate(due: Date, now: Date): boolean {
  return due.getTime() < now.getTime();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
`;

describe("v0.4 item 2: explain the block + fix loop", () => {
  it("explains a boundary flip with the exact lines, why, and an exact revert patch", () => {
    const root = repo({ "src/dates.ts": DATES });
    const after = DATES.replace("due.getTime() < now.getTime()", "due.getTime() <= now.getTime()");
    const p = plan();
    const result = applyWrite(root, { path: "src/dates.ts", content: after, plan: p });
    expect(result.cleared).toBe(false);
    const report = result.explain;
    expect(report?.protocol).toBe("ctc.explain.v1");
    const flip = report?.explanations.find((item) => item.code === "BOUNDARY_FLIP");
    expect(flip?.lines?.start).toBeGreaterThan(0);
    expect(flip?.why).toMatch(/boundary/);
    expect(flip?.snippet.join("\n")).toContain("<=");
    expect(flip?.fix.kind).toBe("revert-hunk");
    expect(flip?.fix.patch).toContain("-  return due.getTime() <= now.getTime();");
    const fixed = applyExplainedFixes(after, report?.explanations ?? []);
    expect(fixed.content).toBe(DATES);
  });

  it("ctc_apply_fix re-gates the fixed proposal, writes it, and the ledger closes the finding", async () => {
    const root = repo({ "src/dates.ts": DATES, "ctc.config.json": JSON.stringify({ version: 1, activeMilestone: { id: "m", title: "m", allowedPaths: ["src/**"], status: "active" } }) });
    fs.mkdirSync(path.join(root, ".ctc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ctc", "flight-plan.json"), JSON.stringify(plan()));
    const after = DATES.replace("due.getTime() < now.getTime()", "due.getTime() <= now.getTime()");
    const first = applyWrite(root, { path: "src/dates.ts", content: after });
    expect(first.cleared).toBe(false);
    const second = applyWrite(root, { path: "src/dates.ts", content: after });
    expect(second.fixLoop?.stuck.length).toBeGreaterThan(0);
    expect(second.fixLoop?.stuck[0]?.action).toContain("ctc_apply_fix");
    const fixed = await applyFix(root, "src/dates.ts");
    expect(fixed.applied.length).toBe(1);
    expect(fixed.result?.cleared).toBe(true);
    expect(fs.readFileSync(path.join(root, "src/dates.ts"), "utf8")).toBe(DATES);
    const ledger = readLedger(root).files["src/dates.ts"];
    expect(Object.keys(ledger?.open ?? {})).toEqual([]);
    expect(ledger?.resolved[0]?.via).toBe("ctc_apply_fix");
  });

  it("suggests deleting dead code and an env var for a secret", () => {
    // Built at runtime so repository secret scanners do not flag the fixture; the gate sees the full literal.
    const after = `export const a = 1;\nconst apiKey = "${"sk_" + "live_"}abcdefghijklmnopqrstuvwx";\n`;
    const report = explainViolations("src/x.ts", null, after, [
      { rule: "SecretScan", code: "SECRET_STRIPE_KEY", file: "src/x.ts", line: 2, column: 1, message: "m", fix: "Load it from the environment (process.env.STRIPE_SECRET_KEY)." },
    ]);
    expect(report.explanations[0]?.fix.hunks[0]?.replace).toContain("process.env.STRIPE_SECRET_KEY");
  });
});

describe("v0.4 item 3: agent rule files as enforceable policy", () => {
  const files = {
    "AGENTS.md": "# Rules\n- Do not add axios, lodash, moment or dayjs.\n- Routes must never import from `src/db`; go through `InvoiceService`.\n- Only touch the files a task names.\n",
    "src/legacy/AGENTS.md": "- Never use `console.log` here.\n",
    ".cursor/rules/style.mdc": "---\nglobs: src/**/*.ts\nalwaysApply: false\n---\n- Use `logger.info` instead of `console.info`.\n- <!-- ctc: forbid-code debugger -->\n",
    ".cursor/rules/ideas.mdc": "---\ndescription: optional\n---\n- Never use `eval`.\n",
    ".github/copilot-instructions.md": "- Do not edit `db/migrations/**`.\n",
    ".github/instructions/api.instructions.md": "---\napplyTo: \"src/api/**\"\n---\n- Exported functions must have JSDoc.\n",
  };

  it("compiles checkable lines with provenance and reports the rest as advisory", () => {
    const root = repo(files);
    const report = importRuleFiles(root);
    const kinds = report.compiled.map((rule) => `${rule.kind}:${rule.target}`);
    expect(kinds).toEqual(expect.arrayContaining(["banned-import:axios", "banned-import:dayjs", "banned-import:src/db", "forbidden-code:console.log", "forbidden-code:console.info", "forbidden-code:debugger", "locked-path:db/migrations/**", "require-jsdoc-exports:exports"]));
    expect(kinds).not.toContain("forbidden-code:InvoiceService");
    expect(kinds).not.toContain("forbidden-code:eval");
    expect(report.advisory.some((item) => item.text.includes("Only touch"))).toBe(true);
    expect(report.compiled.find((rule) => rule.target === "src/db")?.scope).toContain("**/routes/**");
    expect(report.compiled.find((rule) => rule.target === "console.log")?.source).toBe("src/legacy/AGENTS.md:1");
  });

  it("holds writes that break them, citing file:line, and only in scope", () => {
    const root = repo({ ...files, "src/routes/a.ts": "export const x = 1;\n", "src/db/index.ts": "export const db = 1;\n", "src/legacy/old.ts": "export const y = 1;\n", "src/api/h.ts": "export const z = 1;\n" });
    const codes = (file: string, content: string): string[] => applyWrite(root, { path: file, content, plan: plan() }).violations.map((v) => `${v.code}@${v.line}`);
    expect(codes("src/routes/a.ts", `import { db } from "../db/index";\nimport axios from "axios";\nexport const x = db;\nvoid axios;\n`)).toEqual(expect.arrayContaining(["POLICY_BANNED_IMPORT@1", "POLICY_BANNED_IMPORT@2"]));
    expect(codes("src/legacy/old.ts", `export const y = 1;\nconsole.log(y);\n`)).toContain("POLICY_FORBIDDEN_CODE@2");
    expect(codes("src/routes/a.ts", `export const x = 1;\nconsole.log(x);\n`)).not.toContain("POLICY_FORBIDDEN_CODE@2");
    expect(codes("src/api/h.ts", `export const z = 1;\nexport function handler(): number {\n  return z;\n}\n`)).toContain("POLICY_JSDOC_REQUIRED@2");
    const held = applyWrite(root, { path: "src/legacy/old.ts", content: `export const y = 1;\nconsole.log(y);\n`, plan: plan() });
    expect(held.violations[0]?.message).toContain("src/legacy/AGENTS.md:1");
  });
});

describe("v0.4 item 4: observe mode and policy inheritance", () => {
  it("merges org → repo → directory, keeps locked org settings, and reports the conflict", () => {
    const root = repo({
      ".ctc/policy.json": JSON.stringify({ version: 1, rules: { SecretScan: { mode: "observe" }, "SAST_*": { mode: "observe" } } }),
      "src/payments/.ctc-policy.json": JSON.stringify({ version: 1, rules: { "SAST_*": { mode: "enforce" } } }),
      "org/policy.json": JSON.stringify({ version: 1, mode: "enforce", rules: { SecretScan: { mode: "enforce", locked: true } } }),
    });
    const env = { ...process.env, CTC_ORG_POLICY: path.join(root, "org/policy.json") };
    const top = effectivePolicy(root, "src/a.ts", env);
    expect(modeFor(top, { rule: "SecretScan", code: "SECRET_GENERIC" }, "src/a.ts").mode).toBe("enforce");
    expect(top.conflicts[0]).toContain("locked");
    expect(modeFor(top, { rule: "SastRule", code: "SAST_EVAL" }, "src/a.ts").mode).toBe("observe");
    const deep = effectivePolicy(root, "src/payments/pay.ts", env);
    expect(modeFor(deep, { rule: "SastRule", code: "SAST_EVAL" }, "src/payments/pay.ts")).toEqual({ mode: "enforce", setBy: "src/payments/.ctc-policy.json" });
  });

  it("observe mode writes the file, returns would-have-blocked findings, and logs them in a verifiable chain", () => {
    const root = repo({ ".ctc/policy.json": JSON.stringify({ version: 1, mode: "observe" }), "src/a.ts": "export const a = 1;\n" });
    const result = applyWrite(root, { path: "src/a.ts", content: `export const a = 1;\nexport function run(code: string): unknown {\n  return eval(code);\n}\n`, plan: plan() });
    expect(result.cleared).toBe(true);
    expect(result.observed?.some((item) => item.code === "SAST_EVAL" && item.severity === "observe")).toBe(true);
    const log = readFindings(root);
    expect(log.at(-1)?.decision).toBe("observed");
    expect(verifyChain(root).ok).toBe(true);
    const file = path.join(root, ".ctc/findings.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"observed"', '"cleared"'));
    expect(verifyChain(root).ok).toBe(false);
  });

  it("a broken policy file fails closed", () => {
    const root = repo({ ".ctc/policy.json": "{ not json", "src/a.ts": "export const a = 1;\n" });
    const result = applyWrite(root, { path: "src/a.ts", content: "export const a = 2;\n", plan: plan() });
    expect(result.violations.some((item) => item.code === "POLICY_FILE_INVALID")).toBe(true);
  });
});

describe("v0.4 item 5: secrets, SAST and SCA in the pre-write gate", () => {
  it("catches provider keys and high-entropy credentials on new lines only, redacted", () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const found = secretViolations("config/app.yaml", null, `aws: ${key}\npassword: "changeme"\nclient_secret: "q8Zr2LmP0xWv7NsTb4Yc"\n`);
    expect(found.map((item) => item.code)).toEqual(["SECRET_AWS_ACCESS_KEY", "SECRET_GENERIC"]);
    expect(found[0]?.message).not.toContain(key);
    expect(secretViolations("a.ts", `const k = "${key}";\n`, `const k = "${key}";\nexport {};\n`)).toEqual([]);
    expect(secretViolations("a.ts", null, `const k = "${key}"; // ctc-allow-secret\n`)).toEqual([]);
  });

  it("flags high-precision SAST patterns per language with CWE ids", () => {
    expect(sastViolations("a.ts", null, "exec(`rm -rf ${dir}`);\n")[0]?.cwe).toBe("CWE-78");
    expect(sastViolations("a.ts", null, 'db.query(`SELECT * FROM t WHERE id = ${id}`);\n')[0]?.code).toBe("SAST_SQL_INJECTION");
    expect(sastViolations("a.ts", null, 'db.query("SELECT * FROM t WHERE id = $1", [id]);\n')).toEqual([]);
    expect(sastViolations("a.py", null, "subprocess.run(cmd, shell=True)\n")[0]?.code).toBe("SAST_SHELL_TRUE");
    expect(sastViolations("a.go", null, "tls.Config{InsecureSkipVerify: true}\n")[0]?.code).toBe("SAST_TLS_DISABLED");
    expect(sastViolations("a.ts", null, "// eval(x) is bad\n")).toEqual([]);
  });

  it("semver ranges and manifest minimums", () => {
    expect(inRange("1.2.5", [{ introduced: "0" }, { fixed: "1.2.6" }])).toBe(true);
    expect(inRange("1.2.6", [{ introduced: "0" }, { fixed: "1.2.6" }])).toBe(false);
    expect(inRange("2.0.0", [{ introduced: "1.0.0" }, { last_affected: "1.9.9" }])).toBe(false);
    expect(minVersionOf("^4.17.20")).toBe("4.17.20");
    expect(minVersionOf(">=2")).toBe("2.0.0");
    expect(minVersionOf("workspace:*")).toBeNull();
    expect(affects({ id: "X", summary: "", severity: "high", ranges: [[{ introduced: "0" }, { fixed: "1.2.6" }]] }, "1.0.0")).toBe(true);
  });

  it("holds a lockfile/manifest change that adds a version with a known advisory (built-in OSV seed), offline", () => {
    const found = scaViolations("/nonexistent", "package.json", JSON.stringify({ dependencies: {} }), JSON.stringify({ dependencies: { minimist: "1.2.5" } }, null, 2));
    expect(found[0]?.code).toBe("VULNERABLE_DEPENDENCY");
    expect(found[0]?.message).toMatch(/minimist@1\.2\.5.*GHSA-/);
    expect(found[0]?.fix).toMatch(/minimist@\d/);
    expect(scaViolations("/nonexistent", "package.json", JSON.stringify({ dependencies: { minimist: "1.2.5" } }), JSON.stringify({ dependencies: { minimist: "1.2.5" }, name: "x" }))).toEqual([]);
    const reqs = scaViolations("/nonexistent", "requirements.txt", "", "pyyaml==5.3\n");
    expect(reqs[0]?.code).toBe("VULNERABLE_DEPENDENCY");
  });

  it("runs on non-TypeScript files through the same gate", () => {
    const root = repo({ "config/.env.production": "PORT=1\n" });
    const result = applyWrite(root, { path: "config/.env.production", content: `PORT=1\nGITHUB_TOKEN=ghp_${"a".repeat(36)}\n`, plan: plan({ allowedFileGlobs: ["config/**"] }) });
    expect(result.cleared).toBe(false);
    expect(result.violations[0]?.code).toBe("SECRET_GITHUB_TOKEN");
    expect(fs.readFileSync(path.join(root, "config/.env.production"), "utf8")).toBe("PORT=1\n");
  });
});
