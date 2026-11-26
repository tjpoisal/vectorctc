import path from "node:path";
import { Node, SyntaxKind, type Project, type Signature, type SourceFile, type Type } from "ts-morph";

import { toPosix } from "../../paths.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";
import { diffLines } from "../diff.js";

/** Diagnostics a caller gets when an export it uses disappears or changes shape. */
const CALLER_CODES = new Set([2305, 2724, 2614, 2459, 2460, 2339, 2551, 2345, 2554, 2555, 2556, 2322, 2741, 2353, 2769, 2349, 2559, 2739, 2740]);
const MAX_CALLERS = 60;

interface ExportShape {
  line: number;
  shape: string;
}

function signatureText(signature: Signature, at: Node): string {
  const params = signature.getParameters().map((param) => {
    const declaration = param.getValueDeclaration();
    const optional = declaration && Node.isParameterDeclaration(declaration) ? declaration.isOptional() || declaration.isRestParameter() : false;
    return `${optional ? "?" : ""}${param.getTypeAtLocation(at).getText(at)}`;
  });
  return `(${params.join(",")})=>${signature.getReturnType().getText(at)}`;
}

/** Text that changes when a caller-visible part of the type changes: call and construct signatures and members. */
function describeType(type: Type, at: Node): string[] {
  const parts = [type.getText(at)];
  for (const signature of type.getCallSignatures()) parts.push(`call ${signatureText(signature, at)}`);
  for (const signature of type.getConstructSignatures()) {
    parts.push(`new ${signatureText(signature, at)}`);
    for (const member of signature.getReturnType().getProperties()) parts.push(`.${member.getName()}:${member.getTypeAtLocation(at).getText(at)}`);
  }
  if (type.isObject() && type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0) {
    for (const member of type.getProperties()) parts.push(`.${member.getName()}:${member.getTypeAtLocation(at).getText(at)}`);
  }
  return parts;
}

function exportShapes(source: SourceFile): Map<string, ExportShape> {
  const shapes = new Map<string, ExportShape>();
  for (const [name, declarations] of source.getExportedDeclarations()) {
    const parts: string[] = [];
    let line = 1;
    for (const declaration of declarations) {
      if (declaration.getSourceFile() === source) line = declaration.getStartLineNumber();
      try {
        parts.push(...describeType(declaration.getType(), declaration));
      } catch {
        parts.push(declaration.getText());
      }
    }
    shapes.set(name, { line, shape: parts.join("\n") });
  }
  return shapes;
}

function isReexporter(file: SourceFile, target: SourceFile): boolean {
  return file.getExportDeclarations().some((item) => item.getModuleSpecifierSourceFile() === target);
}

/** Files that import the module directly, plus callers of barrels that re-export it (one level). */
function callersOf(source: SourceFile): SourceFile[] {
  const out = new Set<SourceFile>();
  for (const file of source.getReferencingSourceFiles()) {
    if (file === source || file.isDeclarationFile() || file.isInNodeModules()) continue;
    out.add(file);
    if (isReexporter(file, source)) {
      for (const outer of file.getReferencingSourceFiles()) {
        if (outer !== source && !outer.isDeclarationFile() && !outer.isInNodeModules()) out.add(outer);
      }
    }
    if (out.size >= MAX_CALLERS) break;
  }
  return [...out].slice(0, MAX_CALLERS);
}

interface CallerDiagnostic {
  file: SourceFile;
  line: number;
  code: number;
  message: string;
  /** Identifiers at or around the diagnostic, used to find which export the caller was using. */
  names: string[];
}

/** Every identifier in the expression the diagnostic points at (walking up to the enclosing call or access). */
function namesAt(file: SourceFile, start: number | undefined): string[] {
  if (start === undefined) return [];
  let node: Node | undefined = file.getDescendantAtPos(start);
  const names = new Set<string>();
  for (let depth = 0; node && depth < 6; depth += 1) {
    if (Node.isIdentifier(node)) names.add(node.getText());
    if (Node.isCallExpression(node) || Node.isNewExpression(node) || Node.isPropertyAccessExpression(node) || Node.isImportSpecifier(node)) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) names.add(id.getText());
      if (Node.isCallExpression(node) || Node.isNewExpression(node)) break;
    }
    node = node.getParent();
  }
  return [...names];
}

