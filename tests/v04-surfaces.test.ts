import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { COMMENT_MARKER, ciAnnotations, ciMarkdown, runCi } from "../src/ci/ci.js";
import { publishToGitHub } from "../src/ci/github.js";
import { evaluateHook } from "../src/hook.js";
import { installGatedAgent } from "../src/universal/agents-gated.js";
import { applyHunks, toDiagnostics } from "../integrations/vscode/src/map.mjs";
import { repo } from "./v04-helpers.js";

process.env.CTC_ORG_POLICY = "/nonexistent/ctc-org-policy.json";

const CONFIG = JSON.stringify({ version: 1, activeMilestone: { id: "m", title: "m", allowedPaths: ["src/**"], status: "active" } });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function prRepo(change: (root: string) => void): string {
  const root = repo({ "ctc.config.json": CONFIG, "src/dates.ts": "export function isLate(due: number, now: number): boolean {\n  return due < now;\n}\n", "README.md": "x\n" });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  change(root);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change");
  return root;
}

describe("v0.4 item 6: CI check, PR comment, explainable auto-approve", () => {
  it("holds a PR that adds a secret and a boundary flip, with annotations and a sticky comment", () => {
    const root = prRepo((dir) => {
      fs.writeFileSync(path.join(dir, "src/dates.ts"), "export function isLate(due: number, now: number): boolean {\n  return due <= now;\n}\n");
      fs.writeFileSync(path.join(dir, "src/keys.ts"), `export const token = "ghp_${"b".repeat(36)}";\n`);
      fs.writeFileSync(path.join(dir, "README.md"), "y\n");
    });
    const report = runCi(root, { base: "main", autoApprove: true });
    expect(report.cleared).toBe(false);
    const codes = report.files.flatMap((file) => file.holds.map((item) => `${file.file}:${item.code}`));
    expect(codes).toEqual(expect.arrayContaining(["src/dates.ts:BOUNDARY_FLIP", "src/keys.ts:SECRET_GITHUB_TOKEN"]));
    expect(codes.some((item) => item.startsWith("README.md"))).toBe(false);
    expect(report.risk.approvable).toBe(false);
    const md = ciMarkdown(report);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain("```diff");
    expect(md).not.toContain("b".repeat(36));
    expect(ciAnnotations(report)).toMatch(/::error file=src\/dates\.ts,line=2,title=BOUNDARY_FLIP::/);
  });

  it("reports ticket acceptance-criteria coverage and keeps auto-approve off when a criterion is untouched", () => {
    const root = prRepo((dir) => fs.writeFileSync(path.join(dir, "src/dates.ts"), "export function isLate(due: number, now: number): boolean {\n  // late when due is strictly before now\n  return due < now;\n}\n"));
    const ticket = "Fix late invoices\n\nAcceptance criteria:\n- isLate treats due dates strictly before now as late\n- Reminder emails mention the late fee\n";
    const report = runCi(root, { base: "main", autoApprove: true, ticket });
    expect(report.ticket?.map((item) => item.covered)).toEqual([true, false]);
    expect(report.risk.factors.find((factor) => factor.id === "ticket")?.ok).toBe(false);
    expect(report.risk.approvable).toBe(false);
    expect(ciMarkdown(report)).toContain("Ticket coverage");
  });

  it("approves a small clean PR only when opted in, listing every risk factor", async () => {
    const root = prRepo((dir) => fs.writeFileSync(path.join(dir, "src/dates.ts"), "export function isLate(due: number, now: number): boolean {\n  // strictly before\n  return due < now;\n}\n"));
    expect(runCi(root, { base: "main" }).risk).toMatchObject({ level: "low", approvable: false });
    const report = runCi(root, { base: "main", autoApprove: true });
    expect(report.cleared).toBe(true);
    expect(report.risk.approvable).toBe(true);
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    let comments: Array<{ id: number; body: string }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: String(init.body) } : {}) });
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify(comments), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const ctx = { token: "t", repository: "o/r", prNumber: 7, apiBase: "https://api.example" };
    expect(await publishToGitHub(report, ctx, fake)).toEqual({ comment: "created", approved: true });
    expect(calls.map((call) => `${call.method} ${call.url.replace(ctx.apiBase, "")}`)).toEqual(["GET /repos/o/r/issues/7/comments?per_page=100", "POST /repos/o/r/issues/7/comments", "POST /repos/o/r/pulls/7/reviews"]);
    expect(calls[2]?.body).toContain("APPROVE");
    comments = [{ id: 99, body: `${COMMENT_MARKER}\nold` }];
    calls.length = 0;
    const second = await publishToGitHub({ ...report, risk: { ...report.risk, approvable: false } }, ctx, fake);
    expect(second).toEqual({ comment: "updated", approved: false });
    expect(calls[1]?.url).toContain("/issues/comments/99");
  });

  it("action.yml and the example workflow wire the CLI as a required check", () => {
    const action = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");
    expect(action).toContain("dist/index.js");
    expect(action).toContain("--auto-approve");
    expect(fs.readFileSync(path.join(__dirname, "..", "examples/workflows/vectorctc.yml"), "utf8")).toContain("fetch-depth: 0");
  });
});

