/** Reject patterns that are invalid or an obvious catastrophic-backtracking shape. */
export function isSafeRegExp(pattern: string): boolean {
  if (pattern.length < 1 || pattern.length > 200) return false;
  let quantifiers = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") quantifiers += 1;
    if (ch === "{") quantifiers += 1;
  }
  if (quantifiers > 20) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  if (/\(\?:[^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  try {
    const compiled = new RegExp(pattern);
    compiled.test("");
    return true;
  } catch {
    return false;
  }
}

export function compileSafeRegExp(pattern: string): RegExp {
  if (!isSafeRegExp(pattern)) {
    throw new Error(`Rejected regular expression "${pattern}". Use a short pattern without nested quantifiers.`);
  }
  return new RegExp(pattern);
}

/** Run a vetted pattern against a bounded slice of the input. */
export function safeTest(pattern: RegExp, text: string): boolean {
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  return pattern.test(sample);
}
