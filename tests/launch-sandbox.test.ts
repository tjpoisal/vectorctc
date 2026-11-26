import { afterEach, describe, expect, it } from "vitest";

import { encodeArgs, runSandbox } from "../src/behavior/sandbox.js";

// Code under test is agent-written and untrusted: it must not reach the host realm, the network or module loading.
const code = `
function viaGlobal() { try { return this.constructor.constructor("return typeof process")(); } catch (e) { return "blocked"; } }
function viaExports() { try { return exports.constructor.constructor("return typeof process")(); } catch (e) { return "blocked"; } }
function viaRequire() { try { const n = require("node:net"); return String(n.isIP("1.2.3.4")) === "4" ? "function" : "blocked"; } catch (e) { return "blocked"; } }
function viaFetch() { try { return exports.constructor.constructor("return typeof fetch")(); } catch (e) { return "blocked"; } }
function viaInputs(xs) { try { return xs.constructor.constructor("return typeof process")(); } catch (e) { return "blocked"; } }
`;
const names = ["viaGlobal", "viaExports", "viaRequire", "viaFetch", "viaInputs"];

describe("behaviour sandbox isolation", () => {
  afterEach(() => {
    delete process.env.CTC_BEHAVIOR_PERSISTENT;
  });
  for (const persistent of [true, false]) {
    it(`blocks host-realm escapes, require and fetch (${persistent ? "long-lived child" : "one-shot child"})`, () => {
      if (!persistent) process.env.CTC_BEHAVIOR_PERSISTENT = "0";
      const result = runSandbox([{ code, names }], names.map((name) => ({ module: 0, ref: [name], inputs: [encodeArgs([[1, 2]])] })));
      expect(result.ok).toBe(true);
      for (const job of result.outputs) {
        const value = JSON.parse(job![0]![0]) as string;
        expect(["undefined", "blocked", "object"]).toContain(value);
        expect(value).not.toBe("function");
      }
    });
  }
});

import { selfCommand } from "../src/universal/self-command.js";

describe("command written into agent configs", () => {
  it("never bakes in the npx cache path, and honours CTC_COMMAND", () => {
    expect(selfCommand("/home/u/.npm/_npx/abc123/node_modules/vectorctc/dist/index.js", "0.4.0", {})).toEqual(["npx", "-y", "vectorctc@0.4.0"]);
    expect(selfCommand("/opt/ctc/dist/index.js", "0.4.0", {})).toEqual([process.execPath, "/opt/ctc/dist/index.js"]);
    expect(selfCommand("/opt/ctc/dist/index.js", "0.4.0", { CTC_COMMAND: "pnpm exec ctc" })).toEqual(["pnpm", "exec", "ctc"]);
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGatedAgent } from "../src/universal/agents-gated.js";

describe("installed entry points", () => {
  const dist = path.resolve("dist/index.js");
  it.skipIf(!fs.existsSync(dist))("runs the CLI through a symlinked bin (how npm and npx install it)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-bin-"));
    const link = path.join(dir, "ctc");
    fs.symlinkSync(dist, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("gated MCP entries for cursor, claude and copilot start `serve`", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-gated-"));
    for (const agent of ["cursor", "claude", "copilot"]) installGatedAgent(root, agent, ["/usr/bin/node", "/x/dist/index.js"], false);
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    expect(read(".cursor/mcp.json").mcpServers["code-traffic-control"].args).toEqual(["/x/dist/index.js", "serve"]);
    expect(read(".mcp.json").mcpServers["code-traffic-control"].args).toEqual(["/x/dist/index.js", "serve"]);
    expect(read(".vscode/mcp.json").servers["code-traffic-control"].args).toEqual(["/x/dist/index.js", "serve"]);
    expect(read(".cursor/hooks.json").hooks.preToolUse[0].command).toBe("/usr/bin/node /x/dist/index.js hook --cursor");
  });
});

import { guardFiles } from "../src/universal/git-hooks.js";

describe("git hooks and scope", () => {
  it.skipIf(!fs.existsSync(path.resolve("dist/index.js")))("do not hold package.json or config files outside the milestone paths unless --scope is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-scope-"));
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    run(["init", "-q"]);
    execFileSync(process.execPath, [path.resolve("dist/index.js"), "init", "--root", root], { encoding: "utf8" });
    const config = JSON.parse(fs.readFileSync(path.join(root, "ctc.config.json"), "utf8"));
    config.rules.naming.enabled = true;
    fs.writeFileSync(path.join(root, "ctc.config.json"), JSON.stringify(config));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"x\"}\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export function Bad_Name(a: number): number {\n  return a;\n}\n");
    run(["add", "-A"]);
    const plain = guardFiles(root, ["package.json", "ctc.config.json", "src/a.ts"]);
    expect(plain.holds.map((h) => h.file)).toEqual(["src/a.ts"]);
    const scoped = guardFiles(root, ["package.json", "ctc.config.json", "src/a.ts"], { scope: true });
    expect(scoped.holds.map((h) => h.file)).toEqual(expect.arrayContaining(["package.json", "src/a.ts"]));
  });
});
