import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { GateViolation } from "../schemas/gate.js";
import { changedDependencies, isDependencyFile, parseDependencies, type Dependency, type Ecosystem } from "./lockfiles.js";
import { inRange, minVersionOf, type RangeEvent } from "./semver.js";

/**
 * SCA in the pre-write gate (v0.4). Advisory data comes from OSV (https://osv.dev, free, no key) and is
 * cached locally; the gate itself never touches the network, so a check stays deterministic and fast.
 *
 *   built-in seed   data/osv-seed.json (shipped; real OSV records for popular packages, dated)
 *   project cache   .ctc/advisories.json (`ctc advisories sync` queries OSV for every locked dependency)
 *   policy file     sca.advisoryFile (e.g. an org-wide mirror), same format
 *
 * A write to a manifest or lockfile is held when it adds or moves a dependency to a version inside a
 * published advisory range at or above the policy's minimum severity. Only the changed entries are
 * judged, so an existing vulnerable lock does not block unrelated edits (`ctc advisories audit` reports those).
 */

export type Severity = "low" | "moderate" | "high" | "critical" | "unknown";
const RANK: Record<Severity, number> = { unknown: 1, low: 1, moderate: 2, high: 3, critical: 4 };

export interface Advisory {
  id: string;
  aliases?: string[];
  summary: string;
  severity: Severity;
  ranges: RangeEvent[][];
  versions?: string[];
}

export interface AdvisoryDb {
  version: 1;
  source: string;
  fetchedAt: string;
  packages: Record<string, Advisory[]>;
}

export const PROJECT_ADVISORIES = ".ctc/advisories.json";

export function seedPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "data", "osv-seed.json");
}

const dbCache = new Map<string, { mtime: number; db: AdvisoryDb | null }>();

function readDb(file: string): AdvisoryDb | null {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = dbCache.get(file);
  if (hit && hit.mtime === mtime) return hit.db;
  let db: AdvisoryDb | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as AdvisoryDb;
    if (raw && raw.version === 1 && raw.packages) db = raw;
  } catch {
    db = null;
  }
  dbCache.set(file, { mtime, db });
  return db;
}

