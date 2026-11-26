import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregate } from "../src/dashboard/aggregate.js";
import { renderDashboard, renderReplayPage } from "../src/dashboard/render.js";
import { startDashboard } from "../src/dashboard/server.js";
import { applyWrite } from "../src/gate/apply.js";
import { badgeSvg, writeBadge } from "../src/insights/badge.js";
import { renderReportCardText, reportCard } from "../src/insights/report-card.js";
import { acceptSuggestion, suggestRules } from "../src/insights/suggest.js";
import { createMcpServer } from "../src/mcp/server.js";
import { effectivePolicy, modeFor } from "../src/policy/policy.js";
import { listReplays, loadReplay, renderReplayText, saveReplay } from "../src/replay/store.js";
import { setGateClient } from "../src/telemetry/client.js";
import { logDecision, readFindings, verifyChain } from "../src/telemetry/findings-log.js";
import { renderTryText, runTry } from "../src/trial/try.js";
import { plan, repo } from "./v04-helpers.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const at = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const EVAL = `export const a = 1;\nexport function run(code: string): unknown {\n  return eval(code);\n}\n`;

beforeEach(() => {
  delete process.env.CTC_FINDINGS_LOG;
  delete process.env.CTC_REPLAY;
  delete process.env.CTC_AGENT;
  delete process.env.CTC_MODEL;
  setGateClient(null);
});
afterEach(() => {
  setGateClient(null);
  delete process.env.CTC_AGENT;
  delete process.env.CTC_MODEL;
  delete process.env.CTC_REPLAY;
});

describe("v0.5 replay: why it held", () => {
  it("stores the attempted diff, rule, explanation and fix for a held write and links it from the findings log", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const result = applyWrite(root, { path: "src/a.ts", content: EVAL, plan: plan() });
    expect(result.cleared).toBe(false);
    const replay = loadReplay(root, { last: true });
    expect(replay).not.toBeNull();
    expect(replay!.decision).toBe("held");
    expect(replay!.diff).toContain("+  return eval(code);");
    expect(replay!.explanations.some((item) => item.code === "SAST_EVAL" && item.why.length > 0 && item.fix.summary.length > 0)).toBe(true);
    const record = readFindings(root).at(-1);
    expect(record?.replay).toBe(replay!.id);
    expect(verifyChain(root).ok).toBe(true);
    expect(loadReplay(root, replay!.id.slice(0, 6))?.id).toBe(replay!.id);
    const text = renderReplayText(replay!);
    expect(text).toContain("Rule broken: SAST_EVAL");
    expect(text).toContain("Why this rule exists:");
    expect(text).toContain("Suggested fix");
    expect(renderReplayPage(replay!, "demo")).toContain("SAST_EVAL");
  });

  it("never stores a secret: the diff is withheld", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const secret = `sk_live_${"d".repeat(24)}`;
    applyWrite(root, { path: "src/a.ts", content: `export const a = 1;\nexport const k = "${secret}";\n`, plan: plan() });
    const replay = loadReplay(root, { last: true });
    expect(replay?.diff).toBeNull();
    expect(replay?.diffWithheld).toBe("secret");
    for (const name of fs.readdirSync(path.join(root, ".ctc/replays"))) expect(fs.readFileSync(path.join(root, ".ctc/replays", name), "utf8")).not.toContain(secret);
  });

  it("CTC_REPLAY=off disables it, a cleared write stores nothing, and bad ids are rejected", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    applyWrite(root, { path: "src/a.ts", content: "export const a = 2;\n", plan: plan() });
    expect(listReplays(root)).toHaveLength(0);
    process.env.CTC_REPLAY = "off";
    applyWrite(root, { path: "src/a.ts", content: EVAL, plan: plan() });
    expect(listReplays(root)).toHaveLength(0);
    expect(loadReplay(root, "../../etc")).toBeNull();
  });

  it("MCP ctc_replay returns the newest replay and records the client's clientInfo in the log", async () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const server = createMcpServer(root, "0.5.0");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-agent", version: "9.9.9" });
    await client.connect(clientTransport);
    applyWrite(root, { path: "src/a.ts", content: EVAL, plan: plan() });
    expect(readFindings(root).at(-1)?.client).toEqual({ name: "test-agent", version: "9.9.9" });
    const result = (await client.callTool({ name: "ctc_replay", arguments: { projectRoot: root } })) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text) as { protocol: string; file: string; agent: string };
    expect(body).toMatchObject({ protocol: "ctc.replay.v1", file: "src/a.ts", agent: "test-agent" });
    await client.close();
  });
});

