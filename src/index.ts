#!/usr/bin/env node
import { Command, type Command as CommanderCommand } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CONFIG_FILENAME, loadConfig } from "./config/load.js";
import { normalizeConfig } from "./config/schema.js";
import { anyCircuitOpen, loadState } from "./engine/circuit-breaker.js";
import { readRadar, resetRadar } from "./radar/state.js";
import { loadFlightPlan } from "./engine/flight-plan.js";
import { queryRadar } from "./engine/radar-memory.js";
import { evaluateHook, hookStdout } from "./hook.js";
import { createMcpServer } from "./mcp/server.js";
import { ensureGrammar, ensureGrammarFor, preloadForInvocation } from "./lang/treesitter.js";
import { findProjectRoot } from "./paths.js";
import { scanProject, writeScan } from "./scanner/repo-scanner.js";
import { applyContentReviewed, checkFileReviewed, presentWrite } from "./universal/check.js";
import { installAgents } from "./universal/agents.js";
import { GATED_AGENTS, installGatedAgent } from "./universal/agents-gated.js";
import { writeInstructionFiles } from "./universal/instructions.js";
import { startWireframe } from "./wireframe/cli.js";
import { exportTools, type ToolFormat } from "./universal/tools.js";
import { guardFiles, guardPush, installGitHooks, stagedFiles } from "./universal/git-hooks.js";
import { startWatch } from "./universal/watch.js";
import { startUniversalServer } from "./universal/http.js";
import { HOLD_PROTOCOL } from "./engine/payload.js";
import { registerV04Commands } from "./cli/v04.js";
import { registerV05Commands } from "./cli/v05.js";
import { selfCommand } from "./universal/self-command.js";

function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function flaggedRoot(command: CommanderCommand): string | undefined {
  return command.optsWithGlobals<{ root?: string }>().root;
}

function explicitRoot(command: CommanderCommand): string {
  const flagged = flaggedRoot(command);
  return path.resolve(flagged ?? process.env.CTC_ROOT ?? process.cwd());
}

function walkingRoot(command: CommanderCommand): string {
  const flagged = flaggedRoot(command);
  if (flagged) return path.resolve(flagged);
  return findProjectRoot(process.env.CTC_ROOT ?? process.cwd());
}

const STARTER = {
  version: 1,
  activeMilestone: {
    id: "foundation",
    title: "Foundation",
    allowedPaths: ["src/**", "tests/**"],
    status: "active" as const,
  },
  lockedFiles: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "dist/**", "coverage/**"],
  bannedImports: [] as [],
  restrictedCalls: [
    { callPattern: "eval", inPaths: ["**"], useInstead: "a named function in the project, never eval" },
    { callPattern: "Function", inPaths: ["**"], useInstead: "a named function in the project, never new Function" },
  ],
  degradation: {
    maxFunctionLength: null,
    maxCyclomaticComplexity: null,
    flagUnusedImports: false,
  },
  circuitBreaker: { maxStrikes: 3 },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Local runtime files under .ctc/ stay out of git; plans, policy and wireframes are meant to be committed. */
const CTC_GITIGNORE = `# Written by ctc init. Local runtime state and logs; commit plans, policy and wireframes.
findings.jsonl
radar.jsonl
violations.jsonl
state.json
read-zone.json
handoff.json
fix-ledger.json
snapshots/
replays/
cache/
`;

function writeCtcGitignore(root: string): void {
  const file = path.join(root, ".ctc", ".gitignore");
  if (!fs.existsSync(file)) fs.writeFileSync(file, CTC_GITIGNORE, "utf8");
}

function ctcCommand(): string[] {
  return selfCommand(fileURLToPath(import.meta.url), packageVersion());
}

