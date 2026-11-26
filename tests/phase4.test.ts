import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installAgent } from "../src/universal/agents.js";
import { exportTools } from "../src/universal/tools.js";
import { installGitHooks } from "../src/universal/git-hooks.js";
import { startUniversalServer } from "../src/universal/http.js";
import { startWatch } from "../src/universal/watch.js";
import { makeProject, removeProject } from "./helpers.js";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const roots: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

const good = "export const ready = 1;\n";
const bad = "export function Bad_Name(): number {\n  return 1;\n}\n";

function keep(root: string): string {
  roots.push(root);
  return root;
}

function cli(root: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [dist, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, CTC_HTTP_TOKEN: "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

beforeAll(() => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
  const stale = !fs.existsSync(dist) || fs.statSync(dist).mtimeMs < fs.statSync(source).mtimeMs;
  if (!stale) return;
  const built = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(built.stdout + built.stderr);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) removeProject(root);
});

describe("universal CLI", () => {
  it("exits 0, 2, and 1 and prints ctc.hold.v1", () => {
    const root = keep(makeProject());
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "ready.ts"), good);
    const pass = cli(root, ["check", "src/ready.ts", "--json"]);
    expect(pass.status).toBe(0);
    expect(JSON.parse(pass.stdout).protocol).toBe("ctc.cleared.v1");

    const held = cli(root, ["check", "src/ready.ts", "--content-from", "stdin", "--json"], bad);
    expect(held.status).toBe(2);
    const body = JSON.parse(held.stdout) as { protocol: string; cleared: boolean; violations: Array<{ code: string }> };
    expect(body.protocol).toBe("ctc.hold.v1");
    expect(body.cleared).toBe(false);
    expect(body.violations.some((item) => item.code === "NAMING_DRIFT")).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "ready.ts"), "utf8")).toBe(good);

    const missing = cli(root, ["check", "src/missing.ts", "--json"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).protocol).toBe("ctc.error.v1");

    const applied = cli(root, ["apply", "src/ready.ts", "--content-from", "stdin", "--json"], bad);
    expect(applied.status).toBe(2);
    expect(JSON.parse(applied.stdout).protocol).toBe("ctc.hold.v1");
    expect(fs.readFileSync(path.join(root, "src", "ready.ts"), "utf8")).toBe(good);

    const landed = cli(root, ["apply", "src/landed.ts", "--content-from", "stdin", "--json"], good);
    expect(landed.status).toBe(0);
    expect(fs.readFileSync(path.join(root, "src", "landed.ts"), "utf8")).toBe(good);
  });
});

describe("REST and tool export", () => {
  it("serves check, write, patch, read, blueprint, status, and OpenAPI", async () => {
    const root = keep(makeProject());
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "ready.ts"), good);
    const running = await startUniversalServer(root, { port: 0, token: "" });
    closers.push(running.close);
    const base = `http://127.0.0.1:${running.port}`;

    const spec = await fetch(`${base}/openapi.json`).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.1.0");
    expect(spec.body.paths["/v1/check"]).toBeTruthy();

    const checked = await fetch(`${base}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/ready.ts", content: bad }),
    });
    expect(checked.status).toBe(409);
    const hold = (await checked.json()) as { protocol: string };
    expect(hold.protocol).toBe("ctc.hold.v1");

    const written = await fetch(`${base}/v1/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/ready.ts", content: good }),
    });
    expect(written.status).toBe(200);

    const patched = await fetch(`${base}/v1/patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/ready.ts", hunks: [{ search: "ready", replace: "steady" }] }),
    });
    expect(patched.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "src", "ready.ts"), "utf8")).toContain("steady");

    const read = await fetch(`${base}/v1/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "src/ready.ts" }),
    });
    expect(read.status).toBe(200);

    const blueprint = await fetch(`${base}/v1/blueprint`);
    expect(blueprint.status).toBe(200);
    const status = await fetch(`${base}/v1/status`);
    const statusBody = (await status.json()) as { contract: string };
    expect(statusBody.contract).toBe("milestone");

    const locked = await startUniversalServer(root, { port: 0, token: "secret" });
    closers.push(locked.close);
    const denied = await fetch(`http://127.0.0.1:${locked.port}/v1/status`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`http://127.0.0.1:${locked.port}/v1/status`, { headers: { authorization: "Bearer secret" } });
    expect(allowed.status).toBe(200);
    const open = await fetch(`http://127.0.0.1:${locked.port}/openapi.json`);
    expect(open.status).toBe(200);

    const client = new Client({ name: "ctc-phase4", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("ctc_write_file");
    await client.close();
  });

  it("exports openai, anthropic, gemini, and json-schema tools", () => {
    const root = keep(makeProject());
    for (const format of ["openai", "anthropic", "gemini", "json-schema"] as const) {
      const printed = cli(root, ["export-tools", "--format", format]);
      expect(printed.status).toBe(0);
      const body = JSON.parse(printed.stdout) as Record<string, unknown>;
      if (format === "gemini") expect(Array.isArray(body.function_declarations)).toBe(true);
      else expect(Array.isArray(body.tools)).toBe(true);
    }
    const openai = exportTools("openai") as { tools: Array<{ type: string; function: { name: string } }> };
    expect(openai.tools[0]?.type).toBe("function");
    expect(openai.tools.map((tool) => tool.function.name)).toContain("ctc_check");
    const anthropic = exportTools("anthropic") as { tools: Array<{ input_schema: { type: string } }> };
    expect(anthropic.tools[0]?.input_schema.type).toBe("object");
    const schema = exportTools("json-schema") as { tools: Array<{ inputSchema: { type: string } }> };
    expect(schema.tools[0]?.inputSchema.type).toBe("object");
  });
});