function seedAgents(root: string): void {
  const base = { surface: "mcp", taskId: "t", sessionId: "s", actor: null, ms: 10 };
  const block = (code: string) => [{ rule: "R", code, line: 1, severity: "block" as const }];
  const claude = { client: { name: "claude-code", version: "2.1.0" }, model: "model-a" };
  logDecision(root, { ...base, ...claude, ts: at(10), file: "src/a.ts", decision: "held", findings: block("PHANTOM_SYMBOL") });
  logDecision(root, { ...base, ...claude, ts: at(9), file: "src/a.ts", decision: "held", findings: block("PHANTOM_SYMBOL") });
  logDecision(root, { ...base, ...claude, ts: at(8), file: "src/a.ts", decision: "cleared", findings: [] });
  logDecision(root, { ...base, ...claude, ts: at(7), file: "src/b.ts", decision: "cleared", findings: [] });
  const cursor = { client: { name: "cursor", version: "1.0" } };
  logDecision(root, { ...base, ...cursor, ts: at(6), file: "src/c.ts", decision: "held", findings: block("SAST_EVAL") });
  logDecision(root, { ...base, ...cursor, ts: at(5), file: "src/c.ts", decision: "cleared", findings: [] });
  logDecision(root, { ...base, surface: "hook", actor: null, ts: at(4), file: "src/d.ts", decision: "cleared", findings: [] });
}

describe("v0.5 agent report card", () => {
  it("breaks hold rate, top rules and median attempts to clear down by agent and model", () => {
    const root = repo({ "README.md": "x" });
    seedAgents(root);
    const card = reportCard([root], { days: 7, now: NOW });
    expect(card.decisions).toBe(7);
    const claude = card.rows.find((row) => row.agent === "claude-code");
    expect(claude).toMatchObject({ model: "model-a", decisions: 4, held: 2, holdRate: 0.5, medianAttemptsToClear: 3, recovered: 1, versions: ["2.1.0"] });
    expect(claude?.topRules[0]).toEqual({ code: "PHANTOM_SYMBOL", rule: "R", holds: 2 });
    expect(card.rows.find((row) => row.agent === "cursor")).toMatchObject({ decisions: 2, medianAttemptsToClear: 2, model: null });
    expect(card.rows.find((row) => row.agent === "unknown (hook)")?.decisions).toBe(1);
    expect(renderReportCardText(card)).toContain("claude-code 2.1.0 · model model-a");
    const data = aggregate([root], { days: 7, now: NOW });
    expect(data.reportCard).toHaveLength(3);
    expect(renderDashboard(data)).toContain("Agent report card");
  });

  it("CTC_AGENT and CTC_MODEL label CLI and hook decisions", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    process.env.CTC_AGENT = "aider";
    process.env.CTC_MODEL = "model-b";
    applyWrite(root, { path: "src/a.ts", content: EVAL, plan: plan() });
    const record = readFindings(root).at(-1);
    expect(record?.client).toEqual({ name: "aider", version: null });
    expect(record?.model).toBe("model-b");
    expect(reportCard([root]).rows[0]).toMatchObject({ agent: "aider", model: "model-b", held: 1 });
  });
});