function writeGateOutcome(payload: unknown, json: boolean, exitCode: 0 | 1 | 2): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (json || exitCode === 0) process.stdout.write(body);
  else process.stderr.write(body);
  process.exitCode = exitCode;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  return undefined as never;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ctc")
    .description("Code Traffic Control — reject architectural violations before they hit disk.")
    .version(packageVersion())
    .option("--root <dir>", "Project root. Defaults to CTC_ROOT or the current directory.");

  program
    .command("init")
    .description("Write a starter ctc.config.json and a .ctc directory.")
    .option("-f, --force", "Overwrite an existing ctc.config.json")
    .option("--agent <name>", "Write an agent integration. Use auto, or a comma-separated list such as cursor,claude,copilot,aider.")
    .option("--strict", "cursor/claude/copilot: disable or redirect the agent's native edit tools where its config allows, so edits go through the gate")
    .option("--wireframe <name>", "Also start a low-fi wireframe (.ctc/wireframes/<name>.json) for the design phase")
    .action(function (this: CommanderCommand, opts: { force?: boolean; agent?: string; strict?: boolean; wireframe?: string }) {
      const root = explicitRoot(this);
      const file = path.join(root, CONFIG_FILENAME);
      if (fs.existsSync(file) && !opts.force && !opts.agent) {
        fail(`${file} already exists. Pass --force to overwrite it.`);
        return;
      }
      if (!fs.existsSync(file) || opts.force) {
        const config = normalizeConfig(STARTER);
        fs.mkdirSync(root, { recursive: true });
        fs.mkdirSync(path.join(root, ".ctc"), { recursive: true });
        writeCtcGitignore(root);
        fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        process.stdout.write(
          `Wrote ${file}\nActive milestone: ${config.activeMilestone.id} (${config.activeMilestone.status})\nAllowed paths: ${config.activeMilestone.allowedPaths.join(", ")}\n`,
        );
      }
      if (opts.agent) {
        const requested = opts.agent.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        const gated = requested.filter((item) => (GATED_AGENTS as readonly string[]).includes(item));
        const rest = requested.filter((item) => !(GATED_AGENTS as readonly string[]).includes(item));
        if (rest.length > 0 || gated.length === 0) {
          const reports = installAgents(root, rest.length > 0 ? rest.join(",") : opts.agent, ctcCommand());
          for (const report of reports) {
            process.stdout.write(`${report.agent}: ${report.note}\n`);
            for (const written of report.files) process.stdout.write(`  ${written}\n`);
          }
        }
        if (gated.length > 0) writeInstructionFiles(root);
        for (const name of gated) {
          const report = installGatedAgent(root, name, ctcCommand(), opts.strict === true);
          process.stdout.write(`${report.agent} (${report.mode}): ${report.enforcement}\n`);
          for (const written of report.files) process.stdout.write(`  ${written}\n`);
        }
      }
      if (opts.wireframe) {
        const written = startWireframe(root, opts.wireframe);
        process.stdout.write(`Wireframe: ${written.json}\n  ${written.svg}\nAgree it with the agent before UI code (ctc wireframe approve ${opts.wireframe}).\n`);
      }
    });

  program
    .command("scan")
    .description("Scan a project and print a CTC config. Pass --write to save it.")
    .argument("[dir]", "Directory to scan")
    .option("-w, --write", "Write ctc.config.json and .ctc/flightplan.json")
    .option("-f, --force", "Overwrite an existing config")
    .option("-o, --out <file>", "Config path used with --write", CONFIG_FILENAME)
    .action(function (this: CommanderCommand, dir: string | undefined, opts: { write?: boolean; force?: boolean; out?: string }) {
      const root = path.resolve(dir ?? explicitRoot(this));
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        fail(`Scan directory does not exist: ${root}`);
        return;
      }
      const report = scanProject(root);
      if (opts.write) {
        try {
          const written = writeScan(root, report, { force: opts.force === true, ...(opts.out ? { configPath: opts.out } : {}) });
          process.stderr.write(`Wrote ${written.configPath}\nWrote ${written.flightPlanPath}\n`);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    });

  program
    .command("serve")
    .description("Start the CTC MCP server. Stdio by default. --http adds Streamable HTTP and the REST API.")
    .option("--http", "Listen on 127.0.0.1 instead of stdio.")
    .option("--port <number>", "Port for --http. Default 4317.", "4317")
    .action(async function (this: CommanderCommand, opts: { http?: boolean; port?: string }) {
      const root = walkingRoot(this);
      if (opts.http) {
        const port = Number.parseInt(opts.port ?? "4317", 10);
        await Promise.all([ensureGrammar("python"), ensureGrammar("go")]);
        const running = await startUniversalServer(root, { port: Number.isFinite(port) ? port : 4317, version: packageVersion() });
        process.stderr.write(`CTC listening on http://127.0.0.1:${running.port}\nMCP: /mcp\nREST: /v1/*\nOpenAPI: /openapi.json\n`);
        return;
      }
      await Promise.all([ensureGrammar("python"), ensureGrammar("go")]);
      const server = createMcpServer(root, packageVersion());
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });

  program
    .command("status")
    .description("Show the active milestone, circuit breaker, flight plan, and recent radar.")
    .option("-n, --limit <count>", "Radar entries to show", "10")
    .option("--json", "Print machine-readable JSON")
    .action(function (this: CommanderCommand, opts: { limit?: string; json?: boolean }) {
      const root = walkingRoot(this);
      let config: ReturnType<typeof loadConfig> | null = null;
      let configError: string | null = null;
      try {
        config = loadConfig(root);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
      const state = loadState(root);
      let flightPlan: ReturnType<typeof loadFlightPlan> = null;
      let flightPlanError: string | null = null;
      try {
        flightPlan = loadFlightPlan(root);
      } catch (error) {
        flightPlanError = error instanceof Error ? error.message : String(error);
      }
      const limit = Number.parseInt(opts.limit ?? "10", 10);
      const radar = queryRadar(root, { limit: Number.isFinite(limit) ? limit : 10 });
      const openFiles = Object.entries(state.files)
        .filter(([, entry]) => entry.circuitOpen)
        .map(([file]) => file);
      const body = {
        root,
        configError,
        activeMilestone: config?.activeMilestone ?? null,
        maxStrikes: config?.circuitBreaker.maxStrikes ?? 3,
        files: state.files,
        circuit: anyCircuitOpen(state) ? "open" : "closed",
        openFiles,
        lastDecision: state.lastDecision,
        lastSummary: state.lastSummary,
        flightPlan,
        flightPlanError,
        radar,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
        if (configError) process.exitCode = 1;
        return;
      }
      const milestone = config?.activeMilestone;
      const lines = [
        "Code Traffic Control",
        `Root: ${root}`,
        configError
          ? `Config: ${configError}`
          : `Milestone: ${milestone?.id} (${milestone?.status}) — ${milestone?.allowedPaths.join(", ")}`,
        `Circuit: ${body.circuit}${openFiles.length > 0 ? ` on ${openFiles.join(", ")}` : ""}`,
        readRadar(root).locked ? "Read radar: RED lock. Run `ctc reset` or read .ctc/state.json from a new session." : "Read radar: clear",
        flightPlanError
          ? `Flight plan: ${flightPlanError}`
          : flightPlan
            ? `Flight plan: ${flightPlan.milestone} — ${flightPlan.paths.join(", ")}`
            : "Flight plan: none (milestone allowedPaths still apply)",
        state.lastSummary ? `Last: ${state.lastSummary}` : "Last: no decisions yet",
        radar.length === 0 ? "Radar: empty" : "Radar:",
      ];
      for (const entry of radar) {
        lines.push(`  ${entry.ts} ${entry.decision} ${entry.path ?? "-"} gate=${entry.gate ?? "-"} strikes=${entry.strikes}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
      if (configError) process.exitCode = 1;
    });

  program
    .command("reset")
    .description("Clear the RED read lock and the consecutive gate-failure counter. The last handoff remains in .ctc/state.json.")
    .action(function (this: CommanderCommand) {
      const root = walkingRoot(this);
      const result = resetRadar(root);
      process.stdout.write(`Cleared the RED lock.\nRoot: ${root}\nSession: ${result.sessionId}\n`);
      if (result.bootstrapPrompt) process.stdout.write(`${result.bootstrapPrompt}\n`);
    });

  program
    .command("check")
    .description("Run RunwayGateAnalyzer on a file. Exit 0 pass, 2 hold, 1 error.")
    .argument("<file>", "Repo-relative file")
    .option("--content-from <source>", "Read proposed contents from stdin when the value is stdin.")
    .option("--json", "Print ctc.hold.v1 or ctc.cleared.v1 JSON.")
    .action(async function (this: CommanderCommand, file: string, opts: { contentFrom?: string; json?: boolean }) {
      const root = walkingRoot(this);
      const content = opts.contentFrom === "stdin" ? await readStdin() : undefined;
      const outcome = await checkFileReviewed(root, file, content);
      writeGateOutcome(outcome.payload, opts.json === true, outcome.exitCode);
    });

  program
    .command("apply")
    .description("Write a file when the analyzer passes. Content comes from stdin with --content-from stdin, otherwise the file on disk is re-checked.")
    .argument("<file>", "Repo-relative file")
    .option("--content-from <source>", "Read proposed contents from stdin when the value is stdin.")
    .option("--json", "Print JSON.")
    .action(async function (this: CommanderCommand, file: string, opts: { contentFrom?: string; json?: boolean }) {
      const root = walkingRoot(this);
      if (opts.contentFrom === "stdin") {
        const outcome = presentWrite(root, await applyContentReviewed(root, file, await readStdin()));
        writeGateOutcome(outcome.payload, opts.json === true, outcome.exitCode);
        return;
      }
      const outcome = await checkFileReviewed(root, file);
      writeGateOutcome(outcome.payload, opts.json === true, outcome.exitCode);
    });

  program
    .command("export-tools")
    .description("Print function definitions that map onto the local REST API.")
    .option("--format <format>", "openai, anthropic, gemini, or json-schema", "openai")
    .option("--server <url>", "Base URL baked into the descriptions", "http://127.0.0.1:4317")
    .action(function (opts: { format?: string; server?: string }) {
      const format = opts.format ?? "openai";
      if (format !== "openai" && format !== "anthropic" && format !== "gemini" && format !== "json-schema") {
        fail(`Unknown format ${format}. Use openai, anthropic, gemini, or json-schema.`);
        return;
      }
      process.stdout.write(`${JSON.stringify(exportTools(format as ToolFormat, opts.server), null, 2)}\n`);
    });

  program
    .command("install-git-hooks")
    .description("Install pre-commit and pre-push hooks that run the analyzer.")
    .action(function (this: CommanderCommand) {
      const root = walkingRoot(this);
      const hooks = installGitHooks(root, ctcCommand());
      process.stdout.write(`Installed ${hooks.preCommit}\nInstalled ${hooks.prePush}\n`);
    });

  program
    .command("git-guard")
    .description("Entry point used by the git hooks.")
    .argument("<kind>", "pre-commit or pre-push")
    .option("--scope", "Also hold files outside the active milestone's allowed paths (off by default, as in ctc ci).")
    .action(async function (this: CommanderCommand, kind: string, opts: { scope?: boolean }) {
      const root = walkingRoot(this);
      if (kind !== "pre-commit" && kind !== "pre-push") {
        fail(`Unknown git guard ${kind}.`);
        return;
      }
      const stdin = kind === "pre-push" ? await readStdin() : "";
      const result = kind === "pre-commit" ? guardFiles(root, stagedFiles(root), { scope: opts.scope === true }) : guardPush(root, stdin, { scope: opts.scope === true });
      if (result.exitCode !== 0) {
        process.stderr.write(`${HOLD_PROTOCOL}\n`);
        for (const hold of result.holds) process.stderr.write(`${hold.file}\n${hold.message}\n`);
        process.exitCode = 2;
      }
    });

  program
    .command("watch")
    .description("Analyze changed files and append .ctc/violations.jsonl. --revert restores the last good snapshot.")
    .option("--revert", "Restore .ctc/snapshots when a change fails the analyzer.")
    .action(function (this: CommanderCommand, opts: { revert?: boolean }) {
      const root = walkingRoot(this);
      startWatch(root, { revert: opts.revert === true });
      process.stderr.write(`CTC watch on ${root}${opts.revert ? " with revert" : ""}\n`);
    });

  program
    .command("hook")
    .description("Pre-write hook. Claude Code format by default; --cursor emits a Cursor preToolUse permission response.")
    .option("--cursor", "Emit Cursor permission JSON instead of Claude Code hookSpecificOutput.")
    .action(async (opts: { cursor?: boolean }) => {
      const raw = await readStdin();
      if (raw.trim() === "") {
        process.stdout.write(`${hookStdout({ permission: "allow", exitCode: 0, reason: "CTC hook received no payload.", payload: null }, opts.cursor ? "cursor" : "claude")}\n`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = {
          permission: "deny" as const,
          exitCode: 2 as const,
          reason: `CTC denied the tool call because the hook payload is not JSON: ${message}`,
          payload: null,
        };
        process.stdout.write(`${hookStdout(outcome, opts.cursor ? "cursor" : "claude")}\n`);
        process.stderr.write(`${outcome.reason}\n`);
        process.exitCode = 2;
        return;
      }
      const hookPath = JSON.stringify(parsed).match(/"(?:file_path|path|filePath)"\s*:\s*"([^"]+)"/)?.[1];
      if (hookPath) await ensureGrammarFor(hookPath);
      const outcome = evaluateHook(parsed);
      process.stdout.write(`${hookStdout(outcome, opts.cursor ? "cursor" : "claude")}\n`);
      if (outcome.exitCode !== 0) {
        process.stderr.write(`${outcome.reason}\n`);
        process.exitCode = outcome.exitCode;
      }
    });

  const helpers = {
    root: (command: Command) => walkingRoot(command),
    out: (text: string) => {
      process.stdout.write(text);
    },
    fail,
  };
  registerV04Commands(program, helpers);
  registerV05Commands(program, helpers);

  return program;
}

// npm and npx run the bin through a symlink (node_modules/.bin/ctc), so compare real paths.
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
const invokedDirectly = Boolean(process.argv[1]) && realPath(process.argv[1] as string) === realPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  preloadForInvocation(process.argv.slice(2), process.cwd())
    .catch(() => undefined)
    .then(() => buildProgram().parseAsync(process.argv)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { loadConfig, CONFIG_FILENAME } from "./config/load.js";
export { normalizeConfig, ConfigError } from "./config/schema.js";
export { reviewWrite, proposeWrite, checkFlightPlan } from "./engine/runway-gate.js";
export { createMcpServer } from "./mcp/server.js";
export { evaluateHook } from "./hook.js";
export { scanProject, writeScan } from "./scanner/repo-scanner.js";
