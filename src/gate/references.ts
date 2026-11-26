import fs from "node:fs";
import path from "node:path";
import type { Project } from "ts-morph";

import { toPosix } from "../paths.js";

/**
 * Cheap, deterministic "who uses this name" lookup for the v0.3 rules: project source files (already in
 * memory in the gate's ts-morph project) plus test files on disk (cached by mtime). A text match on
 * `name(` / `name` is enough evidence for a message; it is never used to decide on its own.
 */
const TEST_DIRS = ["test", "tests", "__tests__", "spec"];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORE = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next"]);

interface CachedText {
  mtimeMs: number;
  text: string;
}

const testCache = new Map<string, Map<string, CachedText>>();

function walkTests(root: string, dir: string, out: string[], inTestDir: boolean, depth: number): void {
  if (depth > 6 || out.length > 400) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORE.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTests(root, absolute, out, inTestDir || TEST_DIRS.includes(entry.name), depth + 1);
      continue;
    }
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    if (inTestDir || TEST_FILE.test(entry.name)) out.push(absolute);
  }
}

export function testFiles(rootInput: string): Array<{ relativePath: string; text: string }> {
  const root = path.resolve(rootInput);
  const files: string[] = [];
  walkTests(root, root, files, false, 0);
  let cache = testCache.get(root);
  if (!cache) {
    cache = new Map();
    testCache.set(root, cache);
  }
  const out: Array<{ relativePath: string; text: string }> = [];
  for (const absolute of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    let hit = cache.get(absolute);
    if (!hit || hit.mtimeMs !== stat.mtimeMs) {
      try {
        hit = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(absolute, "utf8") };
      } catch {
        continue;
      }
      cache.set(absolute, hit);
    }
    out.push({ relativePath: toPosix(path.relative(root, absolute)), text: hit.text });
  }
  return out;
}

export interface Reference {
  file: string;
  line: number;
  text: string;
  test: boolean;
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scan(text: string, file: string, pattern: RegExp, test: boolean, out: Reference[], limit: number): void {
  if (!pattern.test(text)) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const line = lines[i] ?? "";
    pattern.lastIndex = 0;
    if (pattern.test(line)) out.push({ file, line: i + 1, text: line.trim().slice(0, 160), test });
  }
}

/** Uses of `name` outside `relativePath`: other project sources first, then tests. */
export function referencesTo(rootInput: string, project: Project | null, relativePath: string, name: string, limit = 12): Reference[] {
  const root = path.resolve(rootInput);
  const pattern = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const out: Reference[] = [];
  const self = path.join(root, relativePath);
  const seen = new Set<string>();
  if (project) {
    for (const file of project.getSourceFiles()) {
      if (out.length >= limit) break;
      const absolute = file.getFilePath();
      if (absolute === self || file.isInNodeModules() || file.isDeclarationFile()) continue;
      const rel = toPosix(path.relative(root, absolute));
      if (rel.startsWith("..")) continue;
      seen.add(path.resolve(absolute));
      scan(file.getFullText(), rel, pattern, TEST_FILE.test(rel) || rel.split("/").some((part) => TEST_DIRS.includes(part)), out, limit);
    }
  }
  for (const file of testFiles(root)) {
    if (out.length >= limit) break;
    if (seen.has(path.join(root, file.relativePath))) continue;
    scan(file.text, file.relativePath, pattern, true, out, limit);
  }
  return out;
}

export function clearReferenceCacheForTests(): void {
  testCache.clear();
}