describe("v0.4 item 7: pre-commit and editor surfaces show the same findings", () => {
  it("the VS Code mapper turns a hold payload into diagnostics with a verified quick fix", () => {
    const payload = {
      violations: [{ code: "BOUNDARY_FLIP", line: 2, column: 1, message: "flip", fix: "revert" }],
      warnings: [{ code: "SAST_EVAL", line: 5, column: 3, message: "eval", fix: "parse", observed: true }],
      explain: { explanations: [{ id: "abc", code: "BOUNDARY_FLIP", lines: { start: 2, end: 2 }, why: "boundaries matter", fix: { summary: "Restore", hunks: [{ search: "due <= now", replace: "due < now" }] } }] },
    };
    const diagnostics = toDiagnostics(payload);
    expect(diagnostics[0]).toMatchObject({ severity: "error", code: "BOUNDARY_FLIP", range: { startLine: 1 } });
    expect(diagnostics[0]?.message).toContain("Why: boundaries matter");
    expect(diagnostics[0]?.fix?.hunks[0]?.replace).toBe("due < now");
    expect(diagnostics[1]?.severity).toBe("information");
    expect(applyHunks("return due <= now;", [{ search: "due <= now", replace: "due < now" }])).toBe("return due < now;");
    expect(applyHunks("x", [{ search: "y", replace: "z" }])).toBeNull();
  });

  it("ships a pre-commit framework hook", () => {
    expect(fs.readFileSync(path.join(__dirname, "..", ".pre-commit-hooks.yaml"), "utf8")).toContain("git-guard pre-commit");
  });
});

describe("v0.4 item 8: one-click gated init", () => {
  it("claude strict denies native edit tools and pre-allows the gate tools; hook mode re-enables them", () => {
    const root = repo({}, { tsconfig: false });
    installGatedAgent(root, "claude", ["node", "/x/ctc.js"], true);
    const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit"]));
    expect(settings.permissions.allow).toContain("mcp__code-traffic-control__ctc_write_file");
    expect(settings.hooks.PreToolUse[0].matcher).toContain("Edit");
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("ctc_apply_fix");
    installGatedAgent(root, "claude", ["node", "/x/ctc.js"], false);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")).permissions.deny).toEqual([]);
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").match(/ctc:begin/g)?.length).toBe(1);
  });

  it("copilot gets an MCP server and a custom agent with no built-in edit tool; cursor gets hook + redirect rule", () => {
    const root = repo({ ".github/copilot-instructions.md": "# Existing\n- keep me\n" }, { tsconfig: false });
    const copilot = installGatedAgent(root, "copilot", ["ctc"], true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".vscode/mcp.json"), "utf8")).servers["code-traffic-control"].type).toBe("stdio");
    const agent = fs.readFileSync(path.join(root, ".github/agents/ctc-gated.agent.md"), "utf8");
    expect(agent).toMatch(/tools: \['code-traffic-control\/\*'/);
    expect(agent).not.toMatch(/'edit/);
    expect(fs.readFileSync(path.join(root, ".github/copilot-instructions.md"), "utf8")).toContain("keep me");
    expect(copilot.enforcement).toContain("advisory");
    const cursor = installGatedAgent(root, "cursor", ["ctc"], true);
    expect(cursor.files.some((file) => file.endsWith("ctc-gate.mdc"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".cursor/hooks.json"), "utf8")).hooks.preToolUse[0].command).toContain("hook --cursor");
  });

  it("the native-edit hook now applies the v0.4 gate (a secret in a Write is denied with the explain next step)", () => {
    const root = repo({ "ctc.config.json": CONFIG, "src/a.ts": "export const a = 1;\n" });
    const outcome = evaluateHook({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, "src/a.ts"), content: `export const a = 1;\nexport const k = "sk_live_${"c".repeat(24)}";\n` } });
    expect(outcome.permission).toBe("deny");
    expect(outcome.reason).toContain("SECRET_STRIPE_KEY");
    expect(outcome.reason).toContain("Next:");
  });
});

describe("v0.4 secrets never persist", () => {
  it("a held secret is redacted in explain and not stored in the fix ledger", async () => {
    const { applyWrite } = await import("../src/gate/apply.js");
    const { plan } = await import("./v04-helpers.js");
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const secret = `sk_live_${"d".repeat(24)}`;
    const result = applyWrite(root, { path: "src/a.ts", content: `export const a = 1;\nexport const k = "${secret}";\n`, plan: plan() });
    expect(result.cleared).toBe(false);
    expect(JSON.stringify(result.explain?.explanations[0]?.snippet)).not.toContain(secret);
    expect(result.explain?.explanations[0]?.fix.patch).toBeNull();
    expect(fs.readFileSync(path.join(root, ".ctc/fix-ledger.json"), "utf8")).not.toContain(secret);
    expect(fs.readFileSync(path.join(root, ".ctc/findings.jsonl"), "utf8")).not.toContain(secret);
  });
});
