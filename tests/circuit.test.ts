import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fileStrikes, loadState, noteWaiver, saveState } from "../src/engine/circuit-breaker.js";
import { CIRCUIT_BREAKER_HEADER } from "../src/engine/payload.js";
import { proposeWrite } from "../src/engine/runway-gate.js";
import { bannedImportSource, cleanSource, makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

describe("circuit breaker", () => {
  it("opens after three rejections of the same file and stays open until a waiver", () => {
    const root = makeProject();
    roots.push(root);

    for (let strike = 1; strike <= 3; strike += 1) {
      const result = proposeWrite({ root, path: "src/bad.ts", content: bannedImportSource });
      expect(result.cleared).toBe(false);
      expect(result.strikes).toBe(strike);
      expect(result.circuit).toBe(strike === 3 ? "open" : "closed");
      if (strike === 3) expect(result.selfCorrection).toContain(CIRCUIT_BREAKER_HEADER);
    }

    expect(fs.existsSync(path.join(root, "src", "bad.ts"))).toBe(false);
    expect(fileStrikes(loadState(root), "src/bad.ts").circuitOpen).toBe(true);

    const stillBad = proposeWrite({ root, path: "src/bad.ts", content: bannedImportSource });
    expect(stillBad.circuit).toBe("open");
    expect(stillBad.strikes).toBe(3);
    expect(stillBad.selfCorrection).toContain(CIRCUIT_BREAKER_HEADER);
    expect(stillBad.violations.some((item) => item.code === "CIRCUIT_OPEN")).toBe(true);

    const blockedClean = proposeWrite({ root, path: "src/bad.ts", content: cleanSource });
    expect(blockedClean.cleared).toBe(false);
    expect(blockedClean.written).toBe(false);
    expect(blockedClean.selfCorrection).toContain(CIRCUIT_BREAKER_HEADER);
    expect(fs.existsSync(path.join(root, "src", "bad.ts"))).toBe(false);

    const other = proposeWrite({ root, path: "src/ok.ts", content: cleanSource });
    expect(other.cleared).toBe(true);
    expect(other.written).toBe(true);
    expect(fileStrikes(loadState(root), "src/bad.ts").circuitOpen).toBe(true);

    saveState(root, noteWaiver(loadState(root), "Human waived the breaker."));
    const afterWaiver = proposeWrite({ root, path: "src/bad.ts", content: cleanSource });
    expect(afterWaiver.cleared).toBe(true);
    expect(afterWaiver.written).toBe(true);
    expect(fileStrikes(loadState(root), "src/bad.ts")).toEqual({ consecutiveRejections: 0, circuitOpen: false });
  });

  it("resets a file when that same file lands before the breaker opens", () => {
    const root = makeProject();
    roots.push(root);
    expect(proposeWrite({ root, path: "src/bad.ts", content: bannedImportSource }).strikes).toBe(1);
    expect(proposeWrite({ root, path: "src/bad.ts", content: bannedImportSource }).strikes).toBe(2);
    const cleared = proposeWrite({ root, path: "src/bad.ts", content: cleanSource });
    expect(cleared.cleared).toBe(true);
    expect(fileStrikes(loadState(root), "src/bad.ts").consecutiveRejections).toBe(0);
    expect(fileStrikes(loadState(root), "src/bad.ts").circuitOpen).toBe(false);
  });

  it("keeps strike counts separate per file", () => {
    const root = makeProject();
    roots.push(root);
    expect(proposeWrite({ root, path: "src/a.ts", content: bannedImportSource }).strikes).toBe(1);
    expect(proposeWrite({ root, path: "src/a.ts", content: bannedImportSource }).strikes).toBe(2);
    expect(proposeWrite({ root, path: "src/b.ts", content: bannedImportSource }).strikes).toBe(1);
    const state = loadState(root);
    expect(fileStrikes(state, "src/a.ts")).toEqual({ consecutiveRejections: 2, circuitOpen: false });
    expect(fileStrikes(state, "src/b.ts")).toEqual({ consecutiveRejections: 1, circuitOpen: false });
  });
});
