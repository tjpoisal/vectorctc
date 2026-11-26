import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { installGitHooks } from "./git-hooks.js";
import { INSTRUCTION, writeInstructionFiles } from "./instructions.js";

export interface AgentReport {
  agent: string;
  files: string[];
  verified: boolean;
  note: string;
}

export const AGENT_NAMES = ["claude", "cursor", "windsurf", "cline", "roo", "gemini", "opencode", "codex", "zed", "continue", "warp", "antigravity", "aider", "auto"] as const;

function mergeJson(file: string, update: (current: Record<string, unknown>) => void): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  update(current);
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function stdioServer(command: readonly string[]): Record<string, unknown> {
  return { command: command[0], args: command.slice(1), env: { CTC_ROOT: "." } };
}

function commandExists(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shellJoin(parts: readonly string[]): string {
  return parts.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
}

function appendToml(file: string, header: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes(header)) return;
  fs.writeFileSync(file, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${header}\n${body}\n`, "utf8");
}

export function installAgent(root: string, agent: string, command: readonly string[]): AgentReport {
  const name = agent.toLowerCase();
  // MCP entries launch `ctc serve`; hooks below use the bare command plus `hook`.
  const server = stdioServer([...command, "serve"]);
  const files: string[] = [];
  const note = (text: string, verified: boolean): AgentReport => ({ agent: name, files, verified, note: text });

  if (name === "claude") {
    const mcp = path.join(root, ".mcp.json");
    mergeJson(mcp, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    const settings = path.join(root, ".claude", "settings.json");
    mergeJson(settings, (current) => {
      const hooks = (current.hooks as Record<string, unknown> | undefined) ?? {};
      hooks.PreToolUse = [
        {
          matcher: "Write|Edit|MultiEdit|StrReplace",
          hooks: [{ type: "command", command: `${shellJoin(command)} hook` }],
        },
      ];
      current.hooks = hooks;
    });
    files.push(mcp, settings);
    return note("Claude Code .mcp.json mcpServers and .claude/settings.json PreToolUse, from the Claude Code hooks and MCP docs.", true);
  }

  if (name === "cursor") {
    const mcp = path.join(root, ".cursor", "mcp.json");
    mergeJson(mcp, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    const hooks = path.join(root, ".cursor", "hooks.json");
    mergeJson(hooks, (current) => {
      current.version = 1;
      const existing = (current.hooks as Record<string, unknown> | undefined) ?? {};
      existing.preToolUse = [{ command: `${shellJoin(command)} hook --cursor`, matcher: "Write" }];
      current.hooks = existing;
    });
    files.push(mcp, hooks);
    return note("Cursor .cursor/mcp.json mcpServers and .cursor/hooks.json preToolUse matcher Write, from the Cursor hooks docs. There is no beforeFileEdit.", true);
  }

  if (name === "windsurf") {
    const mcp = path.join(root, ".devin", "mcp_config.json");
    mergeJson(mcp, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    files.push(mcp);
    return note("Windsurf/Devin mcpServers shape is from docs.devin.ai. This writes the project file .devin/mcp_config.json. The official page also documents the global file ~/.config/devin/mcp_config.json. Cascade still reads that global file.", true);
  }

  if (name === "cline") {
    const snippet = path.join(root, ".ctc", "agents", "cline_mcp_settings.json");
    mergeJson(snippet, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = { ...server, disabled: false, autoApprove: [] };
      current.mcpServers = servers;
    });
    files.push(snippet);
    return note("Cline's verified settings file is global: ~/.cline/data/settings/cline_mcp_settings.json, with mcpServers.command/args. CTC writes a merge snippet because that file is outside the repo. Cline also reads AGENTS.md. The project is advisory until the snippet is merged and the MCP tools are used.", false);
  }

  if (name === "roo") {
    const mcp = path.join(root, ".roo", "mcp.json");
    mergeJson(mcp, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = { ...server, alwaysAllow: ["ctc_write_file", "ctc_patch_file", "ctc_read_file"], disabled: false };
      current.mcpServers = servers;
    });
    files.push(mcp);
    return note("Roo Code project MCP is .roo/mcp.json with mcpServers, from docs.roocode.com. MCP use enforces when the agent calls the tools. Native edits stay advisory.", true);
  }

  if (name === "gemini") {
    const settings = path.join(root, ".gemini", "settings.json");
    mergeJson(settings, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    files.push(settings);
    return note("Gemini CLI project settings are .gemini/settings.json mcpServers, from geminicli.com. command starts a stdio server. httpUrl is the field for Streamable HTTP.", true);
  }

  if (name === "opencode") {
    const file = path.join(root, "opencode.json");
    mergeJson(file, (current) => {
      const mcp = (current.mcp as Record<string, unknown> | undefined) ?? {};
      const servers = (mcp.servers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = { type: "local", command: [...command, "serve"], environment: { CTC_ROOT: "." } };
      mcp.servers = servers;
      current.mcp = mcp;
    });
    files.push(file);
    return note("OpenCode's current docs use opencode.json mcp.servers with type local and command as an array. Older configs put the server name directly under mcp. This writes the current shape.", true);
  }

  if (name === "codex") {
    const file = path.join(root, ".codex", "config.toml");
    const [bin, ...args] = [...command, "serve"];
    appendToml(file, "[mcp_servers.code-traffic-control]", `command = ${JSON.stringify(bin)}\nargs = ${JSON.stringify(args)}\n`);
    files.push(file);
    return note("Codex mcp_servers.<name> command/args is from the official config reference. Warp's docs also name .codex/config.toml as the project-scoped file. The user-global file is ~/.codex/config.toml.", true);
  }

  if (name === "zed") {
    const file = path.join(root, ".zed", "settings.json");
    mergeJson(file, (current) => {
      const servers = (current.context_servers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = { command: command[0], args: [...command.slice(1), "serve"], env: { CTC_ROOT: "." } };
      current.context_servers = servers;
    });
    files.push(file);
    return note("Zed context_servers command/args/env is from zed.dev/docs/ai/mcp. Project settings live in .zed/settings.json.", true);
  }

  if (name === "continue") {
    const file = path.join(root, ".continue", "mcpServers", "code-traffic-control.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const yaml = [
      "name: Code Traffic Control",
      "version: 0.0.1",
      "schema: v1",
      "mcpServers:",
      "  - name: code-traffic-control",
      "    type: stdio",
      `    command: ${JSON.stringify(command[0])}`,
      "    args:",
      ...[...command.slice(1), "serve"].map((arg) => `      - ${JSON.stringify(arg)}`),
      "    env:",
      "      CTC_ROOT: .",
      "",
    ].join("\n");
    fs.writeFileSync(file, yaml, "utf8");
    files.push(file);
    return note("Continue standalone MCP blocks live in .continue/mcpServers and require name, version, and schema, from docs.continue.dev. JSON mcpServers files in that directory are also accepted.", true);
  }

  if (name === "warp") {
    const file = path.join(root, ".warp", ".mcp.json");
    mergeJson(file, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    files.push(file);
    return note("Warp project MCP is .warp/.mcp.json with mcpServers, from docs.warp.dev. Project servers need approval before they spawn. Native terminal edits are advisory until the agent uses the MCP tools.", true);
  }

  if (name === "antigravity") {
    const file = path.join(root, ".agents", "mcp_config.json");
    mergeJson(file, (current) => {
      const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers["code-traffic-control"] = server;
      current.mcpServers = servers;
    });
    files.push(file);
    return note("Antigravity workspace MCP is <workspace>/.agents/mcp_config.json with mcpServers.command or serverUrl, from antigravity.google/docs/mcp. Remote servers use Streamable HTTP.", true);
  }

  if (name === "aider") {
    const conventions = path.join(root, "CONVENTIONS.md");
    const conf = path.join(root, ".aider.conf.yml");
    fs.writeFileSync(conventions, `# Conventions\n\n${INSTRUCTION}`, "utf8");
    const current = fs.existsSync(conf) ? fs.readFileSync(conf, "utf8") : "";
    if (!current.includes("CONVENTIONS.md")) {
      fs.writeFileSync(conf, `${current.trimEnd()}${current.trim() ? "\n" : ""}read:\n  - CONVENTIONS.md\n`, "utf8");
    }
    const hooks = installGitHooks(root, command);
    files.push(conventions, conf, hooks.preCommit, hooks.prePush);
    return note("Aider has no MCP. Official conventions are a read-only file named in .aider.conf.yml (aider.chat/docs). This also installs git hooks. Run ctc watch --revert for a live safety net. Enforcement is the git hook, not the model.", true);
  }

  const generic = path.join(root, ".ctc", "agents", `${name || "generic"}.md`);
  fs.mkdirSync(path.dirname(generic), { recursive: true });
  fs.writeFileSync(
    generic,
    `# ${name || "agent"}\n\nCTC could not verify a native config format for this agent.\n\nUse one of these, all of which call the same RunwayGateAnalyzer:\n\n- Shell: \`ctc check <file> --content-from stdin\` and \`ctc apply <file> --content-from stdin\`\n- HTTP: \`ctc serve --http --port 4317\`, then POST /v1/write\n- Tools: \`ctc export-tools --format openai|anthropic|gemini|json-schema\`\n- Safety net: \`ctc install-git-hooks\` and \`ctc watch --revert\`\n`,
    "utf8",
  );
  files.push(generic);
  return note("No verified native config. Wrote generic instructions. Grok, DeepSeek, and on-device agents use the REST tools or the shell gate.", false);
}

export function detectAgents(): string[] {
  const found = new Set<string>();
  if (commandExists("claude")) found.add("claude");
  if (commandExists("cursor") || commandExists("cursor-agent")) found.add("cursor");
  if (commandExists("windsurf") || commandExists("devin")) found.add("windsurf");
  if (commandExists("cline")) found.add("cline");
  if (commandExists("gemini")) found.add("gemini");
  if (commandExists("opencode")) found.add("opencode");
  if (commandExists("codex")) found.add("codex");
  if (commandExists("zed")) found.add("zed");
  if (commandExists("warp")) found.add("warp");
  if (commandExists("aider")) found.add("aider");
  if (commandExists("agy") || commandExists("antigravity")) found.add("antigravity");
  return [...found];
}

export function installAgents(root: string, requested: string, command: readonly string[]): AgentReport[] {
  writeInstructionFiles(root);
  const names = requested === "auto" ? detectAgents() : requested.split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) {
    return [{ agent: "auto", files: [], verified: false, note: "No installed agent command was detected. Instruction files were written. Use the shell gate, REST API, or git hooks." }];
  }
  return names.map((name) => installAgent(root, name, command));
}
