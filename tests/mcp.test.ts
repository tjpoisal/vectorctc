import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../src/mcp/server.js";
import { HOLD_PROTOCOL, WAVE_OFF_HEADER } from "../src/engine/payload.js";
import { cleanSource, makeProject, removeProject } from "./helpers.js";

const TOOLS = [
  "ctc_apply_fix",
  "ctc_check_flightplan",
  "ctc_explain",
  "ctc_log_decision",
  "ctc_onboard_idea",
  "ctc_patch_file",
  "ctc_policy",
  "ctc_promote_task_to_flight_plan",
  "ctc_propose_patch",
  "ctc_propose_write",
  "ctc_query_radar",
  "ctc_read_file",
  "ctc_replay",
  "ctc_update_task",
  "ctc_wireframe",
  "ctc_write_file",
];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.text ?? "";
}

function jsonOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): unknown {
  const text = textOf(result);
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text) as unknown;
}

describe("MCP server", () => {
  it("lists the tools and lands a cleared write", async () => {
    const root = makeProject();
    roots.push(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(root, "0.1.0");
    await server.connect(serverTransport);
    const client = new Client({ name: "ctc-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOLS);

    const cleared = await client.callTool({
      name: "ctc_propose_write",
      arguments: { path: "src/ok.ts", content: cleanSource, projectRoot: root },
    });
    const clearedBody = jsonOf(cleared) as { cleared: boolean; written: boolean; file: string };
    expect(cleared.isError).toBeFalsy();
    expect(clearedBody).toMatchObject({ cleared: true, written: true, file: "src/ok.ts" });
    expect(fs.readFileSync(path.join(root, "src", "ok.ts"), "utf8")).toBe(cleanSource);

    const held = await client.callTool({
      name: "ctc_propose_write",
      arguments: { path: "src/locked.ts", content: cleanSource, projectRoot: root },
    });
    const heldText = textOf(held);
    const heldBody = jsonOf(held) as { protocol: string; cleared: boolean };
    expect(held.isError).toBe(true);
    expect(heldText.startsWith(WAVE_OFF_HEADER)).toBe(true);
    expect(heldText).toContain("File: src/locked.ts");
    expect(heldText.indexOf(WAVE_OFF_HEADER)).toBeLessThan(heldText.indexOf("{"));
    expect(heldBody.protocol).toBe(HOLD_PROTOCOL);
    expect(heldBody.cleared).toBe(false);

    const logged = await client.callTool({
      name: "ctc_log_decision",
      arguments: { decision: "noted", summary: "Reviewed the locked file by hand.", path: "src/locked.ts", projectRoot: root },
    });
    expect(jsonOf(logged)).toMatchObject({ protocol: "ctc.radar.v1", cleared: true });

    const radar = await client.callTool({
      name: "ctc_query_radar",
      arguments: { projectRoot: root, limit: 10 },
    });
    const radarBody = jsonOf(radar) as { count: number; entries: Array<{ decision: string }> };
    expect(radarBody.count).toBeGreaterThanOrEqual(3);
    expect(radarBody.entries.map((entry) => entry.decision)).toContain("noted");
    expect(radarBody.entries.map((entry) => entry.decision)).toContain("rejected");
    expect(radarBody.entries.map((entry) => entry.decision)).toContain("cleared");

    await client.close();
    await server.close();
  });

  it("serves the tools over stdio", async () => {
    const dist = path.resolve("dist/index.js");
    const source = path.resolve("src/mcp/server.ts");
    const stale = !fs.existsSync(dist) || fs.statSync(dist).mtimeMs < fs.statSync(source).mtimeMs;
    if (stale) execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });
    const root = makeProject();
    roots.push(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [dist, "serve"],
      cwd: root,
      stderr: "pipe",
    });
    const client = new Client({ name: "ctc-stdio", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
      const result = await client.callTool({
        name: "ctc_propose_write",
        arguments: { path: "src/stdio.ts", content: cleanSource },
      });
      expect(jsonOf(result)).toMatchObject({ cleared: true, written: true, file: "src/stdio.ts" });
      expect(fs.readFileSync(path.join(root, "src", "stdio.ts"), "utf8")).toBe(cleanSource);
    } finally {
      await client.close();
    }
  });
});
