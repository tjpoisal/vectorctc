/**
 * Small line diff used by the diff-aware v0.3 rules and the semantic reviewer. Longest-common-subsequence on
 * lines, with the common prefix and suffix trimmed first so typical agent edits stay cheap. Inputs over
 * MAX_CELLS fall back to "every differing middle line changed", which is conservative (more lines count as changed).
 */
const MAX_CELLS = 4_000_000;

export interface LineChange {
  /** 1-based line in the old text, or null for an insertion. */
  oldLine: number | null;
  /** 1-based line in the new text, or null for a deletion. */
  newLine: number | null;
  oldText: string | null;
  newText: string | null;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  removed: Array<{ line: number; text: string }>;
  added: Array<{ line: number; text: string }>;
}

export interface LineDiff {
  /** 1-based lines of the new text that were added or modified. */
  changedNewLines: Set<number>;
  hunks: Hunk[];
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string | null, after: string): LineDiff {
  const b = before === null ? [] : splitLines(before);
  const a = splitLines(after);
  let prefix = 0;
  while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < b.length - prefix && suffix < a.length - prefix && b[b.length - 1 - suffix] === a[a.length - 1 - suffix]) suffix += 1;
  const bm = b.slice(prefix, b.length - suffix);
  const am = a.slice(prefix, a.length - suffix);
  const ops: Array<{ kind: "same" | "del" | "add"; oldIndex: number; newIndex: number }> = [];
  if (bm.length * am.length <= MAX_CELLS) {
    const rows = bm.length + 1;
    const cols = am.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = bm.length - 1; i >= 0; i -= 1) {
      for (let j = am.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = bm[i] === am[j] ? (table[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < bm.length && j < am.length) {
      if (bm[i] === am[j]) {
        ops.push({ kind: "same", oldIndex: i, newIndex: j });
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
        ops.push({ kind: "del", oldIndex: i, newIndex: j });
        i += 1;
      } else {
        ops.push({ kind: "add", oldIndex: i, newIndex: j });
        j += 1;
      }
    }
    while (i < bm.length) ops.push({ kind: "del", oldIndex: i++, newIndex: j });
    while (j < am.length) ops.push({ kind: "add", oldIndex: i, newIndex: j++ });
  } else {
    for (let i = 0; i < bm.length; i += 1) ops.push({ kind: "del", oldIndex: i, newIndex: 0 });
    for (let j = 0; j < am.length; j += 1) ops.push({ kind: "add", oldIndex: bm.length, newIndex: j });
  }
  const changedNewLines = new Set<number>();
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === "same") {
      current = null;
      continue;
    }
    if (!current) {
      current = { oldStart: prefix + op.oldIndex + 1, newStart: prefix + op.newIndex + 1, removed: [], added: [] };
      hunks.push(current);
    }
    if (op.kind === "del") current.removed.push({ line: prefix + op.oldIndex + 1, text: bm[op.oldIndex] ?? "" });
    else {
      const line = prefix + op.newIndex + 1;
      current.added.push({ line, text: am[op.newIndex] ?? "" });
      changedNewLines.add(line);
    }
  }
  return { changedNewLines, hunks };
}

/** Unified-diff text (3 lines of context) for prompts and reports. */
export function unifiedDiff(file: string, before: string | null, after: string, context = 3): string {
  const { hunks } = diffLines(before, after);
  if (hunks.length === 0) return "";
  const b = before === null ? [] : splitLines(before);
  const a = splitLines(after);
  const out = [`--- ${before === null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    const oldFrom = Math.max(1, hunk.oldStart - context);
    const newFrom = Math.max(1, hunk.newStart - context);
    const lead = hunk.newStart - newFrom;
    const oldEnd = hunk.oldStart + hunk.removed.length - 1;
    const newEnd = hunk.newStart + hunk.added.length - 1;
    const trail = Math.min(context, a.length - newEnd, b.length - oldEnd);
    out.push(`@@ -${oldFrom},${lead + hunk.removed.length + Math.max(0, trail)} +${newFrom},${lead + hunk.added.length + Math.max(0, trail)} @@`);
    for (let k = newFrom; k < hunk.newStart; k += 1) out.push(` ${a[k - 1] ?? ""}`);
    for (const line of hunk.removed) out.push(`-${line.text}`);
    for (const line of hunk.added) out.push(`+${line.text}`);
    for (let k = 1; k <= trail; k += 1) out.push(` ${a[newEnd + k - 1] ?? ""}`);
  }
  return `${out.join("\n")}\n`;
}
