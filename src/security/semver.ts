/** Minimal semver ordering for advisory ranges (no prerelease precedence beyond "x-y < x"). */
export function parseVersion(value: string): number[] | null {
  const match = value.trim().replace(/^[v=^~]+/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.-]?([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0), match[4] ? -1 : 0];
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface RangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

/** OSV SEMVER/ECOSYSTEM range semantics: affected from each `introduced` until the next `fixed` (exclusive) or `last_affected` (inclusive). */
export function inRange(version: string, events: readonly RangeEvent[]): boolean {
  let affected = false;
  const sorted = [...events].sort((a, b) => compareVersions(a.introduced ?? a.fixed ?? a.last_affected ?? "0", b.introduced ?? b.fixed ?? b.last_affected ?? "0"));
  for (const event of sorted) {
    if (event.introduced !== undefined) {
      if (event.introduced === "0" || compareVersions(version, event.introduced) >= 0) affected = true;
    } else if (event.fixed !== undefined) {
      if (compareVersions(version, event.fixed) >= 0) affected = false;
    } else if (event.last_affected !== undefined) {
      if (compareVersions(version, event.last_affected) > 0) affected = false;
    }
  }
  return affected;
}

/** Lowest concrete version a manifest range can resolve to (^1.2.3 → 1.2.3, >=2 → 2.0.0). Null for tags, URLs, workspaces. */
export function minVersionOf(range: string): string | null {
  const first = range.split("||")[0]?.trim() ?? "";
  const match = first.match(/(?:^|[\s>=^~v])(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/);
  if (!match?.[1] || /^(file:|link:|workspace:|git|http|npm:)/.test(first)) return null;
  const parts = match[1].split("-")[0]?.split(".") ?? [];
  while (parts.length < 3) parts.push("0");
  return parts.join(".") + (match[1].includes("-") ? `-${match[1].split("-").slice(1).join("-")}` : "");
}
