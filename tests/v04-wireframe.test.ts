import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyWrite } from "../src/gate/apply.js";
import { approveWireframe, saveWireframe, startWireframe } from "../src/wireframe/cli.js";
import { wireframeViolations } from "../src/wireframe/drift.js";
import { renderWireframeSvg } from "../src/wireframe/render.js";
import { WireframeSchema, isApproved, parseWireframe } from "../src/wireframe/schema.js";
import { parseYaml } from "../src/wireframe/yaml.js";
import { plan, repo } from "./v04-helpers.js";

process.env.CTC_ORG_POLICY = "/nonexistent/ctc-org-policy.json";

const FRAME = WireframeSchema.parse({
  name: "invoices",
  title: "Invoices",
  route: "/invoices",
  files: ["src/pages/Invoices.tsx"],
  regions: [
    { id: "header", area: [0, 0, 12, 1], components: [{ id: "title", type: "heading", label: "Invoices" }, { id: "new-invoice", type: "button", label: "New invoice" }] },
    { id: "main", area: [0, 1, 12, 6], components: [{ id: "invoice-table", type: "table", items: ["Number", "Customer", "Total"] }, { id: "export", type: "button", optional: true }] },
  ],
});

const PAGE = `export function Invoices() {
  return (
    <main>
      <header data-wf-region="header">
        <h1 data-wf="title">Invoices</h1>
        <button data-wf="new-invoice">New invoice</button>
      </header>
      <section data-wf-region="main">
        <table data-wf="invoice-table" />
      </section>
    </main>
  );
}
`;

describe("v0.4 item 11: wireframes in onboarding and design", () => {
  it("parses the YAML subset and JSON into the same spec, and renders a low-fi SVG", () => {
    const yaml = `name: invoices
title: Invoices
route: /invoices
files: [src/pages/Invoices.tsx]
regions:
  - id: header
    area: [0, 0, 12, 1]
    components:
      - id: title
        type: heading
        label: Invoices
      - id: new-invoice
        type: button
        label: "New invoice"
  - id: main
    area: [0, 1, 12, 6]
    components:
      - id: invoice-table
        type: table
        items: [Number, Customer, Total]
      - id: export
        type: button
        optional: true
`;
    expect(parseWireframe(yaml, "x.yaml")).toEqual(FRAME);
    expect((parseYaml("a: 1\nb:\n  - x\n  - y\n") as Record<string, unknown>).b).toEqual(["x", "y"]);
    const svg = renderWireframeSvg(FRAME);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('data-wf="new-invoice"');
    expect(svg).toContain("DRAFT");
  });

  it("blocks UI code before the wireframe is agreed, and approval is bound to the layout hash", () => {
    const root = repo({ "src/pages/Invoices.tsx": "export {};\n" });
    saveWireframe(root, FRAME);
    const held = applyWrite(root, { path: "src/pages/Invoices.tsx", content: PAGE, plan: plan() });
    expect(held.violations.map((item) => item.code)).toContain("WIREFRAME_NOT_APPROVED");
    const approved = approveWireframe(root, "invoices", "timothy");
    expect(isApproved(approved)).toBe(true);
    expect(fs.existsSync(path.join(root, ".ctc/wireframes/invoices.svg"))).toBe(true);
    const cleared = applyWrite(root, { path: "src/pages/Invoices.tsx", content: PAGE, plan: plan() });
    expect(cleared.violations.filter((item) => item.rule === "WireframeDrift")).toEqual([]);
    const file = path.join(root, ".ctc/wireframes/invoices.json");
    const edited = JSON.parse(fs.readFileSync(file, "utf8"));
    edited.regions[0].components.push({ id: "filter", type: "select" });
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(isApproved(WireframeSchema.parse(edited))).toBe(false);
  });

  it("flags extra, removed and mistyped components, extra regions and routes; missing ones warn", () => {
    const root = repo({});
    saveWireframe(root, FRAME);
    approveWireframe(root, "invoices", "t");
    const drift = PAGE.replace('<button data-wf="new-invoice">New invoice</button>', '<a data-wf="new-invoice" href="#">New</a>\n        <button data-wf="bulk-delete">Delete all</button>').replace('data-wf-region="main"', 'data-wf-region="sidebar"');
    const found = wireframeViolations(root, "src/pages/Invoices.tsx", PAGE, drift, null).map((item) => `${item.code}@${item.line}`);
    expect(found).toEqual(expect.arrayContaining(["WIREFRAME_TYPE_MISMATCH@6", "WIREFRAME_EXTRA_COMPONENT@7", "WIREFRAME_EXTRA_REGION@9"]));
    const removed = wireframeViolations(root, "src/pages/Invoices.tsx", PAGE, PAGE.replace('        <table data-wf="invoice-table" />\n', ""), null);
    expect(removed.map((item) => item.code)).toEqual(expect.arrayContaining(["WIREFRAME_COMPONENT_REMOVED", "WIREFRAME_INCOMPLETE"]));
    expect(removed.find((item) => item.code === "WIREFRAME_INCOMPLETE")?.severity).toBe("warn");
    const strict = wireframeViolations(root, "src/pages/Invoices.tsx", null, PAGE.replace('        <table data-wf="invoice-table" />\n', ""), plan({ uiComplete: true }));
    expect(strict.find((item) => item.code === "WIREFRAME_INCOMPLETE")?.severity).toBeUndefined();
    const router = `export const routes = [\n  { path: "/invoices", component: Invoices },\n  { path: "/admin", component: Admin },\n];\n`;
    const routes = wireframeViolations(root, "src/router.ts", `export const routes = [\n  { path: "/invoices", component: Invoices },\n];\n`, router, null);
    expect(routes.map((item) => `${item.code}@${item.line}`)).toEqual(["WIREFRAME_EXTRA_ROUTE@3"]);
  });

  it("init --wireframe starts a draft layout plus SVG", () => {
    const root = repo({});
    const written = startWireframe(root, "settings", { route: "/settings" });
    expect(JSON.parse(fs.readFileSync(written.json, "utf8")).status).toBe("draft");
    expect(fs.readFileSync(written.svg, "utf8")).toContain("<svg");
  });
});