describe("v0.5 rule suggestions", () => {
  it("proposes graduate, lock and forbid entries from the hold history and --accept writes valid policy", () => {
    const root = repo({ "README.md": "x" });
    const base = { surface: "mcp", taskId: "t", sessionId: "s", actor: null, ms: 10 };
    for (let index = 0; index < 3; index += 1) {
      logDecision(root, { ...base, ts: at(20 - index), file: `src/x${index}.ts`, decision: "observed", findings: [{ rule: "SastRule", code: "SAST_EVAL", line: 1, severity: "observe" }] });
      logDecision(root, { ...base, ts: at(10 - index), file: `src/payments/p${index}.ts`, decision: "held", findings: [{ rule: "BoundaryCheckRule", code: "BOUNDARY_VIOLATION", line: 1, severity: "block" }] });
    }
    for (let index = 0; index < 2; index += 1) {
      saveReplay(root, {
        id: `abcdef00000${index}`,
        ts: at(3 - index),
        file: "src/ui/view.ts",
        decision: "held",
        surface: "mcp",
        agent: null,
        model: null,
        before: "",
        after: "import _ from 'lodash';\n",
        explanations: [{ id: "e", rule: "BoundaryCheckRule", code: "BANNED_PACKAGE", file: "src/ui/view.ts", severity: "block", lines: null, snippet: [], message: "Package 'lodash' is banned for this flight plan.", why: "w", fix: { kind: "manual", confidence: "none", summary: "s", hunks: [], patch: null } }],
      });
    }
    const result = suggestRules(root, { days: 7, now: NOW });
    const kinds = result.suggestions.map((item) => item.kind);
    expect(kinds).toEqual(["graduate", "lock", "forbid"]);
    const lock = result.suggestions[1]!;
    expect(lock.policy.rules?.BOUNDARY_VIOLATION).toEqual({ mode: "enforce", locked: true, paths: ["src/payments/**"] });
    expect(suggestRules(root, { days: 7, now: NOW }).suggestions.map((item) => item.id)).toEqual(result.suggestions.map((item) => item.id));
    for (const item of result.suggestions) expect(acceptSuggestion(root, item).changed).toBe(true);
    expect(acceptSuggestion(root, result.suggestions[0]!).changed).toBe(false);
    const policy = effectivePolicy(root, "src/x0.ts");
    expect(policy.errors ?? []).toHaveLength(0);
    expect(modeFor(policy, { rule: "SastRule", code: "SAST_EVAL" }, "src/x0.ts").mode).toBe("enforce");
    const written = JSON.parse(fs.readFileSync(path.join(root, ".ctc/policy.json"), "utf8")) as { forbid: Array<{ id: string; pattern: string }> };
    expect(written.forbid[0]?.id).toBe("no-lodash");
    expect(new RegExp(written.forbid[0]!.pattern).test("import _ from 'lodash';")).toBe(true);
    expect(new RegExp(written.forbid[0]!.pattern).test("import x from 'lodash-es';")).toBe(false);
  });

  it("suggests nothing from an empty history", () => {
    expect(suggestRules(repo({ "README.md": "x" })).suggestions).toEqual([]);
  });
});

describe("v0.5 badge", () => {
  it("writes an SVG and a shields.io endpoint JSON from local data only", () => {
    const root = repo({ "README.md": "x" });
    seedAgents(root);
    const result = writeBadge(root, { now: NOW, repo: "tjpoisal/vectorctc" });
    expect(result.message).toBe("hold rate 43%");
    expect(JSON.parse(fs.readFileSync(result.jsonPath, "utf8"))).toEqual({ schemaVersion: 1, label: "gated by VectorCTC", message: "hold rate 43%", color: "blue" });
    const svg = fs.readFileSync(result.svgPath, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("gated by VectorCTC");
    expect(result.snippet).toContain("img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftjpoisal%2Fvectorctc%2Fmain%2F.ctc%2Fbadge%2Fvectorctc.json");
    expect(writeBadge(repo({ "README.md": "x" })).message).toBe("hold rate n/a");
    expect(badgeSvg("a<b", "c&d", "blue")).toContain("a&lt;b");
  });
});

function gitRepo(): string {
  const root = repo({ "src/a.ts": "export const a = 1;\n" });
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(root, "src/a.ts"), EVAL);
  git("commit", "-qam", "add eval");
  fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n");
  git("add", ".");
  git("commit", "-qm", "clean");
  return root;
}

