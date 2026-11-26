import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { proposeWrite } from "../src/engine/runway-gate.js";
import { cleanSource, makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

describe("cleared writes", () => {
  it("lands a passing file on disk, including new parent directories", () => {
    const root = makeProject();
    roots.push(root);
    const content = "export const created = 1;\n";
    const result = proposeWrite({
      root,
      path: "src/nested/created.ts",
      content,
      rationale: "Add the flag the milestone asked for.",
    });
    expect(result).toMatchObject({
      protocol: "ctc.cleared.v1",
      cleared: true,
      written: true,
      gate: "none",
      file: "src/nested/created.ts",
      strikes: 0,
      circuit: "closed",
      violations: [],
      selfCorrection: null,
      bytesWritten: Buffer.byteLength(content, "utf8"),
    });
    expect(fs.readFileSync(path.join(root, "src", "nested", "created.ts"), "utf8")).toBe(content);
  });

  it("grounds a path that escapes the project root", () => {
    const root = makeProject();
    roots.push(root);
    const outside = path.join(root, "..", `ctc-escape-${path.basename(root)}.ts`);
    const result = proposeWrite({ root, path: "../secret.ts", content: cleanSource });
    expect(result.cleared).toBe(false);
    expect(result.violations.some((item) => item.code === "PATH_ESCAPE")).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("clears a non-script file that is inside scope", () => {
    const root = makeProject();
    roots.push(root);
    const content = "# Notes\n\nStill inside the milestone.\n";
    const result = proposeWrite({ root, path: "src/notes.md", content });
    expect(result.cleared).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "notes.md"), "utf8")).toBe(content);
  });
});
