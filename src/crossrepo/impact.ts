import fs from "node:fs";
import path from "node:path";

import type { ExtensionInput } from "../gate/extensions.js";
import { languageOf, type Language } from "../lang/lines.js";
import { outline } from "../lang/outline.js";
import { effectivePolicy } from "../policy/policy.js";
import type { GateViolation } from "../schemas/gate.js";

/**
 * CrossRepoImpact (v0.4 item 10). Sibling repos are listed in policy (`crossRepo.siblings`). When a write removes,
 * renames or changes the arity of something this repo exports, every sibling that imports this repo's package and
 * uses that name is found on disk and named in the hold — file and line — before the change lands.
 *
 * Package identity: package.json `name` (TS/JS), go.mod `module` (Go), the top-level package directory (Python).
 * Removing a used export blocks (CROSS_REPO_BREAK). A changed signature that a consumer calls warns
 * (CROSS_REPO_SIGNATURE) because the arity heuristic cannot see defaults or overloads.
 */

export interface ExportInfo {
  name: string;
  /** Required parameter count, when the export is a function. */
  arity: number | null;
  line: number;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".venv", "venv", "__pycache__", "vendor", ".next", ".ctc", "target"]);

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function requiredArity(params: string): number {
  let depth = 0;
  const parts: string[] = [];
  let current = "";
  for (const char of params) {
    if ("([{<".includes(char)) depth += 1;
    if (")]}>".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.filter((part) => {
    const text = part.trim();
    if (!text || text === "self" || text === "cls" || text.startsWith("*") || text.startsWith("...")) return false;
    if (/^\w+\s*\?/.test(text) || /=/.test(text.replace(/=>/g, ""))) return false;
    return true;
  }).length;
}

export function exportsOf(language: Language, text: string): Map<string, ExportInfo> {
  const out = new Map<string, ExportInfo>();
  const lines = text.split("\n");
  const add = (name: string, line: number, arity: number | null): void => {
    if (!out.has(name)) out.set(name, { name, arity, line });
  };
  if (language === "ts" || language === "js") {
    lines.forEach((raw, index) => {
      const fn = raw.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)?/);
      if (fn?.[1]) return add(fn[1], index + 1, requiredArity(fn[2] ?? ""));
      const arrow = raw.match(/^\s*export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>)?\(([^)]*)\)\s*(?::[^=]+)?=>/);
      if (arrow?.[1]) return add(arrow[1], index + 1, requiredArity(arrow[2] ?? ""));
      const decl = raw.match(/^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|class|interface|type|enum)\s+(\w+)/);
      if (decl?.[1]) return add(decl[1], index + 1, null);
      const list = raw.match(/^\s*export\s*\{([^}]*)\}/);
      if (list?.[1]) for (const part of list[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^\w+$/.test(name) && name !== "default") add(name, index + 1, null);
      }
      return undefined;
    });
  } else if (language === "python") {
    const info = outline("python", text);
    for (const fn of info.functions) {
      if (fn.qualified.includes(".") || fn.name.startsWith("_")) continue;
      const params = fn.text.match(/^\s*(?:async\s+)?def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->[^:]+)?:/)?.[1] ?? "";
      add(fn.name, fn.start, requiredArity(params));
    }
    for (const name of info.topLevel) if (!name.startsWith("_") && /^[A-Z]/.test(name) && !info.imports.some((item) => item.names.includes(name) || item.local === name)) add(name, 0, null);
  } else if (language === "go") {
    const info = outline("go", text);
    for (const fn of info.functions) {
      if (fn.qualified.includes(".") || !/^[A-Z]/.test(fn.name)) continue;
      const params = fn.text.match(/^func\s+\w+\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/)?.[1] ?? "";
      add(fn.name, fn.start, params.trim() ? params.split(",").length : 0);
    }
    for (const name of info.topLevel) if (/^[A-Z]/.test(name)) add(name, 0, null);
  }
  return out;
}

interface Identity {
  language: Language;
  /** What a consumer's import must match: npm package name, Go import path of the file's package, Python top-level package. */
  importPrefix: string;
}

