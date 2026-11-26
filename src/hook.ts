import fs from "node:fs";
import path from "node:path";

import { findProjectRoot } from "./paths.js";
import { reviewWrite } from "./engine/runway-gate.js";
import type { CtcWritePayload } from "./engine/payload.js";
import { checkContent } from "./universal/check.js";
import { resolveContract } from "./universal/contract.js";

export interface HookOutcome {
  permission: "allow" | "deny";
  exitCode: 0 | 2;
  reason: string;
  payload: CtcWritePayload | null;
}

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "strreplace"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function projectRootFor(input: Record<string, unknown>, filePath: string | null): string {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (filePath) {
    const fromFile = findProjectRoot(path.dirname(path.resolve(cwd, filePath)));
    if (fs.existsSync(path.join(fromFile, "ctc.config.json"))) return fromFile;
  }
  return findProjectRoot(cwd);
}

function applyReplacement(original: string, oldText: string, newText: string): string | { error: string } {
  if (oldText === "") return { error: "old_string is empty, so CTC cannot place the edit." };
  const first = original.indexOf(oldText);
  if (first < 0) return { error: "old_string was not found in the current file." };
  const second = original.indexOf(oldText, first + oldText.length);
  if (second >= 0) return { error: "old_string matched more than once. Include more surrounding context." };
  return original.slice(0, first) + newText + original.slice(first + oldText.length);
}

function proposedContent(
  tool: string,
  input: Record<string, unknown>,
  absoluteFile: string,
): { content: string } | { error: string } {
  if (tool === "write") {
    const content = readString(input, ["content", "contents", "new_content"]);
    if (content == null) return { error: "Write tool input has no content string." };
    return { content };
  }
  if (!fs.existsSync(absoluteFile)) {
    return { error: `${absoluteFile} does not exist, so CTC cannot apply the edit in memory.` };
  }
  let current: string;
  try {
    current = fs.readFileSync(absoluteFile, "utf8");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const edits = tool === "multiedit" && Array.isArray(input.edits) ? input.edits : [input];
  let next = current;
  for (const edit of edits) {
    const record = asRecord(edit);
    if (!record) return { error: "Edit list contains a non-object entry." };
    const oldText = readString(record, ["old_string", "old_str", "oldString"]);
    const newText = readString(record, ["new_string", "new_str", "newString"]);
    if (oldText == null || newText == null) return { error: "Edit is missing old_string or new_string." };
    const applied = applyReplacement(next, oldText, newText);
    if (typeof applied !== "string") return applied;
    next = applied;
  }
  return { content: next };
}

function deny(reason: string, payload: CtcWritePayload | null = null): HookOutcome {
  return { permission: "deny", exitCode: 2, reason, payload };
}

function allow(reason: string, payload: CtcWritePayload | null = null): HookOutcome {
  return { permission: "allow", exitCode: 0, reason, payload };
}

/** Evaluate one Claude Code / Cursor pre-tool payload. Does not write the source file. */
export function evaluateHook(raw: unknown): HookOutcome {
  const input = asRecord(raw);
  if (!input) return allow("CTC ignored a hook payload that was not an object.");
  const toolName = typeof input.tool_name === "string" ? input.tool_name : typeof input.toolName === "string" ? input.toolName : "";
  const tool = toolName.toLowerCase();
  if (!WRITE_TOOLS.has(tool)) return allow("CTC does not gate this tool.");
  const toolInput = asRecord(input.tool_input) ?? asRecord(input.toolInput) ?? input;
  const filePath = readString(toolInput, ["file_path", "filePath", "path"]);
  if (!filePath) return deny("CTC denied the write because the tool input has no file path.");
  const root = projectRootFor(input, filePath);
  const absolute = path.resolve(root, filePath);
  const proposed = proposedContent(tool, toolInput, absolute);
  if ("error" in proposed) return deny(`CTC denied the write. ${proposed.error}`);
  const payload = reviewWrite({
    root,
    path: filePath,
    content: proposed.content,
    source: "ctc_hook",
    land: false,
  });
  if (!payload.cleared) return deny(payload.selfCorrection ?? "CTC denied the write.", payload);
  // v0.4: the hook also runs the full gate (v0.3 analyzer + secrets, SAST, SCA, imported rule files,
  // policy) so native agent edits get the same decision as ctc_write_file.
  if (resolveContract(root).ok) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const outcome = checkContent(root, relative, proposed.content, { surface: "hook" });
    if (outcome.exitCode !== 0 && "violations" in outcome.payload) {
      const spec = outcome.payload;
      const next = spec.explain?.nextAction ? `\n\nNext: ${spec.explain.nextAction}` : "";
      return deny(`${spec.selfCorrection ?? "CTC denied the write."}${next}`, spec);
    }
    if ("warnings" in outcome.payload && outcome.payload.warnings.length > 0) return allow(`CTC cleared ${relative} (${outcome.payload.warnings.length} observe-mode finding(s) logged).`, outcome.payload);
  }
  return allow(payload.file ? `CTC cleared ${payload.file}.` : "CTC cleared the write.", payload);
}

export function hookStdout(outcome: HookOutcome, style: "claude" | "cursor" = "claude"): string {
  if (style === "cursor") {
    return JSON.stringify(
      {
        permission: outcome.permission,
        user_message: outcome.reason,
        agent_message: outcome.reason,
      },
      null,
      2,
    );
  }
  const decision = outcome.permission === "allow" ? "allow" : "deny";
  return JSON.stringify(
    {
      decision: outcome.permission === "allow" ? "approve" : "block",
      reason: outcome.reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: outcome.reason,
      },
    },
    null,
    2,
  );
}
