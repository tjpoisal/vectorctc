export interface PatchHunk {
  search: string;
  replace: string;
}

export function applyLiteralPatch(original: string, hunks: readonly PatchHunk[]): { content: string } | { code: "PATCH_NOT_FOUND" | "PATCH_AMBIGUOUS" | "PATCH_EMPTY"; message: string } {
  let next = original;
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (!hunk || hunk.search === "") {
      return { code: "PATCH_EMPTY", message: `Hunk ${index} has an empty search string.` };
    }
    const first = next.indexOf(hunk.search);
    if (first < 0) {
      return { code: "PATCH_NOT_FOUND", message: `Hunk ${index} search text was not found. Re-read the file. Replacement is literal and does not interpret $.` };
    }
    const second = next.indexOf(hunk.search, first + hunk.search.length);
    if (second >= 0) {
      return { code: "PATCH_AMBIGUOUS", message: `Hunk ${index} matched more than once. Include more surrounding context.` };
    }
    next = next.slice(0, first) + hunk.replace + next.slice(first + hunk.search.length);
  }
  return { content: next };
}
