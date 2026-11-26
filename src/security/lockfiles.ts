import path from "node:path";

export type Ecosystem = "npm" | "PyPI" | "Go";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** True when `version` is the lowest version a manifest range allows, not a locked version. */
  fromRange: boolean;
}

export function isDependencyFile(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  return /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements(?:[-.][\w-]+)?\.txt|go\.mod|go\.sum|Pipfile\.lock|poetry\.lock)$/.test(base);
}

function key(dep: Dependency): string {
  return `${dep.ecosystem}|${dep.name}|${dep.version}`;
}

function npmLock(text: string): Dependency[] {
  const out: Dependency[] = [];
  let parsed: { packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, { version?: string }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return out;
  }
  for (const [where, info] of Object.entries(parsed.packages ?? {})) {
    if (!where || info.link || !info.version) continue;
    const name = where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push({ ecosystem: "npm", name, version: info.version, fromRange: false });
  }
  if (out.length === 0) for (const [name, info] of Object.entries(parsed.dependencies ?? {})) if (info.version) out.push({ ecosystem: "npm", name, version: info.version, fromRange: false });
  return out;
}

function packageJson(text: string, minVersionOf: (range: string) => string | null): Dependency[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: Dependency[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = parsed[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      const version = minVersionOf(range);
      if (version) out.push({ ecosystem: "npm", name, version, fromRange: true });
    }
  }
  return out;
}

function yarnLock(text: string): Dependency[] {
  const out: Dependency[] = [];
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^"?(@?[^@\s"]+)@[^:]*:\s*$/);
    if (header?.[1]) current = header[1];
    const version = line.match(/^\s+version:?\s+"?([^"\s]+)"?/);
    if (current && version?.[1]) {
      out.push({ ecosystem: "npm", name: current, version: version[1], fromRange: false });
      current = null;
    }
  }
  return out;
}

function pnpmLock(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const match of text.matchAll(/^\s{2}'?\/?(@?[^@\s':]+)@(\d+\.\d+\.\d+[^\s':(]*)/gm)) {
    if (match[1] && match[2]) out.push({ ecosystem: "npm", name: match[1], version: match[2], fromRange: false });
  }
  return out;
}

function requirements(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(==|>=|~=)\s*([0-9][^\s;,#]*)/);
    if (match?.[1] && match[3]) out.push({ ecosystem: "PyPI", name: match[1].toLowerCase(), version: match[3], fromRange: match[2] !== "==" });
  }
  return out;
}

function goMod(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const match of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v(\d+\.\d+\.\d+[^\s]*)/gm)) {
    if (match[1] && match[2]) out.push({ ecosystem: "Go", name: match[1], version: match[2].replace(/\+incompatible$/, ""), fromRange: false });
  }
  return out;
}

export function parseDependencies(relativePath: string, text: string | null, minVersionOf: (range: string) => string | null): Dependency[] {
  if (text === null) return [];
  const base = path.posix.basename(relativePath);
  let deps: Dependency[] = [];
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") deps = npmLock(text);
  else if (base === "package.json") deps = packageJson(text, minVersionOf);
  else if (base === "yarn.lock") deps = yarnLock(text);
  else if (base === "pnpm-lock.yaml") deps = pnpmLock(text);
  else if (/^requirements/.test(base)) deps = requirements(text);
  else if (base === "go.mod" || base === "go.sum") deps = goMod(text);
  const seen = new Set<string>();
  return deps.filter((dep) => (seen.has(key(dep)) ? false : (seen.add(key(dep)), true)));
}

/** Dependencies the proposal adds or moves to a new version (unchanged entries are not re-judged). */
export function changedDependencies(relativePath: string, before: string | null, after: string, minVersionOf: (range: string) => string | null): Dependency[] {
  const old = new Set(parseDependencies(relativePath, before, minVersionOf).map(key));
  return parseDependencies(relativePath, after, minVersionOf).filter((dep) => !old.has(key(dep)));
}
