// Pure mapping from a ctc.hold.v1 / ctc.cleared.v1 payload to editor diagnostics and quick fixes.
// Kept free of the vscode API so it is unit-tested in the main test suite.

/** @param {any} payload */
export function toDiagnostics(payload) {
  const out = [];
  const explanations = new Map((payload?.explain?.explanations ?? []).map((item) => [`${item.code}|${item.lines?.start ?? item.line ?? 0}`, item]));
  const push = (item, severity) => {
    const line = Math.max(0, (item.line ?? 1) - 1);
    const explained = explanations.get(`${item.code}|${item.line ?? 0}`) ?? (payload?.explain?.explanations ?? []).find((candidate) => candidate.code === item.code);
    const end = explained?.lines?.end ? explained.lines.end - 1 : line;
    out.push({
      range: { startLine: line, startCol: Math.max(0, (item.column ?? 1) - 1), endLine: end, endCol: 1000 },
      severity,
      code: item.code,
      source: "VectorCTC",
      message: `${item.message}${explained?.why ? `\nWhy: ${explained.why}` : ""}\nFix: ${item.fix}`,
      fix: explained && explained.fix?.hunks?.length ? { id: explained.id, title: `VectorCTC: ${explained.fix.summary}`, hunks: explained.fix.hunks } : null,
    });
  };
  for (const item of payload?.violations ?? []) push(item, "error");
  for (const item of payload?.warnings ?? []) push(item, item.observed ? "information" : "warning");
  return out;
}

/** Apply literal search/replace hunks to text; null when a hunk no longer matches exactly once. */
export function applyHunks(text, hunks) {
  let next = text;
  for (const hunk of hunks) {
    const at = next.indexOf(hunk.search);
    if (at < 0 || next.indexOf(hunk.search, at + hunk.search.length) >= 0) return null;
    next = next.slice(0, at) + hunk.replace + next.slice(at + hunk.search.length);
  }
  return next;
}
