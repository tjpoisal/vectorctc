import path from "node:path";
import type { Command } from "commander";

import { writeBadge } from "../insights/badge.js";
import { renderReportCardText, reportCard } from "../insights/report-card.js";
import { acceptSuggestion, renderSuggestionsText, suggestRules } from "../insights/suggest.js";
import { listReplays, loadReplay, renderReplayText } from "../replay/store.js";
import { renderTryText, runTry } from "../trial/try.js";
import type { CliHelpers } from "./v04.js";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function registerV05Commands(program: Command, helpers: CliHelpers): void {
  program
    .command("try")
    .description("Zero-setup trial: replay the last N commits through the gate in a temporary clone and print what it would have held, by rule. Never modifies your repo.")
    .option("--commits <n>", "How many commits to replay (first-parent, max 500)", "50")
    .option("--timeout <seconds>", "Stop after this many seconds and report what was covered", "60")
    .option("--ref <ref>", "Replay history ending at this ref", "HEAD")
    .option("--json", "Print JSON")
    .action(function (this: Command, opts: { commits?: string; timeout?: string; ref?: string; json?: boolean }) {
      try {
        const report = runTry(helpers.root(this), { commits: int(opts.commits, 50), timeoutSeconds: int(opts.timeout, 60), ...(opts.ref ? { ref: opts.ref } : {}) });
        helpers.out(opts.json ? json(report) : renderTryText(report));
      } catch (error) {
        helpers.fail(error instanceof Error ? error.message : String(error));
      }
    });

  program
    .command("replay")
    .description("Why it held: show a stored held or observed write — the attempted diff, the rule broken, why, and the suggested fix.")
    .argument("[id]", "Replay id or unique prefix (see --list)")
    .option("--last", "The newest replay (default when no id is given)")
    .option("--list", "List the newest replays")
    .option("--json", "Print JSON")
    .action(function (this: Command, id: string | undefined, opts: { last?: boolean; list?: boolean; json?: boolean }) {
      const root = helpers.root(this);
      if (opts.list) {
        const items = listReplays(root, 30);
        if (opts.json) helpers.out(json(items.map((item) => ({ id: item.id, ts: item.ts, file: item.file, decision: item.decision, codes: item.explanations.map((entry) => entry.code) }))));
        else helpers.out(items.length ? `${items.map((item) => `${item.id}  ${item.ts.slice(0, 19).replace("T", " ")}Z  ${item.decision.padEnd(8)} ${item.file}  ${[...new Set(item.explanations.map((entry) => entry.code))].join(",")}`).join("\n")}\n` : "No replays stored yet (.ctc/replays).\n");
        return;
      }
      const replay = loadReplay(root, id && !opts.last ? id : { last: true });
      if (!replay) {
        helpers.fail(id ? `No unique replay matches '${id}'. Try: ctc replay --list` : "No replays stored yet. A replay is saved each time the gate holds (or observes) a write.");
        return;
      }
      helpers.out(opts.json ? json(replay) : renderReplayText(replay));
    });

  program
    .command("report-card")
    .description("Agent report card: hold rate, decisions, top rules and median attempts to clear, by agent (MCP clientInfo / CTC_AGENT / CTC_ACTOR) and model (CTC_MODEL).")
    .option("--repo <path...>", "Repos to include (default: this repo)")
    .option("--days <n>", "Window in days", "30")
    .option("--json", "Print JSON")
    .action(function (this: Command, opts: { repo?: string[]; days?: string; json?: boolean }) {
      const roots = opts.repo && opts.repo.length > 0 ? opts.repo.map((item) => path.resolve(item)) : [helpers.root(this)];
      const card = reportCard(roots, { days: int(opts.days, 30) });
      helpers.out(opts.json ? json(card) : renderReportCardText(card));
    });

  program
    .command("suggest-rules")
    .description("Propose repo-specific policy entries from the local hold history; --accept <id> writes one to .ctc/policy.json.")
    .option("--days <n>", "History window in days", "90")
    .option("--accept <id>", "Write this suggestion into .ctc/policy.json")
    .option("--json", "Print JSON")
    .action(function (this: Command, opts: { days?: string; accept?: string; json?: boolean }) {
      const root = helpers.root(this);
      const result = suggestRules(root, { days: int(opts.days, 90) });
      if (opts.accept) {
        const suggestion = result.suggestions.find((item) => item.id === opts.accept);
        if (!suggestion) {
          helpers.fail(`No current suggestion has id ${opts.accept}. Run ctc suggest-rules to list them.`);
          return;
        }
        try {
          const written = acceptSuggestion(root, suggestion);
          helpers.out(written.changed ? `Accepted ${suggestion.id}: ${suggestion.title}. Wrote ${path.relative(root, written.file)}.\n` : `${suggestion.id} is already in ${path.relative(root, written.file)}; nothing changed.\n`);
        } catch (error) {
          helpers.fail(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      helpers.out(opts.json ? json(result) : renderSuggestionsText(result));
    });

  program
    .command("badge")
    .description("Write a 'gated by VectorCTC · hold rate X%' SVG and a shields.io endpoint JSON from the local findings log, and print a README snippet.")
    .option("--out <dir>", "Output directory (repo-relative)", ".ctc/badge")
    .option("--days <n>", "Window in days", "30")
    .option("--repo <owner/name>", "GitHub repo, to fill in the shields.io endpoint URL")
    .option("--branch <name>", "Branch the badge JSON is committed on", "main")
    .option("--json", "Print JSON")
    .action(function (this: Command, opts: { out?: string; days?: string; repo?: string; branch?: string; json?: boolean }) {
      const root = helpers.root(this);
      const result = writeBadge(root, { days: int(opts.days, 30), ...(opts.out ? { out: opts.out } : {}), ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
      if (opts.json) {
        helpers.out(json(result));
        return;
      }
      helpers.out(`${result.label}: ${result.message} (${result.held} held of ${result.decisions} decisions)\nWrote ${path.relative(root, result.svgPath)} and ${path.relative(root, result.jsonPath)}\n\nREADME snippet:\n\n${result.snippet}\n`);
    });
}
