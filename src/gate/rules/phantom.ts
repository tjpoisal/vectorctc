import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { Node, type SourceFile } from "ts-morph";

import { simulateSource } from "../../engine/simulate.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";

/**
 * 2339 missing property, 2304 missing name, 2554 wrong arity,
 * 2305 module has no such export, 2307 module/package not found, 2724 no such export (did you mean),
 * 2551 missing property (did you mean), 2552 missing name (did you mean).
 */
const CODES = new Set([2339, 2304, 2554, 2305, 2307, 2724, 2551, 2552]);
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function declaredPackages(root: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => Object.keys(pkg[key] ?? {})));
  } catch {
    return new Set();
  }
}

function packageOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function baselineSpecifiers(root: string, relativePath: string, baseline: Baseline): Set<string> {
  const text = baselineText(root, relativePath, baseline);
  const source = text === null ? null : simulateSource(relativePath, text);
  return new Set(source ? source.getImportDeclarations().map((item) => item.getModuleSpecifierValue()) : []);
}

/**
 * A 2307 is a hallucinated module only when the import is new in this edit, is not a Node built-in,
 * and (for a bare package) is not declared in package.json and node_modules exists. A declared-but-not-installed
 * package, or any package in a checkout with no node_modules, is an environment problem, not an agent mistake,
 * so it does not block.
 */
function isNewUnknownModule(root: string, relativePath: string, baseline: Baseline, specifier: string): boolean {
  if (BUILTINS.has(specifier) || specifier.startsWith("node:")) return false;
  if (baselineSpecifiers(root, relativePath, baseline).has(specifier)) return false;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    if (!fs.existsSync(path.join(root, "node_modules"))) return false;
    if (declaredPackages(root).has(packageOf(specifier))) return false;
  }
  return true;
}

function hint(code: number, message: string): string {
  const meant = message.match(/Did you mean '([^']+)'/);
  if (meant?.[1]) return `Replace the missing symbol with '${meant[1]}'.`;
  if (code === 2554) return "Match the function's required parameter count.";
  if (code === 2307) return "Import only modules that exist in the project or packages declared in package.json.";
  if (code === 2305 || code === 2724) return "Import a name the module actually exports.";
  if (code === 2304) return "Use a name that is declared in this file or imported.";
  return "Use a property that exists on the type.";
}

export function phantomSymbolRule(source: SourceFile, relativePath: string, root?: string, baseline?: Baseline): GateViolation[] {
  let diagnostics: ReturnType<SourceFile["getPreEmitDiagnostics"]> = [];
  try {
    diagnostics = source.getPreEmitDiagnostics();
  } catch {
    return [];
  }
  const found: GateViolation[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const code = diagnostic.getCode();
    if (!CODES.has(code)) continue;
    const messageText = diagnostic.getMessageText();
    const message = typeof messageText === "string" ? messageText : messageText.getMessageText();
    const start = diagnostic.getStart();
    const pos = start == null ? { line: 1, column: 1 } : source.getLineAndColumnAtPos(start);
    const token = start == null ? undefined : source.getDescendantAtPos(start);
    if (code === 2307) {
      const specifier = message.match(/module '([^']+)'/)?.[1];
      if (!specifier || !root || !isNewUnknownModule(root, relativePath, baseline, specifier)) continue;
    }
    const name = token && Node.isIdentifier(token) ? token.getText() : null;
    const key = `${pos.line}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(
      gateViolation({
        rule: "PhantomSymbolRule",
        code: "PHANTOM_SYMBOL",
        file: relativePath,
        line: pos.line,
        column: pos.column,
        tsDiagnosticCode: code,
        message: name ? `TypeScript symbol check failed (TS${code}) at '${name}': ${message}` : `TypeScript symbol check failed (TS${code}): ${message}`,
        fix: hint(code, message),
      }),
    );
  }
  return found;
}