export function packageKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}|${ecosystem === "PyPI" ? name.toLowerCase() : name}`;
}

export function loadAdvisories(root: string, extraFile: string | null = null): { lookup: (dep: Dependency) => Advisory[]; sources: string[] } {
  const files = [seedPath(), path.join(root, PROJECT_ADVISORIES), ...(extraFile ? [extraFile] : [])];
  const dbs = files.map((file) => ({ file, db: readDb(file) })).filter((item): item is { file: string; db: AdvisoryDb } => item.db !== null);
  return {
    sources: dbs.map((item) => `${path.relative(root, item.file) || item.file} (${item.db.source}, ${item.db.fetchedAt.slice(0, 10)})`),
    lookup: (dep) => {
      const seen = new Set<string>();
      const out: Advisory[] = [];
      for (const { db } of dbs) {
        for (const advisory of db.packages[packageKey(dep.ecosystem, dep.name)] ?? []) {
          if (seen.has(advisory.id)) continue;
          seen.add(advisory.id);
          out.push(advisory);
        }
      }
      return out;
    },
  };
}

export function affects(advisory: Advisory, version: string): boolean {
  if (advisory.versions?.includes(version)) return true;
  return advisory.ranges.some((events) => inRange(version, events));
}

export function fixedVersion(advisory: Advisory, version: string): string | null {
  for (const events of advisory.ranges) {
    if (!inRange(version, events)) continue;
    const fixed = events.map((event) => event.fixed).filter((item): item is string => Boolean(item));
    if (fixed.length > 0) return fixed.sort()[fixed.length - 1] ?? null;
  }
  return null;
}

export function scaViolations(root: string, relativePath: string, before: string | null, after: string, options: { minSeverity?: Severity; advisoryFile?: string | null } = {}): GateViolation[] {
  if (!isDependencyFile(relativePath)) return [];
  const deps = changedDependencies(relativePath, before, after, minVersionOf);
  if (deps.length === 0) return [];
  const { lookup } = loadAdvisories(root, options.advisoryFile ?? null);
  const min = RANK[options.minSeverity ?? "moderate"];
  const lines = after.split("\n");
  const out: GateViolation[] = [];
  for (const dep of deps) {
    const hits = lookup(dep).filter((advisory) => RANK[advisory.severity] >= min && affects(advisory, dep.version));
    if (hits.length === 0) continue;
    const worst = hits.sort((a, b) => RANK[b.severity] - RANK[a.severity])[0];
    if (!worst) continue;
    const fixed = fixedVersion(worst, dep.version);
    const index = lines.findIndex((line) => line.includes(dep.name) && (line.includes(dep.version) || dep.fromRange));
    const alias = worst.aliases?.find((item) => item.startsWith("CVE-"));
    out.push({
      rule: "DependencyAdvisory",
      code: "VULNERABLE_DEPENDENCY",
      file: relativePath,
      line: index >= 0 ? index + 1 : 1,
      column: 1,
      message: `${dep.name}@${dep.version}${dep.fromRange ? " (lowest version the range allows)" : ""} is affected by ${worst.id}${alias ? ` / ${alias}` : ""} (${worst.severity}): ${worst.summary}${hits.length > 1 ? ` (+${hits.length - 1} more advisories)` : ""}.`,
      fix: fixed ? `Use ${dep.name}@${fixed} or later.` : `Pick a version outside the advisory range, or replace ${dep.name}.`,
      cwe: "CWE-1395",
    });
  }
  return out;
}

/** Every locked dependency in the project with a known advisory (not gate-blocking; for `ctc advisories audit`). */
export function auditProject(root: string, files: readonly string[]): Array<{ file: string; dependency: string; advisories: string[] }> {
  const { lookup } = loadAdvisories(root);
  const out: Array<{ file: string; dependency: string; advisories: string[] }> = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    for (const dep of parseDependencies(file, fs.readFileSync(absolute, "utf8"), minVersionOf)) {
      const hits = lookup(dep).filter((advisory) => affects(advisory, dep.version));
      if (hits.length > 0) out.push({ file, dependency: `${dep.name}@${dep.version}`, advisories: hits.map((item) => `${item.id} (${item.severity})`) });
    }
  }
  return out;
}

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: Array<{ type?: string; events?: RangeEvent[] }>; versions?: string[] }>;
}

export function toAdvisory(vuln: OsvVuln, ecosystem: Ecosystem, name: string): Advisory | null {
  const affected = (vuln.affected ?? []).filter((item) => item.package?.ecosystem === ecosystem && (ecosystem === "PyPI" ? item.package?.name?.toLowerCase() === name.toLowerCase() : item.package?.name === name));
  if (affected.length === 0) return null;
  const ranges = affected.flatMap((item) => (item.ranges ?? []).filter((range) => range.type === "SEMVER" || range.type === "ECOSYSTEM").map((range) => range.events ?? []));
  const versions = affected.flatMap((item) => item.versions ?? []).slice(0, 400);
  const raw = (vuln.database_specific?.severity ?? "").toLowerCase();
  const severity: Severity = raw === "low" || raw === "moderate" || raw === "high" || raw === "critical" ? raw : raw === "medium" ? "moderate" : "unknown";
  return { id: vuln.id, ...(vuln.aliases?.length ? { aliases: vuln.aliases } : {}), summary: (vuln.summary ?? vuln.details ?? "").split("\n")[0]?.slice(0, 200) ?? "", severity, ranges, ...(versions.length && ranges.length === 0 ? { versions } : {}) };
}

/** Fetch advisories for the given packages from OSV into a db object. Network; never called by the gate. */
export async function fetchOsv(packages: ReadonlyArray<{ ecosystem: Ecosystem; name: string }>, fetchImpl: typeof fetch = fetch, base = "https://api.osv.dev"): Promise<AdvisoryDb> {
  const db: AdvisoryDb = { version: 1, source: "OSV (api.osv.dev)", fetchedAt: new Date().toISOString(), packages: {} };
  const unique = [...new Map(packages.map((item) => [packageKey(item.ecosystem, item.name), item])).values()];
  const ids = new Map<string, Array<{ ecosystem: Ecosystem; name: string }>>();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const res = await fetchImpl(`${base}/v1/querybatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queries: chunk.map((item) => ({ package: { name: item.name, ecosystem: item.ecosystem } })) }) });
    if (!res.ok) throw new Error(`OSV querybatch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ vulns?: Array<{ id: string }> }> };
    (body.results ?? []).forEach((result, index) => {
      const pkg = chunk[index];
      if (!pkg) return;
      db.packages[packageKey(pkg.ecosystem, pkg.name)] ??= [];
      for (const vuln of result.vulns ?? []) ids.set(vuln.id, [...(ids.get(vuln.id) ?? []), pkg]);
    });
  }
  const queue = [...ids.keys()];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const res = await fetchImpl(`${base}/v1/vulns/${encodeURIComponent(id)}`);
      if (!res.ok) continue;
      const vuln = (await res.json()) as OsvVuln;
      for (const pkg of ids.get(id) ?? []) {
        const advisory = toAdvisory(vuln, pkg.ecosystem, pkg.name);
        if (advisory) db.packages[packageKey(pkg.ecosystem, pkg.name)]?.push(advisory);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  for (const list of Object.values(db.packages)) list.sort((a, b) => a.id.localeCompare(b.id));
  return db;
}

export function lockfilesIn(root: string): string[] {
  const names = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "package.json", "requirements.txt", "go.mod"];
  return names.filter((name) => fs.existsSync(path.join(root, name)));
}

export function projectDependencies(root: string): Dependency[] {
  return lockfilesIn(root).flatMap((file) => parseDependencies(file, fs.readFileSync(path.join(root, file), "utf8"), minVersionOf));
}
