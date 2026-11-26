import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config/schema.js";
import { buildProgram } from "../src/index.js";
import { makeProject, removeProject } from "./helpers.js";

describe("example config and init", () => {
  it("parses ctc.config.example.json", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ctc.config.example.json");
    const config = normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    expect(config.version).toBe(1);
    expect(config.activeMilestone.id).toBe("payments-v1");
    expect(config.activeMilestone.status).toBe("active");
    expect(config.activeMilestone.allowedPaths.length).toBeGreaterThan(0);
    expect(config.bannedImports[0]?.pattern).toBe("axios");
    expect(config.restrictedCalls[0]?.callPattern).toBe("eval");
    expect(config.circuitBreaker.maxStrikes).toBe(3);
  });

  it("writes a valid starter config", async () => {
    const root = makeProject();
    fs.rmSync(path.join(root, "ctc.config.json"));
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["--root", root, "init"], { from: "user" });
    const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(root, "ctc.config.json"), "utf8")) as unknown);
    expect(config.activeMilestone.id).toBe("foundation");
    expect(config.activeMilestone.status).toBe("active");
    expect(config.activeMilestone.allowedPaths).toEqual(["src/**", "tests/**"]);
    removeProject(root);
  });
});