describe("v0.5 ctc try", () => {
  it("replays recent commits in a temp clone, reports holds by rule, and leaves the repo untouched", () => {
    const root = gitRepo();
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), worktrees: git("worktree", "list"), files: fs.readdirSync(root).sort(), config: fs.readFileSync(path.join(root, ".git/config"), "utf8") };
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("vectorctc-try-")).length;
    const report = runTry(root, { commits: 10, timeoutSeconds: 30 });
    expect(report.checked).toBe(2);
    expect(report.inferredConfig).toBe(true);
    expect(report.skipped).toEqual([expect.objectContaining({ reason: expect.stringContaining("root commit") })]);
    expect(report.byRule.find((item) => item.code === "SAST_EVAL")).toMatchObject({ holds: 1, commits: 1 });
    expect(report.commitsHeld).toBe(1);
    expect(renderTryText(report)).toContain("SAST_EVAL");
    expect({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), worktrees: git("worktree", "list"), files: fs.readdirSync(root).sort(), config: fs.readFileSync(path.join(root, ".git/config"), "utf8") }).toEqual(before);
    expect(fs.existsSync(path.join(root, ".ctc"))).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("vectorctc-try-")).length).toBe(tmpBefore);
  });

  it("fails clearly outside a git repo", () => {
    expect(() => runTry(repo({ "README.md": "x" }))).toThrow(/git repository/);
  });
});

describe("v0.5 dashboard replay page", () => {
  it("lists replays and serves /replay/<repo>/<id> on 127.0.0.1", async () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    applyWrite(root, { path: "src/a.ts", content: EVAL, plan: plan() });
    const data = aggregate([root]);
    expect(data.replays).toHaveLength(1);
    expect(renderDashboard(data)).toContain(`/replay/0/${data.replays[0]!.id}`);
    const running = await startDashboard([root], { port: 0 });
    try {
      const page = await fetch(`http://127.0.0.1:${running.port}/replay/0/${data.replays[0]!.id}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Why it held");
      expect((await fetch(`http://127.0.0.1:${running.port}/replay/0/ffffffffffff`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${running.port}/replay/9/${data.replays[0]!.id}`)).status).toBe(404);
    } finally {
      await running.close();
    }
  });
});

describe("v0.5 CLI", () => {
  it("try, replay, report-card, suggest-rules and badge run from the built bin", async () => {
    const { spawnSync } = await import("node:child_process");
    const dist = path.resolve("dist/index.js");
    if (!fs.existsSync(dist)) return;
    const root = gitRepo();
    applyWrite(root, { path: "src/b.ts", content: `export const b = 2;\nexport const run = (x: string): unknown => eval(x);\n`, plan: plan() });
    const run = (...args: string[]) => spawnSync(process.execPath, [dist, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, CTC_FINDINGS_LOG: "", CTC_REPLAY: "" } });
    const tried = run("try", "--commits", "5", "--json");
    expect(tried.status).toBe(0);
    expect((JSON.parse(tried.stdout) as { protocol: string }).protocol).toBe("ctc.try.v1");
    const replay = run("replay", "--last");
    expect(replay.status).toBe(0);
    expect(replay.stdout).toContain("Rule broken:");
    expect(run("replay", "--list").stdout).toContain("src/b.ts");
    const card = run("report-card", "--json");
    expect((JSON.parse(card.stdout) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect(run("suggest-rules").status).toBe(0);
    expect(run("suggest-rules", "--accept", "s-00000000").status).not.toBe(0);
    const badge = run("badge");
    expect(badge.status).toBe(0);
    expect(fs.existsSync(path.join(root, ".ctc/badge/vectorctc.svg"))).toBe(true);
  });
});

describe("v0.5 grammar loading from a text-only checkout", () => {
  it("decodes tree-sitter-<id>.wasm.b64 when the .wasm file is absent", async () => {
    const { grammarBytes } = await import("../src/lang/treesitter.js");
    const real = grammarBytes("go");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-b64-"));
    try {
      fs.writeFileSync(path.join(dir, "tree-sitter-go.wasm.b64"), real.toString("base64").replace(/(.{76})/g, "$1\n"));
      expect(grammarBytes("go", dir).equals(real)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
