import { Node, type SourceFile } from "ts-morph";

import { simulateSource } from "../../engine/simulate.js";
import { gateViolation, type GateViolation } from "../../schemas/gate.js";
import { baselineText, type Baseline } from "../baseline.js";
import { diffLines } from "../diff.js";

/**
 * EditScopeRule (v0.3): in-file scope creep. When the flight plan lists `allowedEditSymbols` (the
 * functions, classes and members the task is about), an edit that changes or removes an existing
 * declaration that is not on the list is held, even when it adds no export. New declarations are not
 * judged here (export scope, dead code and duplicates cover them); imports are ignored. Naming a class
 * puts all of its members in scope. Plans without the field skip the rule.
 */

interface Declaration {
  name: string;
  owner: string | null;
  text: string;
  startLine: number;
  endLine: number;
}

function normalized(node: Node): string {
  return node.getText().replace(/\s+/g, " ").trim();
}

function declarations(source: SourceFile): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  const add = (name: string | undefined, owner: string | null, node: Node): void => {
    if (!name) return;
    const id = owner ? `${owner}.${name}` : name;
    if (out.has(id)) {
      // Overloads: one entry per name, all bodies joined.
      const existing = out.get(id);
      if (existing) {
        existing.text += `\n${normalized(node)}`;
        existing.endLine = node.getEndLineNumber();
      }
      return;
    }
    out.set(id, { name, owner, text: normalized(node), startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() });
  };
  for (const statement of source.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) add(statement.getName(), null, statement);
    else if (Node.isVariableStatement(statement)) for (const decl of statement.getDeclarations()) add(decl.getName(), null, decl);
    else if (Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement) || Node.isEnumDeclaration(statement)) add(statement.getName(), null, statement);
    else if (Node.isClassDeclaration(statement)) {
      const cls = statement.getName() ?? "default";
      const header = statement.getText().slice(0, Math.max(0, statement.getText().indexOf("{")));
      out.set(cls, { name: cls, owner: null, text: header.replace(/\s+/g, " ").trim(), startLine: statement.getStartLineNumber(), endLine: statement.getStartLineNumber() });
      for (const member of statement.getMembers()) {
        if (Node.isConstructorDeclaration(member)) add("constructor", cls, member);
        else if (Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member) || Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) add(member.getName(), cls, member);
      }
    }
  }
  return out;
}

function firstChangedLine(changed: Set<number>, from: number, to: number): number {
  for (let line = from; line <= to; line += 1) if (changed.has(line)) return line;
  return from;
}

function identifiersOn(lines: readonly string[], changed: Set<number>, from: number, to: number): Set<string> {
  const out = new Set<string>();
  for (let line = from; line <= to; line += 1) {
    if (!changed.has(line)) continue;
    for (const match of (lines[line - 1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)) out.add(match[0]);
  }
  return out;
}

/** Member names a planned declaration gained in this edit (e.g. `timeoutMs` added to `RequestOptions`). */
function addedMembers(now: Map<string, Declaration>, was: Map<string, Declaration>, named: (item: Declaration) => boolean): Set<string> {
  const out = new Set<string>();
  for (const [id, item] of now) {
    if (!named(item)) continue;
    const before = was.get(id)?.text ?? "";
    for (const match of item.text.matchAll(/([A-Za-z_$][\w$]*)\??\s*[:(]/g)) {
      const name = match[1];
      if (name && !new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(before)) out.add(name);
    }
  }
  return out;
}

/**
 * v0.4: declarations an edit to the planned symbols legitimately reaches, so the plan does not have to
 * name every one. Two one-hop expansions, both judged on the CHANGED lines only:
 * - type users: a declaration whose changed lines use a planned symbol or a member the edit just added to
 *   one (adding `timeoutMs` to `RequestOptions` and reading `options.timeoutMs` inside `request`);
 * - callees: a declaration called from the changed lines of a planned declaration (a signature change
 *   that the planned function's new call site needs).
 * Unrelated rewrites in the same file still need to be in the plan.
 */
function derivedScope(
  now: Map<string, Declaration>,
  was: Map<string, Declaration>,
  permitted: Set<string>,
  named: (item: Declaration) => boolean,
  changed: Set<number>,
  lines: readonly string[],
): Set<string> {
  // Only planned names that are real declarations in this file anchor the expansion (task text is full of
  // ordinary words), plus members the edit added to them.
  const declared = new Set<string>();
  for (const item of [...now.values(), ...was.values()]) if (named(item)) declared.add(item.name);
  const anchors = new Set<string>([...declared, ...addedMembers(now, was, named)]);
  const calledFromPlanned = new Set<string>();
  for (const item of now.values()) {
    if (!named(item)) continue;
    const text = lines.slice(item.startLine - 1, item.endLine).filter((_, index) => changed.has(item.startLine + index)).join("\n");
    for (const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (match[1]) calledFromPlanned.add(match[1]);
  }
  const out = new Set<string>();
  for (const [id, item] of now) {
    if (named(item)) continue;
    const used = identifiersOn(lines, changed, item.startLine, item.endLine);
    if ([...anchors].some((name) => used.has(name)) || calledFromPlanned.has(item.name)) out.add(id);
  }
  return out;
}

export function editScopeRule(root: string, source: SourceFile, relativePath: string, allowed: readonly string[] | undefined, baseline: Baseline): GateViolation[] {
  if (!allowed) return [];
  const before = baselineText(root, relativePath, baseline);
  if (before === null) return [];
  const old = simulateSource(relativePath, before);
  if (!old) return [];
  const permitted = new Set(allowed);
  const was = declarations(old);
  const now = declarations(source);
  const after = source.getFullText();
  const changed = diffLines(before, after).changedNewLines;
  const lines = after.split("\n");
  const named = (item: Declaration): boolean => permitted.has(item.name) || (item.owner !== null && permitted.has(item.owner)) || permitted.has(item.owner ? `${item.owner}.${item.name}` : item.name);
  const derived = derivedScope(now, was, permitted, named, changed, lines);
  const inScope = (item: Declaration): boolean => named(item) || derived.has(item.owner ? `${item.owner}.${item.name}` : item.name);
  const violations: GateViolation[] = [];
  const list = [...permitted].slice(0, 8).join(", ") + (permitted.size > 8 ? ", ..." : "");
  for (const [id, item] of was) {
    if (inScope(item)) continue;
    const next = now.get(id);
    if (next && next.text === item.text) continue;
    if (!next) {
      violations.push(
        gateViolation({
          rule: "EditScopeRule",
          code: "EDIT_OUTSIDE_PLAN_SCOPE",
          file: relativePath,
          line: 1,
          column: 1,
          message: `This edit removes or renames '${id}', which is outside the task's scope (flight plan allowedEditSymbols: ${list}).`,
          fix: `Leave '${id}' unchanged, or add it to the flight plan if the task really needs it.`,
        }),
      );
      continue;
    }
    violations.push(
      gateViolation({
        rule: "EditScopeRule",
        code: "EDIT_OUTSIDE_PLAN_SCOPE",
        file: relativePath,
        line: firstChangedLine(changed, next.startLine, next.endLine),
        column: 1,
        message: `Unrequested change: '${id}' is modified, but the task is scoped to ${list} (flight plan allowedEditSymbols). Out-of-scope edits change behaviour nobody asked for.`,
        fix: `Revert the change to '${id}', or put it in a separate, planned task.`,
      }),
    );
  }
  return violations;
}
