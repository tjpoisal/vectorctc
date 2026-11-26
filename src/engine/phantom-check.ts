import fs from "node:fs";
import path from "node:path";
import { Node, Project, type Diagnostic, type SourceFile } from "ts-morph";

import { violation, type Violation } from "./types.js";

const PHANTOM_CODES = new Set([2339, 2551, 2304, 2552, 2349, 2305, 2614]);
const SIGNATURE_CODES = new Set([2554, 2555, 2345]);

const projects = new Map<string, Project>();
let busy = false;

export interface PhantomOptions {
  timeoutMs: number;
  strictCallSignatures: boolean;
}

function projectFor(root: string): Project | null {
  const existing = projects.get(root);
  if (existing) return existing;
  const tsconfig = path.join(root, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) return null;
  const project = new Project({
    tsConfigFilePath: tsconfig,
    skipAddingFilesFromTsConfig: false,
  });
  projects.set(root, project);
  return project;
}

function hint(code: number, message: string): string {
  const meant = message.match(/Did you mean '([^']+)'/);
  if (meant?.[1]) return `Replace the missing symbol with '${meant[1]}'.`;
  if (code === 2305 || code === 2614) return "Import a member that the module actually exports.";
  if (code === 2554 || code === 2555) return "Match the function's required parameter count.";
  if (code === 2345) return "Pass an argument that matches the parameter type.";
  return "Use a symbol that exists in this project.";
}

function diagnosticViolations(source: SourceFile, relativePath: string, strict: boolean): Violation[] {
  const found: Violation[] = [];
  let diagnostics: Diagnostic[] = [];
  try {
    diagnostics = source.getPreEmitDiagnostics();
  } catch {
    return [];
  }
  for (const diagnostic of diagnostics) {
    const code = diagnostic.getCode();
    const phantom = PHANTOM_CODES.has(code);
    const signature = strict && SIGNATURE_CODES.has(code);
    if (!phantom && !signature) continue;
    const messageText = diagnostic.getMessageText();
    const message = typeof messageText === "string" ? messageText : messageText.getMessageText();
    const start = diagnostic.getStart();
    const pos = start == null ? { line: 1, column: 1 } : source.getLineAndColumnAtPos(start);
    const token = start == null ? null : source.getDescendantAtPos(start);
    found.push(
      violation({
        code: "PHANTOM_SYMBOL",
        rule: "phantom",
        gate: "ast",
        file: relativePath,
        line: pos.line,
        column: pos.column,
        tsDiagnosticCode: code,
        message: `TypeScript symbol check failed (TS${code}): ${message}`,
        fix: hint(code, message),
        useInstead: hint(code, message),
      }),
    );
    if (token && Node.isIdentifier(token)) {
      found[found.length - 1] = { ...found[found.length - 1]!, message: `TypeScript symbol check failed (TS${code}) at '${token.getText()}': ${message}` };
    }
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.line}:${item.tsDiagnosticCode}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function overlayText(root: string, relativePath: string): string | null {
  const project = projects.get(root);
  if (!project) return null;
  const source = project.getSourceFile(path.resolve(root, relativePath));
  return source?.getFullText() ?? null;
}

/**
 * Overlay proposed text on the real project, read diagnostics, and always roll back.
 * Synchronous on purpose: the typecheck project is not touched across an await.
 * Results that exceed timeoutMs are discarded and replaced with a warning.
 */
export function runPhantomCheck(root: string, relativePath: string, content: string, options: PhantomOptions): Violation[] {
  if (busy) {
    return [
      violation({
        code: "PHANTOM_SKIPPED",
        rule: "phantom",
        gate: "ast",
        file: relativePath,
        line: null,
        column: null,
        severity: "warn",
        message: "Phantom-symbol check skipped because another check is using the typecheck project.",
        fix: "Retry the write.",
      }),
    ];
  }
  const project = projectFor(root);
  if (!project) return [];
  busy = true;
  const absolute = path.resolve(root, relativePath);
  const existing = project.getSourceFile(absolute);
  const original = existing?.getFullText();
  const started = Date.now();
  let created: SourceFile | undefined;
  try {
    const source = existing ?? project.createSourceFile(absolute, content, { overwrite: true });
    if (!existing) created = source;
    else source.replaceWithText(content);
    if (options.timeoutMs <= 0 || Date.now() - started > options.timeoutMs) {
      return [timeoutWarning(relativePath)];
    }
    const violations = diagnosticViolations(source, relativePath, options.strictCallSignatures);
    if (Date.now() - started > options.timeoutMs) return [timeoutWarning(relativePath)];
    return violations;
  } catch {
    return [timeoutWarning(relativePath)];
  } finally {
    try {
      if (created) project.removeSourceFile(created);
      else if (existing && original !== undefined) existing.replaceWithText(original);
    } catch {
      projects.delete(root);
    }
    busy = false;
  }
}

function timeoutWarning(relativePath: string): Violation {
  return violation({
    code: "PHANTOM_TIMEOUT",
    rule: "phantom",
    gate: "ast",
    file: relativePath,
    line: null,
    column: null,
    severity: "warn",
    message: "Phantom-symbol check exceeded its time budget and was discarded.",
    fix: "Retry, or raise rules.phantom.timeoutMs.",
  });
}

export function clearPhantomProjectsForTests(): void {
  projects.clear();
  busy = false;
}
