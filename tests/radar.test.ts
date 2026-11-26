import { afterEach, describe, expect, it } from "vitest";

import { loadState, noteWaiver, saveState } from "../src/engine/circuit-breaker.js";
import { appendRadar, queryRadar } from "../src/engine/radar-memory.js";
import { proposeWrite } from "../src/engine/runway-gate.js";
import { bannedImportSource, makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeProject(root);
});

describe("radar", () => {
  it("round-trips a rejection and an explicit decision", () => {
    const root = makeProject();
    roots.push(root);
    const rejected = proposeWrite({ root, path: "src/api.ts", content: bannedImportSource });
    expect(rejected.cleared).toBe(false);

    const state = noteWaiver(loadState(root), "Human waived the breaker after reviewing the import.");
    saveState(root, state);
    appendRadar(root, {
      source: "ctc_log_decision",
      decision: "waived",
      gate: "circuit",
      path: "src/api.ts",
      summary: "Human waived the breaker after reviewing the import.",
      strikes: 0,
      circuitOpen: false,
      violations: [],
    });

    const all = queryRadar(root, { limit: 10 });
    expect(all.map((entry) => entry.decision)).toEqual(["waived", "rejected"]);
    expect(all[1]?.path).toBe("src/api.ts");
    expect(all[1]?.violations.some((item) => item.code === "BANNED_IMPORT")).toBe(true);

    const filtered = queryRadar(root, { path: "src/api.ts", decision: "rejected" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.gate).toBe("ast");
    expect(filtered[0]?.source).toBe("ctc_propose_write");
  });
});