function identity(root: string, relativePath: string, language: Language): Identity | null {
  if (language === "ts" || language === "js") {
    for (let dir = path.dirname(path.join(root, relativePath)); ; dir = path.dirname(dir)) {
      const pkg = read(path.join(dir, "package.json"));
      if (pkg) {
        try {
          const name = (JSON.parse(pkg) as { name?: unknown }).name;
          if (typeof name === "string" && name) return { language, importPrefix: name };
        } catch {
          return null;
        }
      }
      if (path.resolve(dir) === path.resolve(root) || path.dirname(dir) === dir) return null;
    }
  }
  if (language === "go") {
    for (let dir = path.dirname(path.join(root, relativePath)); ; dir = path.dirname(dir)) {
      const mod = read(path.join(dir, "go.mod"))?.match(/^module\s+(\S+)/m)?.[1];
      if (mod) {
        const rel = path.relative(dir, path.dirname(path.join(root, relativePath))).split(path.sep).join("/");
        return { language, importPrefix: rel ? `${mod}/${rel}` : mod };
      }
      if (path.resolve(dir) === path.resolve(root) || path.dirname(dir) === dir) return null;
    }
  }
  if (language === "python") {
    const parts = relativePath.split("/");
    const start = parts[0] === "src" || parts[0] === "lib" ? 1 : 0;
    const top = parts[start];
    if (!top || parts.length - start < 2) return null;
    return { language, importPrefix: top };
  }
  return null;
}

interface Consumer {
  file: string;
  line: number;
  calls: number[];
}

const scanCache = new Map<string, { at: number; files: Array<{ rel: string; text: string }> }>();

