import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Language as TsLanguage, Node as TsNode, Parser as TsParser, Tree } from "web-tree-sitter";

/**
 * Tree-sitter grammars for the language-agnostic rules (Python, Go).
 *
 * web-tree-sitter is async to initialise, the gate is synchronous, so grammars are loaded once per process by
 * `ensureGrammar` (the async CLI / MCP entry points call it before gating a .py / .go file) and parsing is
 * synchronous afterwards. When a grammar is not loaded the rules fall back to a line-based outline and say so.
 */

export type GrammarId = "python" | "go";
export type SyntaxNode = TsNode;

const here = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR_DIR = [path.resolve(here, "../../data/grammars"), path.resolve(here, "../data/grammars")].find((dir) => fs.existsSync(dir)) ?? path.resolve(here, "../../data/grammars");

let init: Promise<typeof import("web-tree-sitter") | null> | null = null;
const languages = new Map<GrammarId, TsLanguage>();
const parsers = new Map<GrammarId, TsParser>();
const failures = new Map<GrammarId, string>();

function runtime(): Promise<typeof import("web-tree-sitter") | null> {
  if (!init) {
    init = (async () => {
      try {
        const mod = await import("web-tree-sitter");
        await mod.Parser.init();
        return mod;
      } catch (error) {
        failures.set("python", String(error));
        failures.set("go", String(error));
        return null;
      }
    })();
  }
  return init;
}

/** The vendored grammar: the .wasm file, or its base64 text copy (.wasm.b64) in checkouts that store it as text. */
export function grammarBytes(id: GrammarId, dir = GRAMMAR_DIR): Buffer {
  const wasm = path.join(dir, `tree-sitter-${id}.wasm`);
  if (fs.existsSync(wasm)) return fs.readFileSync(wasm);
  return Buffer.from(fs.readFileSync(`${wasm}.b64`, "utf8").replace(/\s+/g, ""), "base64");
}

/** Load one grammar (idempotent). Resolves false when the runtime or grammar is unavailable. */
export async function ensureGrammar(id: GrammarId): Promise<boolean> {
  if (process.env.CTC_TREE_SITTER === "off") return false;
  if (parsers.has(id)) return true;
  const mod = await runtime();
  if (!mod) return false;
  try {
    const language = languages.get(id) ?? (await mod.Language.load(grammarBytes(id)));
    languages.set(id, language);
    const parser = new mod.Parser();
    parser.setLanguage(language);
    parsers.set(id, parser);
    return true;
  } catch (error) {
    failures.set(id, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Load the grammar a path needs, if any. */
export async function ensureGrammarFor(relativePath: string): Promise<void> {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === ".py" || ext === ".pyi") await ensureGrammar("python");
  else if (ext === ".go") await ensureGrammar("go");
}

export function grammarLoaded(id: GrammarId): boolean {
  return parsers.has(id);
}

export function grammarStatus(): Record<GrammarId, string> {
  const status = (id: GrammarId): string => (parsers.has(id) ? "tree-sitter" : failures.has(id) ? `fallback (${failures.get(id)})` : "fallback (not loaded)");
  return { python: status("python"), go: status("go") };
}

/** Parse synchronously, or null when the grammar has not been loaded in this process. */
export function parseSync(id: GrammarId, text: string): Tree | null {
  const parser = parsers.get(id);
  if (!parser) return null;
  return parser.parse(text);
}

export function walk(node: SyntaxNode, visit: (node: SyntaxNode) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) if (child) walk(child, visit);
}

/** CLI start-up: load grammars only when the invocation can touch Python or Go (keeps TS-only runs at zero cost). */
export async function preloadForInvocation(argv: readonly string[], cwd: string): Promise<void> {
  const text = argv.join(" ");
  const wantsPy = /\.pyi?\b/.test(text) || ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((name) => fs.existsSync(path.join(cwd, name)));
  const wantsGo = /\.go\b/.test(text) || fs.existsSync(path.join(cwd, "go.mod"));
  await Promise.all([wantsPy ? ensureGrammar("python") : Promise.resolve(false), wantsGo ? ensureGrammar("go") : Promise.resolve(false)]);
}
