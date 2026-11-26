import fs from "node:fs";
import path from "node:path";
import { Node, type SourceFile } from "ts-morph";

import { pathMatches } from "../match.js";
import { simulateSource } from "../simulate.js";
import { toPosix } from "../../paths.js";
import {
  fingerprint,
  isFunctionLike,
  jaccardSimilarity,
  minHashAgreement,
  type FunctionLikeNode,
  type SubtreeFingerprint,
} from "./ast-hasher.js";

export interface IndexedUtility {
  fingerprint: SubtreeFingerprint;
  symbolName: string;
  /** Repo-relative posix path used as the module specifier. */
  filePath: string;
  line: number;
}

export interface SimilarityMatch {
  utility: IndexedUtility;
  similarity: number;
  matchType: "EXACT" | "NEAR_DUPLICATE";
}

export interface IndexOptions {
  minNodeCount: number;
  shingleSize: number;
  permutations: number;
  warnThreshold: number;
}

const caches = new Map<string, UtilityIndex>();

export class UtilityIndex {
  private entries: IndexedUtility[] = [];

  constructor(private readonly options: IndexOptions) {}

  replaceFile(relativePath: string, source: SourceFile | null): void {
    const filePath = toPosix(relativePath);
    this.entries = this.entries.filter((entry) => entry.filePath !== filePath);
    if (!source) return;
    for (const [exportName, declarations] of source.getExportedDeclarations()) {
      for (const declaration of declarations) {
        const fn = extractFunction(declaration);
        if (!fn) continue;
        const printed = fingerprint(fn, this.options.shingleSize, this.options.permutations);
        if (!printed.exactHash || printed.nodeCount < this.options.minNodeCount) continue;
        this.entries.push({
          fingerprint: printed,
          symbolName: exportName,
          filePath,
          line: fn.getStartLineNumber(),
        });
      }
    }
  }

  findSimilar(printed: SubtreeFingerprint, symbolName: string, filePath: string): SimilarityMatch | null {
    let best: SimilarityMatch | null = null;
    for (const entry of this.entries) {
      if (entry.filePath === filePath && entry.symbolName === symbolName) continue;
      if (entry.fingerprint.exactHash && entry.fingerprint.exactHash === printed.exactHash) {
        return { utility: entry, similarity: 1, matchType: "EXACT" };
      }
      if (this.entries.length > 500) {
        const agreement = minHashAgreement(printed.minHashSignature, entry.fingerprint.minHashSignature);
        if (agreement + 0.15 < this.options.warnThreshold) continue;
      }
      const similarity = jaccardSimilarity(printed.shingles, entry.fingerprint.shingles);
      if (similarity < this.options.warnThreshold) continue;
      if (!best || similarity > best.similarity) {
        best = { utility: entry, similarity, matchType: similarity === 1 ? "EXACT" : "NEAR_DUPLICATE" };
      }
    }
    return best;
  }
}

function extractFunction(node: Node): FunctionLikeNode | null {
  if (isFunctionLike(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init && isFunctionLike(init)) return init;
  }
  return null;
}

function listSourceFiles(root: string, globs: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === ".ctc") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = toPosix(path.relative(root, absolute));
      if (globs.some((pattern) => pathMatches(relative, pattern))) found.push(relative);
    }
  };
  walk(root);
  return found;
}

export function utilityIndexFor(root: string, globs: readonly string[], options: IndexOptions): UtilityIndex {
  const key = root;
  let index = caches.get(key);
  if (!index) {
    index = new UtilityIndex(options);
    for (const relative of listSourceFiles(root, globs)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, relative), "utf8");
      } catch {
        continue;
      }
      const source = simulateSource(relative, text);
      index.replaceFile(relative, source);
    }
    caches.set(key, index);
  }
  return index;
}

export function rememberUtility(root: string, relativePath: string, content: string, globs: readonly string[], options: IndexOptions): void {
  if (!globs.some((pattern) => pathMatches(relativePath, pattern))) return;
  const index = utilityIndexFor(root, globs, options);
  index.replaceFile(relativePath, simulateSource(relativePath, content));
}

export function moduleSpecifier(relativePath: string): string {
  return toPosix(relativePath).replace(/^\.\//, "");
}

export function clearUtilityIndexForTests(root?: string): void {
  if (root) caches.delete(root);
  else caches.clear();
}
