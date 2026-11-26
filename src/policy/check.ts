import path from "node:path";

import { compileSafeRegExp } from "../engine/safe-regex.js";
import { pathMatches } from "../engine/match.js";
import { changedLines, importSpecifiers, languageOf } from "../lang/lines.js";
import { toPosix } from "../paths.js";
import type { GateViolation } from "../schemas/gate.js";
import type { EffectivePolicy } from "./policy.js";
import { importRuleFiles, rulesFor, type CompiledRule } from "./rulefiles.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(target: string): RegExp {
  if (target === "any") return /(:\s*any\b|<any>|\bas\s+any\b|\bany\[\])/;
  const lead = /^\w/.test(target) ? "\\b" : "";
  const trail = /\w$/.test(target) ? "\\b" : "";
  return new RegExp(`${lead}${escapeRegExp(target)}${trail}`);
}

function importHits(spec: string, target: string, relativePath: string): boolean {
  if (spec === target || spec.startsWith(`${target}/`)) return true;
  if (target.includes("/") && (spec.startsWith(".") || spec.startsWith("/"))) {
    const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(relativePath)), spec)));
    const goal = target.replace(/\/\*\*$/, "").replace(/\/$/, "");
    return resolved === goal || resolved.startsWith(`${goal}/`);
  }
  return false;
}

function cite(rule: CompiledRule): string {
  return `${rule.source}: "${rule.text.length > 140 ? `${rule.text.slice(0, 137)}...` : rule.text}"`;
}

function functionLengths(after: string): Array<{ start: number; end: number; name: string }> {
  // Brace-matching scan for JS/TS function bodies; cheap and good enough for a length limit.
  const out: Array<{ start: number; end: number; name: string }> = [];
  const lines = after.split("\n");
  lines.forEach((text, index) => {
    const head = text.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{\s*$|^\s*(?:public |private |protected |static |async )*(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/);
    const name = head?.[1] ?? head?.[2] ?? head?.[3];
    if (!name || /^(if|for|while|switch|catch|function)$/.test(name)) return;
    let depth = 0;
    let opened = false;
    for (let k = index; k < lines.length; k += 1) {
      for (const ch of lines[k] ?? "") {
        if (ch === "{") {
          depth += 1;
          opened = true;
        } else if (ch === "}") depth -= 1;
      }
      if (opened && depth <= 0) {
        out.push({ start: index + 1, end: k + 1, name });
        return;
      }
    }
  });
  return out;
}

/** Compiled rule-file rules and policy `forbid` regexes, judged on the lines this proposal adds or changes. */
export function policyViolations(root: string, relativePath: string, before: string | null, after: string, policy: EffectivePolicy): GateViolation[] {
  const out: GateViolation[] = [];
  const language = languageOf(relativePath);
  const compiled = policy.importRuleFiles ? rulesFor(importRuleFiles(root), relativePath) : [];
  const changed = before === after ? [] : changedLines(relativePath, before, after);
  for (const rule of compiled) {
    if (rule.kind === "locked-path") {
      if (changed.length > 0 && pathMatches(relativePath, rule.target)) {
        out.push({ rule: "PolicyRule", code: "POLICY_LOCKED_PATH", file: relativePath, line: changed[0]?.line ?? 1, column: 1, message: `${relativePath} must not be edited (${cite(rule)}).`, fix: "Leave this file unchanged, or get the rule changed first." });
      }
      continue;
    }
    if (rule.kind === "banned-import") {
      for (const item of changed) {
        for (const spec of importSpecifiers(item.code, language)) {
          if (!importHits(spec, rule.target, relativePath)) continue;
          out.push({
            rule: "PolicyRule",
            code: "POLICY_BANNED_IMPORT",
            file: relativePath,
            line: item.line,
            column: Math.max(1, item.text.indexOf(spec) + 1),
            message: `Import '${spec}' is forbidden by ${cite(rule)}.`,
            fix: rule.useInstead ? `Use ${rule.useInstead} instead.` : `Remove the import of '${spec}'.`,
          });
        }
      }
      continue;
    }
    if (rule.kind === "forbidden-code") {
      const pattern = tokenPattern(rule.target);
      for (const item of changed) {
        const specs = importSpecifiers(item.code, language);
        if (specs.length > 0 && !specs.some((spec) => spec === rule.target || spec.startsWith(`${rule.target}/`))) continue;
        if (specs.length === 0 && !pattern.test(item.code)) continue;
        out.push({
          rule: "PolicyRule",
          code: "POLICY_FORBIDDEN_CODE",
          file: relativePath,
          line: item.line,
          column: Math.max(1, item.code.search(pattern) + 1),
          message: `\`${rule.target}\` is forbidden by ${cite(rule)}.`,
          fix: rule.useInstead ? `Use \`${rule.useInstead}\` instead of \`${rule.target}\`.` : `Remove \`${rule.target}\` from this line.`,
        });
      }
      continue;
    }
    if (rule.kind === "max-function-lines" && (language === "ts" || language === "js")) {
      const limit = Number(rule.target);
      const touched = new Set(changed.map((item) => item.line));
      for (const fn of functionLengths(after)) {
        const length = fn.end - fn.start + 1;
        if (length <= limit) continue;
        let hit = false;
        for (let line = fn.start; line <= fn.end && !hit; line += 1) hit = touched.has(line);
        if (!hit) continue;
        out.push({ rule: "PolicyRule", code: "POLICY_FUNCTION_TOO_LONG", file: relativePath, line: fn.start, column: 1, message: `'${fn.name}' is ${length} lines; ${cite(rule)} allows ${limit}.`, fix: `Split '${fn.name}' into smaller functions.` });
      }
      continue;
    }
    if (rule.kind === "require-jsdoc-exports" && (language === "ts" || language === "js")) {
      const lines = after.split("\n");
      for (const item of changed) {
        if (!/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+\w+/.test(item.text)) continue;
        const prev = (lines[item.line - 2] ?? "").trim();
        if (prev.endsWith("*/")) continue;
        out.push({ rule: "PolicyRule", code: "POLICY_JSDOC_REQUIRED", file: relativePath, line: item.line, column: 1, message: `New export has no doc comment, required by ${cite(rule)}.`, fix: "Add a /** ... */ comment above the export." });
      }
    }
  }
  for (const rule of policy.forbid) {
    if (rule.paths && !rule.paths.some((glob) => pathMatches(relativePath, glob))) continue;
    const pattern = compileSafeRegExp(rule.pattern);
    for (const item of changed) {
      if (!pattern.test(item.text)) continue;
      out.push({ rule: "PolicyRule", code: `POLICY_${rule.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, file: relativePath, line: item.line, column: 1, message: `${rule.message} (policy ${rule.source}, rule ${rule.id})`, fix: rule.fix ?? "Change the line so it no longer matches the policy rule." });
    }
  }
  return out;
}
