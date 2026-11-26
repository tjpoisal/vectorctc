import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { applyWrite } from "../src/gate/apply.js";
import { crossRepoViolations, exportsOf } from "../src/crossrepo/impact.js";
import { intentViolations, parseTicket, ticketCoverage } from "../src/intent/intent.js";
import { ensureGrammar } from "../src/lang/treesitter.js";
import { effectivePolicy } from "../src/policy/policy.js";
import { plan, repo } from "./v04-helpers.js";

process.env.CTC_ORG_POLICY = "/nonexistent/ctc-org-policy.json";
process.env.CTC_FINDINGS_LOG = "off";

const MONEY = `export function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toFixed(2) + " " + currency;
}

export function parseMoney(text: string): number {
  return Math.round(Number.parseFloat(text) * 100);
}
`;

function input(root: string, relativePath: string, before: string | null, after: string, extra = {}) {
  return { root, relativePath, before, after, plan: plan({ allowedFileGlobs: ["**"], ...extra }), policy: effectivePolicy(root, relativePath) };
}

describe("cross-repo impact", () => {
  beforeAll(async () => {
    await ensureGrammar("go");
    await ensureGrammar("python");
  });

  function workspace(): { shared: string; web: string } {
    const shared = repo({ "package.json": JSON.stringify({ name: "@acme/shared" }), "src/money.ts": MONEY, ".ctc/policy.json": JSON.stringify({ crossRepo: { siblings: [{ name: "web", path: "../web" }, { name: "gone", path: "../does-not-exist" }] } }) });
    const web = path.join(path.dirname(shared), "web");
    fs.mkdirSync(path.join(web, "src"), { recursive: true });
    fs.writeFileSync(path.join(web, "src/cart.ts"), `import { formatMoney } from "@acme/shared";\n\nexport const label = (c: number) => formatMoney(c, "USD");\n`);
    fs.writeFileSync(path.join(web, "src/unrelated.ts"), `import { formatMoney } from "./local";\n`);
    fs.renameSync(shared, path.join(path.dirname(shared), "shared"));
    const moved = path.join(path.dirname(shared), "shared");
    return { shared: moved, web };
  }

  it("reads exports and required arity per language", () => {
    expect([...exportsOf("ts", MONEY).values()].map((item) => `${item.name}/${item.arity}`)).toEqual(["formatMoney/2", "parseMoney/1"]);
    expect([...exportsOf("python", "def pay(a, b=1):\n    return a\n\n\ndef _hidden():\n    pass\n").values()].map((item) => `${item.name}/${item.arity}`)).toEqual(["pay/1"]);
    expect([...exportsOf("go", "package m\n\nfunc Pay(a int, b int) int { return a }\nfunc hidden() {}\n").values()].map((item) => `${item.name}/${item.arity}`)).toEqual(["Pay/2"]);
  });

  it("holds removing an export a sibling uses, warns on arity changes and missing siblings", () => {
    const { shared, web } = workspace();
    try {
      const removed = MONEY.replace(/export function formatMoney[\s\S]*?\n}\n\n/, "");
      const found = crossRepoViolations(input(shared, "src/money.ts", MONEY, removed));
      expect(found.map((item) => item.code).sort()).toEqual(["CROSS_REPO_BREAK", "CROSS_REPO_SIBLING_MISSING"]);
      const breakItem = found.find((item) => item.code === "CROSS_REPO_BREAK");
      expect(breakItem?.message).toContain("web/src/cart.ts:3");
      expect(breakItem?.message).not.toContain("unrelated.ts");
      const arity = crossRepoViolations(input(shared, "src/money.ts", MONEY, MONEY.replace("currency: string)", "currency: string, locale: string)")));
      expect(arity.find((item) => item.code === "CROSS_REPO_SIGNATURE")?.severity).toBe("warn");
      // Removing an export nobody uses is fine.
      expect(crossRepoViolations(input(shared, "src/money.ts", MONEY, MONEY.replace(/export function parseMoney[\s\S]*$/, ""))).map((item) => item.code)).toEqual(["CROSS_REPO_SIBLING_MISSING"]);
      // Through the full gate: blocks.
      const result = applyWrite(shared, { path: "src/money.ts", content: removed, plan: plan() });
      expect(result.written).toBe(false);
      expect(result.violations.map((item) => item.code)).toContain("CROSS_REPO_BREAK");
    } finally {
      fs.rmSync(shared, { recursive: true, force: true });
      fs.rmSync(web, { recursive: true, force: true });
    }
  });

  it("finds Go consumers by module path and alias", () => {
    const lib = repo({ "go.mod": "module example.com/lib\n\ngo 1.22\n", "money/money.go": "package money\n\nfunc Format(c int) string { return \"\" }\n", ".ctc/policy.json": JSON.stringify({ crossRepo: { siblings: [{ name: "api", path: "../api-go" }] } }) }, { tsconfig: false });
    const api = path.join(path.dirname(lib), "api-go");
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(path.join(api, "main.go"), `package main\n\nimport m "example.com/lib/money"\n\nfunc main() { _ = m.Format(1) }\n`);
    try {
      const found = crossRepoViolations(input(lib, "money/money.go", "package money\n\nfunc Format(c int) string { return \"\" }\n", "package money\n\nfunc FormatCents(c int) string { return \"\" }\n"));
      expect(found.map((item) => item.code)).toEqual(["CROSS_REPO_BREAK"]);
      expect(found[0]?.message).toContain("api/main.go:5");
    } finally {
      fs.rmSync(api, { recursive: true, force: true });
    }
  });
});

