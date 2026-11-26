import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { clearGateProjectsForTests } from "../src/gate/overlay.js";
import { createMcpServer } from "../src/mcp/server.js";
import { setMemoryAdapterForTests } from "../src/memory/sync.js";
import { GroundCrewHandoffSchema } from "../src/schemas/radar.js";
import { buildProgram } from "../src/index.js";
import { makeProject, removeProject } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  setMemoryAdapterForTests(null);
  for (const root of roots.splice(0)) {
    clearGateProjectsForTests(root);
    removeProject(root);
  }
});

async function connect(root: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(root, "0.1.0");
  await server.connect(serverTransport);
  const client = new Client({ name: "ctc-phase3", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content.find((item) => item.type === "text");
  const text = block && "text" in block ? block.text : "";
  return { isError: result.isError === true, body: JSON.parse(text ?? "{}") as Record<string, unknown> };
}

const currency = `export function formatCentsToUsd(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return dollars;
}
`;

const currencyCopy = `export function renderMoney(amountInCents: number): string {
  const val = (amountInCents / 100).toFixed(2);
  return val;
}
`;

async function planFor(client: Client, root: string, extra: Record<string, unknown> = {}): Promise<void> {
  const onboarded = await call(client, "ctc_onboard_idea", {
    projectRoot: root,
    projectName: "payments",
    rawIdea: "Charge and refund cards.",
    globalBannedPackages: ["pg"],
    boundaries: [{ sourcePattern: "src/components/**", forbiddenImports: ["src/db", "pg"] }],
    tasks: [
      {
        taskId: "work",
        targetFiles: ["src/**"],
        acceptanceCriteria: ["land the change"],
        summary: "Active slice",
      },
    ],
    ...extra,
  });
  expect(onboarded.body.persisted).toBe(true);
  const promoted = await call(client, "ctc_promote_task_to_flight_plan", { projectRoot: root, taskId: "work", sessionId: "spec" });
  expect(promoted.body.cleared).toBe(true);
}

describe("blueprint flow", () => {
  it("asks for tasks when the idea has none, then gates a write until the file passes and can be marked DONE", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    const empty = await call(client, "ctc_onboard_idea", { projectRoot: root, rawIdea: "Add card charges." });
    expect(empty.body.persisted).toBe(false);
    expect(Array.isArray(empty.body.questions)).toBe(true);
    expect(fs.existsSync(path.join(root, ".ctc", "blueprint.json"))).toBe(false);

    const onboarded = await call(client, "ctc_onboard_idea", {
      projectRoot: root,
      projectName: "payments",
      rawIdea: "Add card charges and refunds.",
      architectureSummary: "One charge module and one refund module.",
      components: [{ name: "Charge", responsibility: "Capture cents.", files: ["src/payments/charge.ts"] }],
      globalInvariants: ["Money is integer cents."],
      globalBannedPackages: ["pg"],
      tasks: [
        { taskId: "charge", summary: "Capture a charge", targetFiles: ["src/payments/charge.ts"], acceptanceCriteria: ["export charge"] },
        { taskId: "refund", summary: "Refund a charge", targetFiles: ["src/payments/refund.ts"], dependsOn: ["charge"], acceptanceCriteria: ["export refund"] },
      ],
    });
    expect(onboarded.body.persisted).toBe(true);

    const early = await call(client, "ctc_promote_task_to_flight_plan", { projectRoot: root, taskId: "refund" });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early.body.errors)).toContain("charge");

    const promoted = await call(client, "ctc_promote_task_to_flight_plan", { projectRoot: root, taskId: "charge", sessionId: "flow" });
    expect(promoted.body.cleared).toBe(true);
    const plan = promoted.body.plan as { allowedFileGlobs: string[] };
    expect(plan.allowedFileGlobs).toEqual(["src/payments/charge.ts"]);

    const gated = await call(client, "ctc_write_file", {
      projectRoot: root,
      sessionId: "flow",
      path: "src/payments/charge.ts",
      content: 'import pg from "pg";\nexport const client = pg;\n',
    });
    expect(gated.isError).toBe(true);
    expect(JSON.stringify(gated.body.violations)).toContain("BoundaryCheckRule");
    expect(fs.existsSync(path.join(root, "src", "payments", "charge.ts"))).toBe(false);

    const blocked = await call(client, "ctc_update_task", { projectRoot: root, taskId: "charge", status: "DONE" });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.body.violations)).toContain("TARGET_MISSING");

    const fixed = await call(client, "ctc_write_file", {
      projectRoot: root,
      sessionId: "flow",
      path: "src/payments/charge.ts",
      content: "export const charge = (cents: number): number => cents;\n",
    });
    expect(fixed.body).toMatchObject({ cleared: true, written: true });

    const done = await call(client, "ctc_update_task", { projectRoot: root, taskId: "charge", status: "DONE" });
    expect(done.body).toMatchObject({ cleared: true, status: "DONE", verifiedByGate: true });

    const next = await call(client, "ctc_promote_task_to_flight_plan", { projectRoot: root, taskId: "refund", sessionId: "flow" });
    expect(next.body.cleared).toBe(true);
    await close();
  });

  it("rejects a dependency cycle and does not persist it", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    const result = await call(client, "ctc_onboard_idea", {
      projectRoot: root,
      rawIdea: "Cycle",
      tasks: [
        { taskId: "a", targetFiles: ["src/a.ts"], dependsOn: ["b"] },
        { taskId: "b", targetFiles: ["src/b.ts"], dependsOn: ["a"] },
      ],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.body.errors)).toContain("cycle");
    expect(fs.existsSync(path.join(root, ".ctc", "blueprint.json"))).toBe(false);
    await close();
  });
});

