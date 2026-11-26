import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { aggregate } from "../src/dashboard/aggregate.js";
import { renderDashboard } from "../src/dashboard/render.js";
import { startDashboard } from "../src/dashboard/server.js";
import { logDecision } from "../src/telemetry/findings-log.js";
import { repo } from "./v04-helpers.js";

const NOW = new Date("2026-11-20T12:00:00Z");

function seed(root: string): void {
  delete process.env.CTC_FINDINGS_LOG;
  const base = { surface: "mcp", taskId: "t", sessionId: "s", actor: "agent-1", ms: 40 };
  const at = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  logDecision(root, { ...base, ts: at(30), file: "src/a.ts", decision: "held", findings: [{ rule: "PhantomSymbolRule", code: "PHANTOM_SYMBOL", line: 3, severity: "block" }] });
  logDecision(root, { ...base, ts: at(29), file: "src/a.ts", decision: "held", findings: [{ rule: "PhantomSymbolRule", code: "PHANTOM_SYMBOL", line: 3, severity: "block" }] });
  logDecision(root, { ...base, ts: at(28), file: "src/a.ts", decision: "cleared", findings: [] });
  logDecision(root, { ...base, surface: "ci", actor: null, ts: at(5), file: "src/b.ts", decision: "observed", ms: 120, findings: [{ rule: "SastRule", code: "SAST_EVAL", line: 9, severity: "observe" }] });
  logDecision(root, { ...base, ts: at(2), file: "src/c.ts", decision: "held", findings: [{ rule: "SecretScan", code: "SECRET_AWS_KEY", line: 1, severity: "block" }] });
  process.env.CTC_FINDINGS_LOG = "off";
}

describe("v0.4 item 12: team dashboard", () => {
  it("aggregates decisions, rollout impact, hotspots and the fix loop across repos", () => {
    const one = repo({ "README.md": "x" });
    const two = repo({ "README.md": "y" });
    seed(one);
    seed(two);
    const data = aggregate([one, two], { days: 7, now: NOW });
    expect(data.totals).toMatchObject({ decisions: 10, held: 6, cleared: 2, observed: 2 });
    expect(data.repos.every((item) => item.chain.ok)).toBe(true);
    expect(data.codes[0]?.code).toBe("PHANTOM_SYMBOL");
    expect(data.rollout).toEqual([expect.objectContaining({ code: "SAST_EVAL", wouldBlock: 2 })]);
    expect(data.fixLoop).toMatchObject({ recovered: 2, medianAttempts: 3, stillHeld: 2 });
    expect(data.surfaces.find((item) => item.name === "ci")?.decisions).toBe(2);
    expect(data.daily).toHaveLength(7);
    expect(data.daily.reduce((sum, day) => sum + day.held + day.cleared + day.observed, 0)).toBe(10);
    const html = renderDashboard(data);
    expect(html).toContain("SAST_EVAL");
    expect(html).toContain("intact");
    expect(html).not.toMatch(/<script/);
  });

  it("reports a tampered audit chain and serves HTML + JSON on 127.0.0.1", async () => {
    const root = repo({ "README.md": "x" });
    seed(root);
    const file = path.join(root, ".ctc/findings.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    lines[1] = lines[1]!.replace('"held"', '"cleared"');
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const running = await startDashboard([root], { port: 0, days: 3650 });
    try {
      const summary = (await (await fetch(`http://127.0.0.1:${running.port}/api/summary`)).json()) as { repos: Array<{ chain: { ok: boolean; brokenAt: number } }> };
      expect(summary.repos[0]?.chain.ok).toBe(false);
      const page = await fetch(`http://127.0.0.1:${running.port}/`);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await page.text()).toContain("BROKEN");
      expect((await fetch(`http://127.0.0.1:${running.port}/api/summary`, { method: "POST" })).status).toBe(405);
    } finally {
      await running.close();
    }
  });
});
