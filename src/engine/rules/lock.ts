import type { CtcConfig } from "../../config/schema.js";
import { matchesAny } from "../match.js";
import { violation, type Rule, type Violation } from "../types.js";

/** Control files stay locked even when `lockedFiles` is empty. */
export const CONTROL_PATTERNS = ["ctc.config.json", ".ctc/**"] as const;

export function matchedLock(relativePath: string, config: CtcConfig): string | null {
  return matchesAny(relativePath, [...CONTROL_PATTERNS, ...config.lockedFiles]);
}

export function lockViolation(relativePath: string, pattern: string): Violation {
  const control = (CONTROL_PATTERNS as readonly string[]).includes(pattern);
  return violation({
    code: "LOCKED_FILE",
    rule: "lockedFiles",
    gate: "lock",
    file: relativePath,
    line: null,
    column: null,
    message: control
      ? `${relativePath} is a CTC control file and is always locked.`
      : `${relativePath} is locked by pattern "${pattern}".`,
    fix: control
      ? "Edit CTC control files by hand. Agents do not land writes on ctc.config.json or .ctc/**."
      : "Choose a file that is not locked. Locked paths are changed by humans.",
  });
}

export const lockRule: Rule = {
  id: "lockedFiles",
  gate: "lock",
  order: 10,
  check(ctx) {
    const pattern = matchedLock(ctx.relativePath, ctx.config);
    if (!pattern) return [];
    return [lockViolation(ctx.relativePath, pattern)];
  },
};
