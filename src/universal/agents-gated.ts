import fs from "node:fs";
import path from "node:path";

/**
 * One-click gated setup (v0.4) for Cursor, Claude Code and GitHub Copilot (VS Code agent mode).
 * Each agent gets the CTC MCP server plus the strongest edit routing its config files allow:
 *
 *   Claude Code  hook mode: PreToolUse hook gates every native Write/Edit/MultiEdit/NotebookEdit.
 *                strict:    permissions.deny on the native edit tools, so edits can only go through
 *                           mcp__code-traffic-control__ctc_write_file / ctc_patch_file (pre-allowed).
 *   Cursor       hook mode: .cursor/hooks.json preToolUse on Write (native edits are gated).
 *                strict:    also an alwaysApply rule that redirects edits to ctc_write_file. Cursor has no
 *                           project setting that removes its built-in edit tool, so the hook stays the enforcer.
 *   Copilot      .vscode/mcp.json server, a CTC section in .github/copilot-instructions.md, and a custom
 *                agent (.github/agents/ctc-gated.agent.md) whose tool list has no built-in edit tool, so in
 *                that agent edits can only go through CTC. Copilot's default agent keeps its own edit tool.
 */

export const GATED_AGENTS = ["claude", "cursor", "copilot"] as const;
const SERVER = "code-traffic-control";
const MARKER_START = "<!-- ctc:begin -->";
const MARKER_END = "<!-- ctc:end -->";
const NATIVE_EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // missing or invalid: start fresh
  }
  return {};
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shellJoin(parts: readonly string[]): string {
  return parts.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)).join(" ");
}

function upsertSection(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = `${MARKER_START}\n${body.trim()}\n${MARKER_END}`;
  const next = current.includes(MARKER_START) ? current.replace(new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`), block) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(file, next, "utf8");
}

const GATE_TEXT = `## Code Traffic Control (VectorCTC)

All file edits in this repo go through the CTC gate. Use the \`ctc_write_file\` / \`ctc_patch_file\` tools from the \`${SERVER}\` MCP server instead of built-in edit tools.
When a write is held, read \`explain.explanations\` (rule, lines, why, fix). Call \`ctc_apply_fix\` for the mechanical fixes, fix the rest, and resubmit. Do not route around a hold.
Before UI code, agree the wireframe (\`ctc wireframe render\`) and keep the UI matching it.`;

export interface GatedReport {
  agent: string;
  files: string[];
  mode: "hook" | "strict";
  enforcement: string;
}

export function installGatedAgent(root: string, agent: string, command: readonly string[], strict: boolean): GatedReport {
  const name = agent.toLowerCase();
  const server = { command: command[0], args: [...command.slice(1), "serve"], env: { CTC_ROOT: "." } };
  const files: string[] = [];
  const mode = strict ? "strict" : "hook";
  if (name === "claude") {
    const mcpFile = path.join(root, ".mcp.json");
    const mcp = readJson(mcpFile);
    mcp.mcpServers = { ...((mcp.mcpServers as Record<string, unknown>) ?? {}), [SERVER]: server };
    writeJson(mcpFile, mcp);
    const settingsFile = path.join(root, ".claude", "settings.json");
    const settings = readJson(settingsFile);
    const hooks = (settings.hooks as Record<string, unknown>) ?? {};
    hooks.PreToolUse = [{ matcher: NATIVE_EDIT_TOOLS.join("|"), hooks: [{ type: "command", command: `${shellJoin(command)} hook` }] }];
    settings.hooks = hooks;
    const permissions = (settings.permissions as { allow?: string[]; deny?: string[] }) ?? {};
    const gateTools = ["ctc_write_file", "ctc_patch_file", "ctc_read_file", "ctc_apply_fix", "ctc_explain", "ctc_policy"].map((tool) => `mcp__${SERVER}__${tool}`);
    permissions.allow = [...new Set([...(permissions.allow ?? []), ...gateTools])];
    if (strict) permissions.deny = [...new Set([...(permissions.deny ?? []), ...NATIVE_EDIT_TOOLS])];
    else if (permissions.deny) permissions.deny = permissions.deny.filter((tool) => !NATIVE_EDIT_TOOLS.includes(tool));
    settings.permissions = permissions;
    writeJson(settingsFile, settings);
    upsertSection(path.join(root, "CLAUDE.md"), GATE_TEXT);
    files.push(mcpFile, settingsFile, path.join(root, "CLAUDE.md"));
    return { agent: name, files, mode, enforcement: strict ? "Native edit tools denied; edits only via the CTC MCP tools (pre-allowed). The PreToolUse hook stays as a second line." : "Every native edit is gated by the PreToolUse hook (same decision as ctc_write_file)." };
  }
  if (name === "cursor") {
    const mcpFile = path.join(root, ".cursor", "mcp.json");
    const mcp = readJson(mcpFile);
    mcp.mcpServers = { ...((mcp.mcpServers as Record<string, unknown>) ?? {}), [SERVER]: server };
    writeJson(mcpFile, mcp);
    const hooksFile = path.join(root, ".cursor", "hooks.json");
    const hooks = readJson(hooksFile);
    hooks.version = 1;
    hooks.hooks = { ...((hooks.hooks as Record<string, unknown>) ?? {}), preToolUse: [{ command: `${shellJoin(command)} hook --cursor`, matcher: "Write" }] };
    writeJson(hooksFile, hooks);
    files.push(mcpFile, hooksFile);
    if (strict) {
      const rule = path.join(root, ".cursor", "rules", "ctc-gate.mdc");
      fs.mkdirSync(path.dirname(rule), { recursive: true });
      fs.writeFileSync(rule, `---\ndescription: Route every edit through Code Traffic Control\nalwaysApply: true\n---\n${GATE_TEXT}\n`, "utf8");
      files.push(rule);
    }
    return { agent: name, files, mode, enforcement: "Native Write calls are gated by the preToolUse hook. Cursor cannot remove its built-in edit tool from project config" + (strict ? "; an alwaysApply rule redirects the agent to ctc_write_file." : ".") };
  }
  if (name === "copilot") {
    const mcpFile = path.join(root, ".vscode", "mcp.json");
    const mcp = readJson(mcpFile);
    mcp.servers = { ...((mcp.servers as Record<string, unknown>) ?? {}), [SERVER]: { type: "stdio", ...server } };
    writeJson(mcpFile, mcp);
    const instructions = path.join(root, ".github", "copilot-instructions.md");
    upsertSection(instructions, GATE_TEXT);
    const agentFile = path.join(root, ".github", "agents", "ctc-gated.agent.md");
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(
      agentFile,
      `---\ndescription: Copilot agent whose only way to edit files is the Code Traffic Control gate\ntools: ['${SERVER}/*', 'search', 'usages', 'problems', 'changes', 'fetch', 'runTests']\n---\n${GATE_TEXT}\n\nThis agent has no built-in edit tool. Write files only with ctc_write_file or ctc_patch_file.\n`,
      "utf8",
    );
    files.push(mcpFile, instructions, agentFile);
    return { agent: name, files, mode, enforcement: "In the 'ctc-gated' custom agent, edits can only go through the CTC MCP tools (no built-in edit tool in its tool list). Copilot's default agent is advisory (instructions only); use the pre-commit hook or CI check as the backstop." };
  }
  throw new Error(`No gated installer for ${agent}. Use one of ${GATED_AGENTS.join(", ")}.`);
}