function siblingFiles(siblingRoot: string, language: Language): Array<{ rel: string; text: string }> {
  const key = `${siblingRoot}\u0000${language}`;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  const files: Array<{ rel: string; text: string }> = [];
  const exts = language === "python" ? [".py"] : language === "go" ? [".go"] : [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const visit = (dir: string): void => {
    if (files.length > 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) visit(path.join(dir, entry.name));
      } else if (exts.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
        const absolute = path.join(dir, entry.name);
        const text = read(absolute);
        if (text !== null && text.length < 1_000_000) files.push({ rel: path.relative(siblingRoot, absolute).split(path.sep).join("/"), text });
      }
    }
  };
  visit(siblingRoot);
  scanCache.set(key, { at: Date.now(), files });
  return files;
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function findConsumers(siblingRoot: string, who: Identity, name: string): Consumer[] {
  const out: Consumer[] = [];
  const prefix = escape(who.importPrefix);
  for (const file of siblingFiles(siblingRoot, who.language)) {
    const text = file.text;
    let uses: RegExp;
    if (who.language === "ts" || who.language === "js") {
      const imports = new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)['"]${prefix}(?:/[^'"]*)?['"]`);
      if (!imports.test(text)) continue;
      uses = new RegExp(`\\b${escape(name)}\\b`);
    } else if (who.language === "go") {
      const spec = text.match(new RegExp(`(?:^|\\n)\\s*(?:import\\s+)?(\\w+\\s+)?"${prefix}"`));
      if (!spec) continue;
      const local = spec[1]?.trim() || who.importPrefix.split("/").pop() || "";
      uses = new RegExp(`\\b${escape(local)}\\.${escape(name)}\\b`);
    } else {
      if (!new RegExp(`^\\s*(?:from\\s+${prefix}(?:\\.[\\w.]+)?\\s+import\\b|import\\s+${prefix}\\b)`, "m").test(text)) continue;
      uses = new RegExp(`\\b${escape(name)}\\b`);
    }
    const lines = text.split("\n");
    const hits: number[] = [];
    const calls: number[] = [];
    lines.forEach((lineText, index) => {
      if (!uses.test(lineText)) return;
      hits.push(index + 1);
      if (new RegExp(`\\b${escape(name)}\\s*\\(`).test(lineText)) calls.push(index + 1);
    });
    if (hits.length > 0) out.push({ file: file.rel, line: hits.find((line) => !/^\s*(import|from)\b/.test(lines[line - 1] ?? "")) ?? hits[0] ?? 1, calls });
  }
  return out;
}

export function crossRepoViolations(input: ExtensionInput): GateViolation[] {
  const siblings = input.policy.siblings;
  if (siblings.length === 0 || input.before === null) return [];
  const language = languageOf(input.relativePath);
  if (language === "other") return [];
  if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/.test(input.relativePath)) return [];
  const before = exportsOf(language, input.before);
  if (before.size === 0) return [];
  const after = exportsOf(language, input.after);
  const removed = [...before.values()].filter((item) => !after.has(item.name));
  const changed = [...before.values()].filter((item) => {
    const next = after.get(item.name);
    return next && item.arity !== null && next.arity !== null && next.arity !== item.arity;
  });
  if (removed.length === 0 && changed.length === 0) return [];
  const who = identity(input.root, input.relativePath, language);
  if (!who) return [];
  const out: GateViolation[] = [];
  for (const sibling of siblings) {
    if (!fs.existsSync(sibling.path)) {
      out.push({ rule: "CrossRepoImpact", code: "CROSS_REPO_SIBLING_MISSING", file: input.relativePath, line: null, column: null, message: `Sibling repo '${sibling.name}' (${sibling.path}, from ${sibling.source}) is not on disk, so its consumers were not checked.`, fix: "Check the sibling out next to this repo, or fix crossRepo.siblings in the policy.", severity: "warn" });
      continue;
    }
    for (const item of removed) {
      const consumers = findConsumers(sibling.path, who, item.name);
      if (consumers.length === 0) continue;
      const shown = consumers.slice(0, 5).map((c) => `${sibling.name}/${c.file}:${c.line}`).join(", ");
      out.push({
        rule: "CrossRepoImpact",
        code: "CROSS_REPO_BREAK",
        file: input.relativePath,
        line: null,
        column: null,
        message: `This edit removes export '${item.name}' (was line ${item.line}), and sibling repo '${sibling.name}' uses it through '${who.importPrefix}': ${shown}${consumers.length > 5 ? ` and ${consumers.length - 5} more` : ""}.`,
        fix: `Keep '${item.name}' (a deprecated alias is enough), or update ${sibling.name} in a coordinated change first.`,
      });
    }
    for (const item of changed) {
      const consumers = findConsumers(sibling.path, who, item.name).filter((c) => c.calls.length > 0);
      if (consumers.length === 0) continue;
      const next = after.get(item.name);
      out.push({
        rule: "CrossRepoImpact",
        code: "CROSS_REPO_SIGNATURE",
        file: input.relativePath,
        line: next?.line ?? null,
        column: null,
        message: `'${item.name}' now takes ${next?.arity} required parameter(s) instead of ${item.arity}; sibling repo '${sibling.name}' calls it at ${consumers.slice(0, 5).map((c) => `${sibling.name}/${c.file}:${c.calls[0]}`).join(", ")}.`,
        fix: `Keep the old parameter list working (optional parameter or overload), or update ${sibling.name} in the same change.`,
        severity: "warn",
      });
    }
  }
  return out;
}

/** `ctc impact <file>`: every export of a file and where sibling repos use it. */
export function impactOf(root: string, relativePath: string): { file: string; siblings: string[]; missing: string[]; exports: Array<ExportInfo & { consumers: Array<{ sibling: string; file: string; line: number }> }> } {
  const policy = effectivePolicy(root, relativePath);
  const language = languageOf(relativePath);
  const text = read(path.join(root, relativePath)) ?? "";
  const who = language === "other" ? null : identity(root, relativePath, language);
  const present = policy.siblings.filter((item) => fs.existsSync(item.path));
  const exports = language === "other" ? [] : [...exportsOf(language, text).values()];
  return {
    file: relativePath,
    siblings: policy.siblings.map((item) => item.name),
    missing: policy.siblings.filter((item) => !fs.existsSync(item.path)).map((item) => item.name),
    exports: exports.map((item) => ({ ...item, consumers: who ? present.flatMap((sibling) => findConsumers(sibling.path, who, item.name).map((c) => ({ sibling: sibling.name, file: c.file, line: c.line }))) : [] })),
  };
}