function diagnosticKeys(files: SourceFile[], project: Project): Map<string, CallerDiagnostic> {
  const keys = new Map<string, CallerDiagnostic>();
  const program = project.getProgram();
  for (const file of files) {
    let diagnostics: ReturnType<typeof program.getSemanticDiagnostics> = [];
    try {
      diagnostics = program.getSemanticDiagnostics(file);
    } catch {
      continue;
    }
    for (const diagnostic of diagnostics) {
      const code = diagnostic.getCode();
      if (!CALLER_CODES.has(code)) continue;
      const text = diagnostic.getMessageText();
      const message = typeof text === "string" ? text : text.getMessageText();
      const line = diagnostic.getLineNumber() ?? 1;
      keys.set(`${file.getFilePath()}|${line}|${code}|${message}`, { file, line, code, message, names: namesAt(file, diagnostic.getStart()) });
    }
  }
  return keys;
}

/**
 * Cross-file breaking change: when an exported name disappears or its type changes, type-check every
 * file that imports this module (in the tsconfig project) against the old and the new text. Errors
 * that only appear with the new text are callers this edit breaks. The violation is reported in the
 * file being written, at the changed export, and names the broken caller.
 */
export function breakingChangeRule(root: string, source: SourceFile, project: Project, relativePath: string, baseline: Baseline): GateViolation[] {
  const before = baselineText(root, relativePath, baseline);
  if (before === null) return [];
  const callers = callersOf(source);
  if (callers.length === 0) return [];
  const proposed = source.getFullText();
  const afterShapes = exportShapes(source);
  let beforeShapes: Map<string, ExportShape>;
  let beforeKeys: ReturnType<typeof diagnosticKeys>;
  source.replaceWithText(before);
  try {
    beforeShapes = exportShapes(source);
    const changed = [...beforeShapes].some(([name, shape]) => afterShapes.get(name)?.shape !== shape.shape);
    if (!changed) return [];
    beforeKeys = diagnosticKeys(callers, project);
  } finally {
    source.replaceWithText(proposed);
  }
  const changedNames = [...beforeShapes.keys()].filter((name) => afterShapes.get(name)?.shape !== beforeShapes.get(name)?.shape);
  const violations: GateViolation[] = [];
  const changedLines = [...diffLines(before, proposed).changedNewLines].sort((a, b) => a - b);
  const firstChanged = changedLines[0] ?? 1;
  for (const [key, item] of diagnosticKeys(callers, project)) {
    if (beforeKeys.has(key)) continue;
    const callerPath = toPosix(path.relative(root, item.file.getFilePath()));
    // v0.4: resolve which export the caller was using from the identifiers at the diagnostic, not only
    // from the message text (TS2554 "Expected 2 arguments" names no symbol). Report at that export's line.
    const named =
      changedNames.find((name) => item.message.includes(`'${name}'`)) ??
      changedNames.find((name) => item.names.includes(name)) ??
      (changedNames.length === 1 ? changedNames[0] : undefined);
    const removed = named !== undefined && !afterShapes.has(named);
    const line = named && !removed ? (afterShapes.get(named)?.line ?? firstChanged) : firstChanged;
    violations.push(
      gateViolation({
        rule: "BreakingChangeRule",
        code: "BREAKING_CHANGE",
        file: relativePath,
        line,
        column: 1,
        tsDiagnosticCode: item.code,
        message: `${named ? `${removed ? "Removing" : "Changing"} export '${named}'` : "This change to the module's exports"} breaks caller ${callerPath}:${item.line} (TS${item.code}): ${item.message}`,
        fix: `Keep the exported signature compatible, or update ${callerPath} in the same change.`,
      }),
    );
  }
  return violations;
}
