import { minimatch } from "minimatch";

import { toPosix } from "../paths.js";

export function pathMatches(relativePath: string, pattern: string): boolean {
  const target = toPosix(relativePath).replace(/^\.\//, "");
  const pat = toPosix(pattern).replace(/^\.\//, "");
  if (minimatch(target, pat, { dot: true })) return true;
  if (!hasGlob(pat)) {
    const prefix = pat.endsWith("/") ? pat.slice(0, -1) : pat;
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  return false;
}

export function hasGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/** Static directory prefix of a glob, including the trailing slash when the star is mid-path. */
export function staticPrefix(pattern: string): string {
  const normalized = toPosix(pattern);
  const index = normalized.search(/[*?[]/);
  if (index === -1) return normalized;
  return normalized.slice(0, index);
}

/**
 * A proposed flight-plan pattern is inside the milestone ceiling when it is a
 * concrete path the ceiling already allows, or its prefix is at least as
 * specific as one ceiling pattern.
 */
export function patternWithinCeiling(pattern: string, ceiling: readonly string[]): boolean {
  if (!hasGlob(pattern) && ceiling.some((entry) => pathMatches(pattern, entry))) {
    return true;
  }
  return ceiling.some((entry) => {
    const ceilingPrefix = staticPrefix(entry);
    if (ceilingPrefix === "") return staticPrefix(pattern) === "";
    const proposed = hasGlob(pattern) ? staticPrefix(pattern) : pattern;
    return proposed.startsWith(ceilingPrefix) || pattern.startsWith(ceilingPrefix);
  });
}

export function matchesAny(relativePath: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (pathMatches(relativePath, pattern)) return pattern;
  }
  return null;
}