describe("runway gate rules", () => {
  it("blocks an out-of-scope write, a broken canary, and a literal patch", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await call(client, "ctc_onboard_idea", {
      projectRoot: root,
      rawIdea: "Payments only",
      tasks: [{ taskId: "pay", targetFiles: ["src/payments/**"], acceptanceCriteria: ["keep the marker"] }],
    });
    const promoted = await call(client, "ctc_promote_task_to_flight_plan", {
      projectRoot: root,
      taskId: "pay",
      canaries: [{ id: "marker", description: "marker stays", targetFileGlob: "src/payments/**", requiredPattern: "KEEP_ME" }],
    });
    expect(promoted.body.cleared).toBe(true);

    const outside = await call(client, "ctc_write_file", { projectRoot: root, path: "src/other.ts", content: "export const other = 1;\n" });
    expect(JSON.stringify(outside.body.violations)).toContain("FlightPlanScope");

    const missing = await call(client, "ctc_write_file", { projectRoot: root, path: "src/payments/charge.ts", content: "export const charge = 1;\n" });
    expect(JSON.stringify(missing.body.violations)).toContain("CanaryAssertion");

    const landed = await call(client, "ctc_write_file", {
      projectRoot: root,
      path: "src/payments/charge.ts",
      content: "export const charge = 1; // KEEP_ME\n",
    });
    expect(landed.body.cleared).toBe(true);

    const patched = await call(client, "ctc_patch_file", {
      projectRoot: root,
      path: "src/payments/charge.ts",
      hunks: [{ search: "1", replace: '"$1"' }],
    });
    expect(patched.body.cleared).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "payments", "charge.ts"), "utf8")).toContain('"$1"');

    const twice = await call(client, "ctc_write_file", {
      projectRoot: root,
      path: "src/payments/twice.ts",
      content: "export const left = 1;\nexport const right = 1; // KEEP_ME\n",
    });
    expect(twice.body.cleared).toBe(true);
    const ambiguous = await call(client, "ctc_patch_file", {
      projectRoot: root,
      path: "src/payments/twice.ts",
      hunks: [{ search: " = 1", replace: " = 2" }],
    });
    expect(JSON.stringify(ambiguous.body.violations)).toContain("PATCH_AMBIGUOUS");
    await close();
  });

  it("blocks a renamed duplicate of a src/utils export", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    const original = await call(client, "ctc_write_file", { projectRoot: root, path: "src/utils/currency.ts", content: currency });
    expect(original.body.cleared).toBe(true);
    const copy = await call(client, "ctc_write_file", { projectRoot: root, path: "src/app/money.ts", content: currencyCopy });
    const duplicateViolations = copy.body.violations as Array<{ rule: string; fix: string }>;
    expect(duplicateViolations.some((item) => item.rule === "DuplicateLogicRule")).toBe(true);
    expect(duplicateViolations.some((item) => item.fix.includes('import { formatCentsToUsd } from "src/utils/currency.ts"'))).toBe(true);
    await close();
  });

  it("blocks a new unused binding and leaves the previous file untouched", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    const legacy = "export const used = 1;\nconst legacy = 1;\n";
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "legacy.ts"), legacy);
    const same = await call(client, "ctc_write_file", { projectRoot: root, path: "src/legacy.ts", content: legacy });
    expect(same.body.cleared).toBe(true);
    const fresh = await call(client, "ctc_write_file", { projectRoot: root, path: "src/legacy.ts", content: `${legacy}const fresh = 2;\n` });
    const messages = (fresh.body.violations as Array<{ message: string }>).map((item) => item.message);
    expect(messages.some((message) => message.includes("Dead code regression") && message.includes("fresh"))).toBe(true);
    expect(messages.some((message) => message.includes("'legacy'"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "src", "legacy.ts"), "utf8")).toBe(legacy);
    await close();
  });

  it("blocks long functions, high complexity, and naming drift", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    const comments = Array.from({ length: 40 }, () => "  // pad").join("\n");
    const tall = `export function tall(n: number): number {\n  let total = n;\n${comments}\n  return total;\n}\n`;
    const long = await call(client, "ctc_write_file", { projectRoot: root, path: "src/tall.ts", content: tall });
    expect(JSON.stringify(long.body.violations)).toContain("LongMethodRule");
    expect(JSON.stringify(long.body.violations)).toContain("FUNCTION_TOO_LONG");

    const messy = `export function messy(n: number): number {
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  if (n === 4) return 4;
  if (n === 5) return 5;
  if (n === 6) return 6;
  if (n === 7) return 7;
  if (n === 8) return 8;
  if (n === 9) return 9;
  if (n === 10) return 10;
  if (n === 11) return 11;
  return n;
}
`;
    const complex = await call(client, "ctc_write_file", { projectRoot: root, path: "src/messy.ts", content: messy });
    expect(JSON.stringify(complex.body.violations)).toContain("COMPLEXITY");

    const named = await call(client, "ctc_write_file", { projectRoot: root, path: "src/names.ts", content: "export function Bad_Name(): number { return 1; }\n" });
    expect(JSON.stringify(named.body.violations)).toContain("NamingDriftRule");
    await close();
  });

  it("blocks banned packages and resolved relative imports, and ignores lookalike package names", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    const content = `import pg from "pg";
import postgres from "postgres";
import pool from "pg-pool";
import { db } from "../../db/client";
export const view = { pg, postgres, pool, db };
`;
    const result = await call(client, "ctc_write_file", { projectRoot: root, path: "src/components/pages/Dashboard.ts", content });
    const messages = JSON.stringify(result.body.violations);
    expect(messages).toContain("BoundaryCheckRule");
    expect(messages).toContain("pg");
    expect(messages).toContain("../../db/client");
    expect(messages).not.toContain("postgres");
    expect(messages).not.toContain("pg-pool");
    await close();
  });

  it("reports phantom properties, missing names, and arity mismatches, then rolls the overlay back", async () => {
    const root = makeProject();
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, skipLibCheck: true }, include: ["src"] }, null, 2)}\n`,
    );
    const { client, close } = await connect(root);
    await planFor(client, root);
    const types = "export interface Invoice { id: string; totalCents: number }\n";
    const typesWrite = await call(client, "ctc_write_file", { projectRoot: root, path: "src/types.ts", content: types });
    expect(typesWrite.body.cleared).toBe(true);
    const good = 'import type { Invoice } from "./types";\nexport function bill(invoice: Invoice): number { return invoice.totalCents; }\n';
    const goodWrite = await call(client, "ctc_write_file", { projectRoot: root, path: "src/bill.ts", content: good });
    expect(goodWrite.body.cleared).toBe(true);
    const bad = 'import type { Invoice } from "./types";\nexport function bill(invoice: Invoice): number { return invoice.amountDue; }\n';
    const property = await call(client, "ctc_write_file", { projectRoot: root, path: "src/bill.ts", content: bad });
    expect(JSON.stringify(property.body.violations)).toContain("PhantomSymbolRule");
    expect(JSON.stringify(property.body.violations)).toContain("2339");
    expect(fs.readFileSync(path.join(root, "src", "bill.ts"), "utf8")).toBe(good);

    const missing = await call(client, "ctc_write_file", { projectRoot: root, path: "src/missing.ts", content: "export const value = missingSymbol;\n" });
    expect(JSON.stringify(missing.body.violations)).toContain("2304");

    const arity = await call(client, "ctc_write_file", {
      projectRoot: root,
      path: "src/arity.ts",
      content: "export function add(left: number, right: number): number { return left + right; }\nexport function caller(): number { return add(1); }\n",
    });
    expect(JSON.stringify(arity.body.violations)).toContain("2554");
    await close();
  }, 20000);
});

describe("read radar and handoff", () => {
  it("moves from GREEN to YELLOW to a RED lock, writes the handoff, and unlocks", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const body = "export function longOne(value: number): number {\n  const doubled = value + value;\n  return doubled;\n}\n";
    fs.writeFileSync(path.join(root, "src", "blob.ts"), body);

    const first = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s1" });
    expect(first.body.zone).toBe("GREEN");
    expect(first.body.distilled).toBe(false);
    expect(String(first.body.content)).toContain("return doubled");

    const second = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s1" });
    expect(second.body.zone).toBe("YELLOW");
    expect(second.body.distilled).toBe(true);
    expect(String(second.body.content)).toContain("body elided");
    expect(String(second.body.content)).not.toContain("const doubled");

    const third = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s1" });
    expect(third.isError).toBe(true);
    expect(third.body.zone).toBe("RED");
    expect(third.body.locked).toBe(true);
    expect(String(third.body.bootstrapPrompt)).toContain("GROUND CREW HANDOFF");

    const state = JSON.parse(fs.readFileSync(path.join(root, ".ctc", "state.json"), "utf8")) as { files?: unknown; pendingFiles?: string[] };
    const handoff = GroundCrewHandoffSchema.parse(state);
    expect(handoff.triggerReason).toBe("RED_ZONE_LOCK");
    expect(handoff.pendingFiles).toContain("src/blob.ts");
    expect(handoff.pendingFiles.some((file) => file.includes("*"))).toBe(false);
    expect(state.files).toBeTypeOf("object");

    const held = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s1" });
    expect(held.body.locked).toBe(true);

    const resumed = await call(client, "ctc_read_file", { projectRoot: root, path: ".ctc/state.json", sessionId: "s1" });
    expect(resumed.body.unlocked).toBe(true);
    const again = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s1" });
    expect(again.body.zone).toBe("GREEN");

    await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s2" });
    await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s2" });
    const locked = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s2" });
    expect(locked.body.locked).toBe(true);
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["--root", root, "reset"], { from: "user" });
    const afterReset = await call(client, "ctc_read_file", { projectRoot: root, path: "src/blob.ts", sessionId: "s2" });
    expect(afterReset.body.locked).toBe(false);
    expect(afterReset.body.zone).toBe("GREEN");
    await close();
  });

  it("locks after three gate failures and lets a new session through", async () => {
    const root = makeProject();
    roots.push(root);
    const { client, close } = await connect(root);
    await planFor(client, root);
    const bad = "export function Bad_Name(): number { return 1; }\n";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await call(client, "ctc_write_file", { projectRoot: root, sessionId: "gate", path: "src/names.ts", content: bad });
      expect(result.isError).toBe(true);
    }
    const state = GroundCrewHandoffSchema.parse(JSON.parse(fs.readFileSync(path.join(root, ".ctc", "state.json"), "utf8")) as unknown);
    expect(state.triggerReason).toBe("CONSECUTIVE_GATE_FAILURES");
    expect(state.unresolvedViolations.some((line) => line.includes("NAMING_DRIFT"))).toBe(true);

    const blocked = await call(client, "ctc_write_file", {
      projectRoot: root,
      sessionId: "gate",
      path: "src/names.ts",
      content: "export function goodName(): number { return 1; }\n",
    });
    expect(blocked.body.locked).toBe(true);
    expect(blocked.body.written).toBe(false);

    const fresh = await call(client, "ctc_write_file", {
      projectRoot: root,
      sessionId: "fresh",
      path: "src/names.ts",
      content: "export function goodName(): number { return 1; }\n",
    });
    expect(fresh.body.cleared).toBe(true);
    await close();
  });
});

describe("unimatrix onboarding", () => {
  it("stores the blueprint and still persists when the adapter throws", async () => {
    const stored: string[] = [];
    setMemoryAdapterForTests({
      store(input) {
        stored.push(input.content);
      },
      search() {
        return [];
      },
      recall() {
        return [];
      },
      getContext() {
        return [];
      },
      feedback() {
        return undefined;
      },
    });
    const root = makeProject({
      version: 1,
      activeMilestone: { id: "foundation", title: "Foundation", allowedPaths: ["src/**"], status: "active" },
      unimatrix: { enabled: true },
    });
    roots.push(root);
    const { client, close } = await connect(root);
    const onboarded = await call(client, "ctc_onboard_idea", {
      projectRoot: root,
      rawIdea: "Remember this blueprint.",
      tasks: [{ taskId: "one", targetFiles: ["src/one.ts"], acceptanceCriteria: ["land it"] }],
    });
    expect(onboarded.body.persisted).toBe(true);
    expect(stored.some((item) => item.includes("Remember this blueprint."))).toBe(true);
    await close();

    setMemoryAdapterForTests({
      store() {
        throw new Error("down");
      },
      search() {
        throw new Error("down");
      },
      recall() {
        throw new Error("down");
      },
      getContext() {
        throw new Error("down");
      },
      feedback() {
        throw new Error("down");
      },
    });
    const { client: client2, close: close2 } = await connect(root);
    const again = await call(client2, "ctc_onboard_idea", {
      projectRoot: root,
      rawIdea: "Still local.",
      tasks: [{ taskId: "two", targetFiles: ["src/two.ts"], acceptanceCriteria: ["land it"] }],
    });
    expect(again.body.persisted).toBe(true);
    await close2();
  });
});