describe("intent check", () => {
  const TICKET = `Add a currency label to the invoice total.

Acceptance criteria:
- [ ] invoiceTotal returns the currency label
- [ ] The invoice page renders a badge

Out of scope:
- src/billing/
- \`chargeCustomer\`
`;

  it("parses out-of-scope paths and identifiers, criteria and terms", () => {
    const parsed = parseTicket(TICKET);
    expect(parsed.outOfScope.paths).toEqual(["src/billing/"]);
    expect(parsed.outOfScope.identifiers).toEqual(["chargeCustomer"]);
    expect(parsed.criteria.map((item) => item.text)).toEqual(["invoiceTotal returns the currency label", "The invoice page renders a badge"]);
    expect(parsed.terms.has("invoice")).toBe(true);
  });

  it("blocks out-of-scope paths and identifiers, warns on unrelated changes", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const path1 = intentViolations(input(root, "src/billing/charge.ts", null, "export const fee = 2;\n", { ticket: TICKET }));
    expect(path1.map((item) => item.code)).toContain("INTENT_OUT_OF_SCOPE");
    const id = intentViolations(input(root, "src/invoice.ts", "export const x = 1;\n", "export const x = chargeCustomer(1);\n", { ticket: TICKET }));
    expect(id.map((item) => `${item.code}@${item.line}`)).toEqual(["INTENT_OUT_OF_SCOPE@1"]);
    const unrelated = intentViolations(input(root, "src/logger.ts", null, "export const level = 'debug';\n", { ticket: TICKET }));
    expect(unrelated.map((item) => `${item.code}:${item.severity}`)).toEqual(["INTENT_UNRELATED:warn"]);
    expect(intentViolations(input(root, "src/invoice.ts", null, "export const currencyLabel = 'USD';\n", { ticket: TICKET }))).toEqual([]);
  });

  it("reports acceptance-criteria coverage for a change set", () => {
    const coverage = ticketCoverage(TICKET, [{ file: "src/domain/invoice.ts", before: null, after: "export function invoiceTotal() { return { total: 1, currencyLabel: 'USD' }; }\n" }]);
    expect(coverage.map((item) => item.covered)).toEqual([true, false]);
  });
});