describe("git hooks and watch", () => {
  it("rejects a staged naming violation and a pushed commit", () => {
    const root = keep(makeProject());
    fs.mkdirSync(path.join(root, "src"));
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "ctc@example.com"]);
    git(root, ["config", "user.name", "CTC"]);
    installGitHooks(root, [process.execPath, dist]);
    fs.writeFileSync(path.join(root, "src", "ready.ts"), bad);
    git(root, ["add", "src/ready.ts"]);
    const blocked = spawnSync("sh", [path.join(root, ".git", "hooks", "pre-commit")], { cwd: root, encoding: "utf8" });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("ctc.hold.v1");

    fs.writeFileSync(path.join(root, "src", "ready.ts"), good);
    git(root, ["add", "src/ready.ts"]);
    const allowed = spawnSync("sh", [path.join(root, ".git", "hooks", "pre-commit")], { cwd: root, encoding: "utf8" });
    expect(allowed.status).toBe(0);

    fs.writeFileSync(path.join(root, "src", "ready.ts"), bad);
    git(root, ["add", "src/ready.ts"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "bad"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    const pushed = spawnSync("sh", [path.join(root, ".git", "hooks", "pre-push")], {
      cwd: root,
      encoding: "utf8",
      input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    });
    expect(pushed.status).toBe(2);
  });

  it("reverts a bad edit to the last good snapshot", async () => {
    const root = keep(makeProject());
    const file = path.join(root, "src", "ready.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, good);
    const watch = startWatch(root, { revert: true, debounceMs: 30 });
    closers.push(() => watch.stop());
    const snap = path.join(root, ".ctc", "snapshots", "src", "ready.ts");
    await waitFor(() => fs.existsSync(snap) && fs.readFileSync(snap, "utf8") === good);
    fs.writeFileSync(file, bad);
    await waitFor(() => fs.readFileSync(file, "utf8") === good);
    const log = fs.readFileSync(path.join(root, ".ctc", "violations.jsonl"), "utf8");
    expect(log).toContain("NAMING_DRIFT");
    expect(log).toContain("\"reverted\":true");
  });
});

describe("agent install", () => {
  it("writes a verified Cursor config and a Cline snippet", () => {
    const root = keep(makeProject());
    const cursor = installAgent(root, "cursor", [process.execPath, dist]);
    expect(cursor.verified).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers["code-traffic-control"]?.command).toBe(process.execPath);
    // The MCP entry must start the server, not the bare CLI (which prints help and exits).
    expect(mcp.mcpServers["code-traffic-control"]?.args).toEqual([dist, "serve"]);
    const cline = installAgent(root, "cline", [process.execPath, dist]);
    expect(cline.verified).toBe(false);
    expect(fs.existsSync(path.join(root, ".ctc", "agents", "cline_mcp_settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for the watcher");
}
