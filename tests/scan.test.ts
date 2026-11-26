import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/load.js";
import { normalizeConfig } from "../src/config/schema.js";
import { loadFlightPlan } from "../src/engine/flight-plan.js";
import { scanProject, writeScan } from "../src/scanner/repo-scanner.js";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/sample-project");
const detectedFixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/detected-stack");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ctc scan", () => {
  it("builds a sensible config from the sample project", () => {
    const report = scanProject(fixture);
    expect(report.inventory.filesScanned).toBeGreaterThan(0);
    expect(report.inventory.lockfiles).toContain("package-lock.json");
    expect(report.inventory.sourceRoots).toEqual(["src"]);
    expect(report.inventory.undeclaredImports).toContain("left-pad");
    expect(report.inventory.undeclaredImports).not.toContain("react");
    expect(report.inventory.externalImports).toEqual(expect.arrayContaining(["react", "left-pad"]));

    const config = normalizeConfig(report.config);
    expect(config.activeMilestone.id).toBe("sample-project-foundation");
    expect(config.activeMilestone.allowedPaths).toContain("src/**");
    expect(config.lockedFiles).toContain("package-lock.json");
    expect(config.lockedFiles).toContain("dist/**");
    expect(config.bannedImports.map((item) => item.pattern)).toEqual(["left-pad"]);
    expect(config.bannedImports[0]?.useInstead).toContain("left-pad");
    expect(config.restrictedCalls.map((item) => item.callPattern)).toEqual(expect.arrayContaining(["eval", "Function"]));
    expect(config.degradation).toMatchObject({
      maxFunctionLength: 80,
      maxCyclomaticComplexity: 12,
      flagUnusedImports: true,
    });
    expect(report.flightPlan.paths).toContain("src/**");
    expect(report.flightPlan.milestone).toBe(config.activeMilestone.id);
  });

  it("writes the config and flight plan without touching the fixture", () => {
    const report = scanProject(fixture);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctc-scan-"));
    roots.push(root);
    const written = writeScan(root, report, { force: true });
    expect(fs.existsSync(written.configPath)).toBe(true);
    expect(loadConfig(root).activeMilestone.id).toBe("sample-project-foundation");
    expect(loadFlightPlan(root)?.paths).toContain("src/**");
    expect(fs.existsSync(path.join(fixture, "ctc.config.json"))).toBe(false);
  });

  it("locks detected schemas and stores and points raw fetch at the canonical hook", () => {
    const report = scanProject(detectedFixture);
    expect(report.detected.schemas).toEqual(expect.arrayContaining(["prisma/schema.prisma", "src/db/schema.ts"]));
    expect(report.detected.stateStores).toContain("src/stores/session.ts");
    expect(report.detected.apiClients).toEqual(expect.arrayContaining(["src/api/client.ts", "src/lib/trpc.ts"]));
    expect(report.detected.canonicalHook).toBe("src/hooks/useInvoices.ts");

    const config = report.config;
    for (const file of ["prisma/schema.prisma", "src/db/schema.ts", "src/stores/session.ts", "src/api/client.ts", "src/lib/trpc.ts"]) {
      expect(config.lockedFiles).toContain(file);
    }
    expect(config.lockedFiles).not.toContain("src/hooks/useInvoices.ts");

    const fetchRule = config.restrictedCalls.find((item) => item.callPattern === "fetch");
    expect(fetchRule?.inPaths).toEqual(["src/components/**"]);
    expect(fetchRule?.useInstead).toContain("useInvoices");
    expect(fetchRule?.useInstead).toContain("src/hooks/useInvoices.ts");

    const axiosRule = config.bannedImports.find((item) => item.pattern === "axios");
    expect(axiosRule?.useInstead).toContain("src/api/client.ts");
  });
});
