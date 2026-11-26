import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { impactOf } from "../crossrepo/impact.js";
import { aggregate } from "../dashboard/aggregate.js";
import { renderDashboard } from "../dashboard/render.js";
import { startDashboard } from "../dashboard/server.js";
import { applyFix } from "../explain/apply-fix.js";
import { ciAnnotations, ciMarkdown, runCi } from "../ci/ci.js";
import { githubContextFromEnv, publishToGitHub } from "../ci/github.js";
import { lastHeld, ledgerSummary } from "../explain/ledger.js";
import { effectivePolicy } from "../policy/policy.js";
import { importRuleFiles } from "../policy/rulefiles.js";
import { PROJECT_ADVISORIES, auditProject, fetchOsv, lockfilesIn, projectDependencies, type AdvisoryDb } from "../security/advisories.js";
import { exportFindings, readFindings, verifyChain } from "../telemetry/findings-log.js";
import { resolveIdentity } from "../enterprise/identity.js";
import { approveWireframe, listWireframes, loadOne, renderToFile, startWireframe } from "../wireframe/cli.js";
import { wireframeViolations } from "../wireframe/drift.js";

export interface CliHelpers {
  root(command: Command): string;
  out(text: string): void;
  fail(message: string): void;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function observeReport(root: string): { since: string | null; records: number; wouldHaveBlocked: number; byRule: Array<{ code: string; observed: number; enforcedHolds: number; files: number }> } {
  const records = readFindings(root);
  const byCode = new Map<string, { observed: number; enforcedHolds: number; files: Set<string> }>();
  let would = 0;
  for (const record of records) {
    if (record.findings.some((item) => item.severity === "observe")) would += 1;
    for (const item of record.findings) {
      const entry = byCode.get(item.code) ?? { observed: 0, enforcedHolds: 0, files: new Set<string>() };
      if (item.severity === "observe") entry.observed += 1;
      if (item.severity === "block") entry.enforcedHolds += 1;
      entry.files.add(record.file);
      byCode.set(item.code, entry);
    }
  }
  return {
    since: records[0]?.ts ?? null,
    records: records.length,
    wouldHaveBlocked: would,
    byRule: [...byCode].map(([code, entry]) => ({ code, observed: entry.observed, enforcedHolds: entry.enforcedHolds, files: entry.files.size })).sort((a, b) => b.observed + b.enforcedHolds - (a.observed + a.enforcedHolds)),
  };
}

export function registerV04Commands(program: Command, helpers: CliHelpers): void {
  program
    .command("explain")
    .description("Explain-the-block report for the last held proposal of a file (rule, lines, why, fix patch). No file: fix-loop summary.")
    .argument("[file]", "Repo-relative file")
    .option("--json", "Print JSON")
    .action(function (this: Command, file: string | undefined, opts: { json?: boolean }) {
      const root = helpers.root(this);
      if (!file) {
        helpers.out(json({ protocol: "ctc.fixloop.v1", files: ledgerSummary(root) }));
        return;
      }
      const last = lastHeld(root, file);
      if (!last) {
        helpers.out(opts.json ? json({ protocol: "ctc.explain.v1", file, explanations: [] }) : `Nothing is held for ${file}.\n`);
        return;
      }
      if (opts.json) {
        helpers.out(json({ protocol: "ctc.explain.v1", file, explanations: last.explanations }));
        return;
      }
      const lines: string[] = [];
      for (const item of last.explanations) {
        lines.push(`${item.code} [${item.rule}] ${item.file}${item.lines ? `:${item.lines.start}${item.lines.end !== item.lines.start ? `-${item.lines.end}` : ""}` : ""}  id=${item.id}`);
        lines.push(`  what: ${item.message}`);
        lines.push(`  why:  ${item.why}`);
        lines.push(...item.snippet.map((text) => `  ${text}`));
        lines.push(`  fix (${item.fix.kind}, ${item.fix.confidence}): ${item.fix.summary}`);
        if (item.fix.patch) lines.push(...item.fix.patch.trimEnd().split("\n").map((text) => `    ${text}`));
        lines.push("");
      }
      helpers.out(`${lines.join("\n")}\n`);
    });

  program
    .command("fix")
    .description("Apply the suggested fixes from the last held proposal and run it through the gate; written only if it clears.")
    .argument("<file>", "Repo-relative file")
    .option("--ids <ids>", "Comma-separated explanation ids (default: all mechanical fixes)")
    .action(async function (this: Command, file: string, opts: { ids?: string }) {
      const root = helpers.root(this);
      const result = await applyFix(root, file, opts.ids ? opts.ids.split(",").map((item) => item.trim()).filter(Boolean) : undefined);
      helpers.out(json(result));
      if (!result.result?.cleared) process.exitCode = 2;
    });

  const rules = program.command("rules").description("Agent rule files (AGENTS.md, CLAUDE.md, .cursor/rules, Copilot instructions) as enforceable policy.");
  rules
    .command("import")
    .description("Show which rule-file lines CTC enforces, which stay advisory, and the coverage.")
    .option("--json", "Print JSON")
    .action(function (this: Command, opts: { json?: boolean }) {
      const root = helpers.root(this);
      const report = importRuleFiles(root);
      if (opts.json) {
        helpers.out(json(report));
        return;
      }
      const lines = [`Rule files: ${report.files.length ? report.files.join(", ") : "none found"}`, `Enforced: ${report.coverage.compiled} of ${report.coverage.ruleLines} rule lines`, ""];
      for (const rule of report.compiled) lines.push(`  ENFORCED ${rule.kind.padEnd(22)} ${rule.target}${rule.useInstead ? ` → ${rule.useInstead}` : ""}  (${rule.source}; scope ${rule.scope.join(",")})`);
      for (const item of report.advisory) lines.push(`  advisory ${item.source}: ${item.text}`);
      lines.push("", "Make a line enforceable with an explicit directive, e.g. `<!-- ctc: ban-import axios -->` or `<!-- ctc: forbid-code console.log -->`.");
      helpers.out(`${lines.join("\n")}\n`);
    });

  const policy = program.command("policy").description("Org → repo → directory policy as code, and observe-mode rollout.");
  policy
    .command("explain")
    .description("Effective policy for a path, with the layer that set each value and any conflicts with locked settings.")
    .argument("[file]", "Repo-relative file")
    .action(function (this: Command, file: string | undefined) {
      const root = helpers.root(this);
      const effective = effectivePolicy(root, file ?? null);
      helpers.out(json({ ...effective, layers: effective.layers.map((layer) => ({ level: layer.level, source: layer.source })) }));
      if (effective.errors.length) process.exitCode = 1;
    });
  policy
    .command("report")
    .description("Observe-mode rollout report from .ctc/findings.jsonl: what would have blocked, per rule.")
    .action(function (this: Command) {
      helpers.out(json(observeReport(helpers.root(this))));
    });
  policy
    .command("init")
    .description("Write a starter .ctc/policy.json (observe mode for the new v0.4 rule families).")
    .option("-f, --force", "Overwrite")
    .action(function (this: Command, opts: { force?: boolean }) {
      const root = helpers.root(this);
      const file = path.join(root, ".ctc", "policy.json");
      if (fs.existsSync(file) && !opts.force) {
        helpers.fail(`${file} exists. Pass --force to overwrite it.`);
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, json({ version: 1, mode: "enforce", rules: { "SecretScan": { mode: "enforce", locked: true }, "SAST_*": { mode: "observe" }, "VULNERABLE_DEPENDENCY": { mode: "enforce" }, "PolicyRule": { mode: "observe" }, "IntentCheck": { mode: "observe" } }, forbid: [], importRuleFiles: true, crossRepo: { siblings: [] }, intent: { unrelated: "warn" } }), "utf8");
      helpers.out(`Wrote ${file}\n`);
    });

  program
    .command("dashboard")
    .description("Local team dashboard over the findings logs (127.0.0.1 only; nothing leaves the machine). --out writes a static HTML file instead.")
    .option("--repo <path...>", "Repos to include (default: this repo)")
    .option("--port <n>", "Port", "4318")
    .option("--days <n>", "Window in days", "30")
    .option("--out <file>", "Write a static HTML report and exit")
    .option("--json", "Print the aggregated data and exit")
    .action(async function (this: Command, opts: { repo?: string[]; port?: string; days?: string; out?: string; json?: boolean }) {
      const roots = opts.repo && opts.repo.length > 0 ? opts.repo.map((item) => path.resolve(item)) : [helpers.root(this)];
      const days = Number.parseInt(opts.days ?? "30", 10) || 30;
      if (opts.json || opts.out) {
        const data = aggregate(roots, { days });
        if (opts.out) {
          fs.writeFileSync(path.resolve(opts.out), renderDashboard(data), "utf8");
          helpers.out(`Wrote ${path.resolve(opts.out)} (${data.totals.decisions} decisions from ${roots.length} repo(s))\n`);
        }
        if (opts.json) helpers.out(json(data));
        return;
      }
      const running = await startDashboard(roots, { port: Number.parseInt(opts.port ?? "4318", 10), days });
      process.stderr.write(`VectorCTC dashboard: http://127.0.0.1:${running.port}/  (JSON: /api/summary). Ctrl-C to stop.\n`);
    });

  program
    .command("impact")
    .description("List where sibling repos (policy crossRepo.siblings) use what a file exports — before you change it.")
    .argument("<file>", "Repo-relative file")
    .option("--json", "Print JSON")
    .action(function (this: Command, file: string, opts: { json?: boolean }) {
      const root = helpers.root(this);
      const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
      const report = impactOf(root, relative);
      if (opts.json) {
        helpers.out(json(report));
        return;
      }
      if (report.siblings.length === 0) {
        helpers.out("No sibling repos configured. Add crossRepo.siblings to .ctc/policy.json.\n");
        return;
      }
      for (const entry of report.exports) {
        const uses = entry.consumers.map((c) => `${c.sibling}/${c.file}:${c.line}`);
        helpers.out(`${entry.name}${entry.arity === null ? "" : `/${entry.arity}`}: ${uses.length ? uses.join(", ") : "no sibling consumers"}\n`);
      }
      for (const missing of report.missing) helpers.out(`(sibling '${missing}' is not on disk)\n`);
    });

  const advisories = program.command("advisories").description("Offline dependency advisories (OSV) for the SCA check.");
  advisories
    .command("sync")
    .description(`Query OSV (api.osv.dev, free, no key) for every dependency in the project's lockfiles and cache the result in ${PROJECT_ADVISORIES}. The gate itself never uses the network.`)
    .action(async function (this: Command) {
      const root = helpers.root(this);
      const deps = projectDependencies(root);
      if (deps.length === 0) {
        helpers.out(`No dependencies found in ${lockfilesIn(root).join(", ") || "any lockfile"}.\n`);
        return;
      }
      const db = await fetchOsv(deps);
      const file = path.join(root, PROJECT_ADVISORIES);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, json(db), "utf8");
      const count = Object.values(db.packages).reduce((sum, list) => sum + list.length, 0);
      helpers.out(`Cached ${count} advisories for ${Object.keys(db.packages).length} packages in ${file}\n`);
    });
  advisories
    .command("import")
    .description("Import an OSV-format JSON file (a mirror or an offline export) into the project cache.")
    .argument("<file>", "AdvisoryDb JSON")
    .action(function (this: Command, file: string) {
      const root = helpers.root(this);
      const incoming = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as AdvisoryDb;
      const target = path.join(root, PROJECT_ADVISORIES);
      const current: AdvisoryDb = fs.existsSync(target) ? (JSON.parse(fs.readFileSync(target, "utf8")) as AdvisoryDb) : { version: 1, source: incoming.source, fetchedAt: incoming.fetchedAt, packages: {} };
      for (const [key, list] of Object.entries(incoming.packages)) current.packages[key] = [...new Map([...(current.packages[key] ?? []), ...list].map((item) => [item.id, item])).values()];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json(current), "utf8");
      helpers.out(`Merged ${Object.keys(incoming.packages).length} packages into ${target}\n`);
    });
  advisories
    .command("audit")
    .description("Report locked dependencies with known advisories (does not block).")
    .action(function (this: Command) {
      const root = helpers.root(this);
      const report = auditProject(root, lockfilesIn(root));
      helpers.out(json(report));
      if (report.length > 0) process.exitCode = 2;
    });

  program
    .command("ci")
    .description("Run the gate over a PR's diff (merge-base..head) as a required check: annotations, a sticky PR comment, and opt-in explainable auto-approve. Exit 2 on holds.")
    .option("--base <ref>", "Base ref. Default: origin/$GITHUB_BASE_REF, else origin/main")
    .option("--head <ref>", "Head ref", "HEAD")
    .option("--json", "Print the ctc.ci.v1 report")
    .option("--markdown <file>", "Also write the PR comment markdown to a file")
    .option("--github", "Post or update the sticky PR comment (and approve if allowed) with GITHUB_TOKEN")
    .option("--auto-approve", "Approve the PR when every risk factor passes (opt-in)")
    .option("--max-lines <n>", "Changed-line limit for auto-approve", "40")
    .option("--scope", "Also hold files outside the milestone's allowed paths")
    .option("--observe", "Report holds but always exit 0 (rollout)")
    .option("--ticket <file>", "Ticket text for acceptance-criteria coverage. Default: the flight plan's ticket, else the PR body in GitHub Actions")
    .action(async function (this: Command, opts: { base?: string; head?: string; json?: boolean; markdown?: string; github?: boolean; autoApprove?: boolean; maxLines?: string; scope?: boolean; observe?: boolean; ticket?: string }) {
      const root = helpers.root(this);
      const base = opts.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
      let ticket: string | null = opts.ticket ? fs.readFileSync(path.resolve(opts.ticket), "utf8") : null;
      if (!ticket && process.env.GITHUB_EVENT_PATH) {
        try {
          const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { body?: unknown } };
          if (typeof event.pull_request?.body === "string" && event.pull_request.body.trim()) ticket = event.pull_request.body;
        } catch {
          ticket = null;
        }
      }
      const report = runCi(root, { base, head: opts.head ?? "HEAD", autoApprove: opts.autoApprove === true, maxChangedLines: Number(opts.maxLines ?? 40), scope: opts.scope === true, ticket });
      if (opts.markdown) fs.writeFileSync(opts.markdown, ciMarkdown(report), "utf8");
      if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(ciAnnotations(report));
      if (opts.json) helpers.out(json(report));
      else helpers.out(ciMarkdown(report));
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ciMarkdown(report));
      if (opts.github) {
        const ctx = githubContextFromEnv();
        if (!ctx) process.stderr.write("ctc ci --github: GITHUB_TOKEN, GITHUB_REPOSITORY and a pull_request event are required; skipped posting.\n");
        else {
          const posted = await publishToGitHub(report, ctx);
          process.stderr.write(`PR comment ${posted.comment}${posted.approved ? "; approved (every risk factor passed)" : ""}.\n`);
        }
      }
      if (!report.cleared && !opts.observe) process.exitCode = 2;
    });

  const wireframe = program.command("wireframe").description("Low-fi wireframes for the design phase: agree the layout before UI code, then the gate flags drift.");
  wireframe
    .command("new")
    .description("Create .ctc/wireframes/<name>.json (a starter layout to edit) and render it to SVG.")
    .argument("<name>", "kebab-case name")
    .option("--route <route>", "Route the screen lives at")
    .option("--title <title>", "Screen title")
    .option("--files <globs>", "Comma-separated UI file globs this wireframe governs")
    .action(function (this: Command, name: string, opts: { route?: string; title?: string; files?: string }) {
      const root = helpers.root(this);
      const written = startWireframe(root, name, { ...(opts.route ? { route: opts.route } : {}), ...(opts.title ? { title: opts.title } : {}), ...(opts.files ? { files: opts.files.split(",").map((item) => item.trim()) } : {}) });
      helpers.out(`Wrote ${written.json}\nRendered ${written.svg}\nEdit the regions/components, re-render, then agree it: ctc wireframe approve ${name}\n`);
    });
  wireframe
    .command("render")
    .description("Render one wireframe (or all) to SVG next to the spec.")
    .argument("[name]", "Wireframe name; omit for all")
    .action(function (this: Command, name: string | undefined) {
      const root = helpers.root(this);
      const names = name ? [name] : listWireframes(root).map((item) => item.name);
      for (const item of names) helpers.out(`Rendered ${renderToFile(root, loadOne(root, item))}\n`);
    });
  wireframe
    .command("approve")
    .description("Record agreement on a wireframe. Approval is bound to the layout's hash; editing the wireframe later needs a new approval.")
    .argument("<name>", "Wireframe name")
    .option("--by <who>", "Who agreed (default $CTC_ACTOR or $USER)")
    .action(function (this: Command, name: string, opts: { by?: string }) {
      const root = helpers.root(this);
      const frame = approveWireframe(root, name, opts.by ?? process.env.CTC_ACTOR ?? process.env.USER ?? "human");
      helpers.out(`Approved ${frame.name} (hash ${frame.approval?.hash}) by ${frame.approval?.by}\n`);
    });
  wireframe
    .command("list")
    .description("List wireframes and their approval state.")
    .action(function (this: Command) {
      helpers.out(json(listWireframes(helpers.root(this))));
    });
  wireframe
    .command("check")
    .description("Check a UI file on disk against its wireframe (whole file, not just a diff).")
    .argument("<file>", "Repo-relative UI file")
    .option("--complete", "Treat missing components as holds (the UI should be finished)")
    .action(function (this: Command, file: string, opts: { complete?: boolean }) {
      const root = helpers.root(this);
      const content = fs.readFileSync(path.join(root, file), "utf8");
      const found = wireframeViolations(root, file, null, content, opts.complete ? ({ uiComplete: true } as never) : null);
      helpers.out(json({ file, findings: found }));
      if (found.some((item) => item.severity !== "warn")) process.exitCode = 2;
    });

  const audit = program.command("audit").description("Tamper-evident audit log (.ctc/findings.jsonl, SHA-256 hash chain).");
  audit
    .command("verify")
    .description("Verify the hash chain of the findings/audit log.")
    .action(function (this: Command) {
      const result = verifyChain(helpers.root(this));
      helpers.out(json(result));
      if (!result.ok) process.exitCode = 2;
    });
  audit
    .command("export")
    .description("Export the audit log for a SIEM: jsonl (as stored), csv, or cef (ArcSight). Refuses to export a broken chain unless --force.")
    .option("--format <format>", "jsonl | csv | cef", "jsonl")
    .option("--since <iso>", "Only records at or after this ISO time")
    .option("--out <file>", "Write to a file instead of stdout")
    .option("--force", "Export even if the hash chain does not verify")
    .action(function (this: Command, opts: { format?: string; since?: string; out?: string; force?: boolean }) {
      const root = helpers.root(this);
      const format = opts.format === "csv" || opts.format === "cef" ? opts.format : "jsonl";
      const chain = verifyChain(root);
      if (!chain.ok && !opts.force) {
        helpers.fail(`Audit chain is broken at record ${chain.brokenAt}: ${chain.reason}. Pass --force to export anyway.`);
        return;
      }
      const records = readFindings(root).filter((record) => !opts.since || record.ts >= opts.since);
      const text = exportFindings(records, format);
      if (opts.out) {
        fs.writeFileSync(path.resolve(opts.out), text, "utf8");
        helpers.out(`Wrote ${records.length} record(s) to ${path.resolve(opts.out)}\n`);
      } else helpers.out(text);
    });

  program
    .command("whoami")
    .description("Show the identity CTC records in the audit log (CTC_ACTOR, or a verified OIDC ID token; OIDC is a preview).")
    .action(function () {
      const identity = resolveIdentity();
      helpers.out(json(identity));
    });
}
