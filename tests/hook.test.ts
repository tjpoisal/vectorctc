import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateHook } from "../src/hook.js";
import { fileStrikes, loadState } from "../src/engine/circuit-breaker.js";
import { cleanSource, makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

describe("PreToolUse hook", () => {
  it("denies a Write that imports a banned module and does not create the file", () => {
    const root = makeProject();
    roots.push(root);
    const outcome = evaluateHook({
      hook_event_name: "PreToolUse",
      cwd: root,
      tool_name: "Write",
      tool_input: {
        file_path: path.join(root, "src", "api.ts"),
        content: 'import axios from "axios";\nexport const client = axios;\n',
      },
    });
    expect(outcome.permission).toBe("deny");
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toContain("BANNED_IMPORT");
    expect(fs.existsSync(path.join(root, "src", "api.ts"))).toBe(false);
    expect(fileStrikes(loadState(root), "src/api.ts").consecutiveRejections).toBe(1);
  });

  it("allows a clean Write without landing the file itself", () => {
    const root = makeProject();
    roots.push(root);
    const outcome = evaluateHook({
      hook_event_name: "PreToolUse",
      cwd: root,
      tool_name: "Write",
      tool_input: { file_path: "src/ok.ts", content: cleanSource },
    });
    expect(outcome.permission).toBe("allow");
    expect(outcome.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, "src", "ok.ts"))).toBe(false);
    expect(fileStrikes(loadState(root), "src/ok.ts").consecutiveRejections).toBe(0);
  });

  it("denies an Edit that introduces a restricted call and leaves the file unchanged", () => {
    const root = makeProject();
    roots.push(root);
    const file = path.join(root, "src", "run.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = "export function run(input: string): string {\n  return input;\n}\n";
    fs.writeFileSync(file, original);
    const outcome = evaluateHook({
      hook_event_name: "PreToolUse",
      cwd: root,
      tool_name: "Edit",
      tool_input: {
        file_path: file,
        old_string: "  return input;",
        new_string: "  return eval(input);",
      },
    });
    expect(outcome.permission).toBe("deny");
    expect(outcome.payload?.violations.some((item) => item.code === "RESTRICTED_CALL" && item.line === 2)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("ignores tools that do not write files", () => {
    const outcome = evaluateHook({ tool_name: "Read", tool_input: { file_path: "src/ok.ts" } });
    expect(outcome).toMatchObject({ permission: "allow", exitCode: 0 });
  });
});
