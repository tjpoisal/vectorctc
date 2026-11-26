import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Explanation } from "../explain/explain.js";
import { unifiedDiff } from "../gate/diff.js";

/**
 * "Why it held" replay (v0.5). For each held or observed decision the gate keeps one local file under
 * .ctc/replays/: the attempted change as a unified diff, the rules broken, their explanations and the suggested
 * fixes. The newest MAX_REPLAYS are kept. A change that tripped a secret rule is stored without its diff, the same
 * way the fix ledger never stores a secret. CTC_REPLAY=off disables it. Nothing leaves the machine.
 */

export const REPLAY_DIR = ".ctc/replays";
export const REPLAY_PROTOCOL = "ctc.replay.v1";
const MAX_REPLAYS = 200;
const MAX_DIFF_BYTES = 256 * 1024;

export interface Replay {
  protocol: typeof REPLAY_PROTOCOL;
  id: string;
  ts: string;
  file: string;
  decision: "held" | "observed";
  surface: string;
  agent: string | null;
  model: string | null;
  /** Unified diff of the file on disk → the attempted content. Null when withheld (secret) or too large. */
  diff: string | null;
  diffWithheld: null | "secret" | "too-large";
  explanations: Explanation[];
}

function dir(root: string): string {
  return path.join(root, REPLAY_DIR);
}

export function replayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CTC_REPLAY !== "off" && env.CTC_REPLAY !== "0";
}

export function newReplayId(seed: string): string {
  return crypto.createHash("sha256").update(`${seed}\u0000${Date.now()}\u0000${Math.random()}`).digest("hex").slice(0, 12);
}

export function saveReplay(
  root: string,
  input: { id: string; file: string; decision: Replay["decision"]; surface: string; agent: string | null; model: string | null; before: string | null; after: string; explanations: readonly Explanation[]; ts?: string },
): Replay | null {
  if (!replayEnabled()) return null;
  try {
    const secret = input.explanations.some((item) => item.fix.sensitive || item.code.startsWith("SECRET_"));
    let diff: string | null = null;
    let diffWithheld: Replay["diffWithheld"] = null;
    if (secret) diffWithheld = "secret";
    else {
      diff = unifiedDiff(input.file, input.before, input.after);
      if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
        diff = null;
        diffWithheld = "too-large";
      }
    }
    const replay: Replay = {
      protocol: REPLAY_PROTOCOL,
      id: input.id,
      ts: input.ts ?? new Date().toISOString(),
      file: input.file,
      decision: input.decision,
      surface: input.surface,
      agent: input.agent,
      model: input.model,
      diff,
      diffWithheld,
      explanations: input.explanations.map((item) => (item.fix.sensitive ? { ...item, fix: { ...item.fix, hunks: [], patch: null } } : item)),
    };
    fs.mkdirSync(dir(root), { recursive: true });
    fs.writeFileSync(path.join(dir(root), `${replay.id}.json`), `${JSON.stringify(replay, null, 2)}\n`, "utf8");
    prune(root);
    return replay;
  } catch {
    return null;
  }
}

function prune(root: string): void {
  const entries = listFiles(root);
  for (const entry of entries.slice(MAX_REPLAYS)) fs.rmSync(entry.path, { force: true });
}

function listFiles(root: string): Array<{ id: string; path: string; mtime: number }> {
  if (!fs.existsSync(dir(root))) return [];
  return fs
    .readdirSync(dir(root))
    .filter((name) => /^[a-f0-9]{6,64}\.json$/.test(name))
    .map((name) => {
      const file = path.join(dir(root), name);
      return { id: name.slice(0, -5), path: file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id));
}

export function listReplays(root: string, limit = 50): Replay[] {
  const out: Replay[] = [];
  for (const entry of listFiles(root)) {
    const replay = readReplayFile(entry.path);
    if (replay) out.push(replay);
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

function readReplayFile(file: string): Replay | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Replay;
    return parsed.protocol === REPLAY_PROTOCOL ? parsed : null;
  } catch {
    return null;
  }
}

/** Load by id or unique id prefix; `last` picks the newest. */
export function loadReplay(root: string, idOrLast: string | { last: true }): Replay | null {
  if (typeof idOrLast !== "string") return listReplays(root, 1)[0] ?? null;
  if (!/^[a-f0-9]{1,64}$/.test(idOrLast)) return null;
  const matches = listFiles(root).filter((entry) => entry.id.startsWith(idOrLast));
  if (matches.length !== 1) return null;
  return readReplayFile(matches[0]!.path);
}

export function renderReplayText(replay: Replay): string {
  const lines: string[] = [];
  lines.push(`Replay ${replay.id} · ${replay.decision.toUpperCase()} · ${replay.file}`);
  lines.push(`When: ${replay.ts}   Surface: ${replay.surface}   Agent: ${replay.agent ?? "unknown"}${replay.model ? `   Model: ${replay.model}` : ""}`);
  lines.push("");
  lines.push("Attempted change:");
  if (replay.diff) lines.push(replay.diff.trimEnd());
  else lines.push(replay.diffWithheld === "secret" ? "(withheld: the change contained a secret, so it was not stored)" : "(withheld: the diff was too large to store)");
  for (const item of replay.explanations) {
    lines.push("");
    lines.push(`Rule broken: ${item.code} (${item.rule}) — ${item.severity}${item.lines ? `, lines ${item.lines.start}-${item.lines.end}` : ""}`);
    lines.push(`What: ${item.message}`);
    lines.push(`Why this rule exists: ${item.why}`);
    lines.push(`Suggested fix (${item.fix.kind}, ${item.fix.confidence}): ${item.fix.summary}`);
    if (item.fix.patch) lines.push(item.fix.patch.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}
