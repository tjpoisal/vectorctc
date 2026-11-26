import path from "node:path";

import { diffLines } from "../gate/diff.js";

export type Language = "ts" | "js" | "python" | "go" | "other";

export function languageOf(relativePath: string): Language {
  const ext = path.posix.extname(relativePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "js";
  if (ext === ".py" || ext === ".pyi") return "python";
  if (ext === ".go") return "go";
  return "other";
}

export interface ChangedLine {
  line: number;
  text: string;
  /** The line without its trailing comment (best effort, language-aware). */
  code: string;
}

function stripComment(text: string, language: Language): string {
  if (language === "python") return text.replace(/(^|\s)#.*$/, "$1");
  if (language === "other") return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return text.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
}

/** Lines the proposal adds or modifies (all lines for a new file), with comments stripped in `code`. */
export function changedLines(relativePath: string, before: string | null, after: string): ChangedLine[] {
  const language = languageOf(relativePath);
  const lines = after.split("\n");
  const changed = before === null ? lines.map((_, index) => index + 1) : [...diffLines(before, after).changedNewLines].sort((a, b) => a - b);
  return changed.map((line) => {
    const text = lines[line - 1] ?? "";
    return { line, text, code: stripComment(text, language) };
  });
}

/** Import specifiers on one line, per language. */
export function importSpecifiers(text: string, language: Language): string[] {
  const out: string[] = [];
  if (language === "ts" || language === "js") {
    for (const match of text.matchAll(/\bfrom\s+(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)|\brequire\s*\(\s*(['"])([^'"]+)\5\s*\)|^\s*import\s+(['"])([^'"]+)\7/g)) {
      const spec = match[2] ?? match[4] ?? match[6] ?? match[8];
      if (spec) out.push(spec);
    }
  } else if (language === "python") {
    const from = text.match(/^\s*from\s+([\w.]+)\s+import\b/);
    if (from?.[1]) out.push(from[1]);
    const plain = text.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
    if (plain?.[1]) for (const item of plain[1].split(",")) out.push(item.trim().split(/\s+as\s+/)[0] ?? "");
  } else if (language === "go") {
    const single = text.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/);
    if (single?.[1]) out.push(single[1]);
    const inBlock = text.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/);
    if (!single && inBlock?.[1]) out.push(inBlock[1]);
  }
  return out.filter(Boolean);
}
