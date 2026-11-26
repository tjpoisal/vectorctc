import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

import { normalizeConfig, normalizeFlightPlan, type CtcConfig, type FlightPlan } from "../config/schema.js";
import { saveFlightPlan } from "../engine/flight-plan.js";
import { scriptKindFor, simulateSource } from "../engine/simulate.js";
import { toPosix } from "../paths.js";

const IGNORE_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ctc", ".next", "out", ".turbo"]);

const LOCKFILE_NAMES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const DATA_LIBS = ["@tanstack/react-query", "react-query", "@trpc/react-query", "@trpc/client"];

export interface DetectedArchitecture {
  schemas: string[];
  stateStores: string[];
  apiClients: string[];
  canonicalHook: string | null;
}

export interface ScanInventory {
  filesScanned: number;
  sourceRoots: string[];
  externalImports: string[];
  undeclaredImports: string[];
  lockfiles: string[];
  parseErrors: string[];
  detected: DetectedArchitecture;
}

export interface ScanReport {
  root: string;
  config: CtcConfig;
  flightPlan: FlightPlan;
  inventory: ScanInventory;
  detected: DetectedArchitecture;
}

function walk(dir: string, root: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), root, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path.join(dir, entry.name));
  }
}

function declaredDependencies(root: string): Set<string> {
  const file = path.join(root, "package.json");
  const names = new Set<string>();
  if (!fs.existsSync(file)) return names;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const group of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
      if (!group) continue;
      for (const name of Object.keys(group)) names.add(name);
    }
  } catch {
    return names;
  }
  return names;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "project";
}

function projectSlug(root: string): string {
  const file = path.join(root, "package.json");
  if (fs.existsSync(file)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string };
      if (typeof pkg.name === "string" && pkg.name.trim()) return slug(pkg.name);
    } catch {
      // Fall through to the directory name.
    }
  }
  return slug(path.basename(root));
}

function isStateStore(text: string): boolean {
  return (
    /from\s+["']zustand["']/.test(text) ||
    /from\s+["']zustand\//.test(text) ||
    /from\s+["']jotai["']/.test(text) ||
    /from\s+["']jotai\//.test(text) ||
    /from\s+["']redux["']/.test(text) ||
    /from\s+["']@reduxjs\/toolkit["']/.test(text) ||
    /from\s+["']react-redux["']/.test(text)
  );
}

function isApiClient(text: string, relative: string): boolean {
  if (relative.includes("/hooks/") || relative.includes("/components/")) return false;
  return (
    /axios\.create\s*\(/.test(text) ||
    /from\s+["']@trpc\/client["']/.test(text) ||
    /\bcreateTRPC(?:React|ProxyClient|Next|Client)\w*\s*\(/.test(text) ||
    (/\/(?:api|lib)\//.test(relative) && /\bfetch\s*\(/.test(text) && /export\s+(?:async\s+)?function\s+/.test(text))
  );
}

function exportedHookName(text: string): string | null {
  const match = text.match(/export\s+(?:async\s+)?function\s+(use[A-Z]\w*)/) ?? text.match(/export\s+const\s+(use[A-Z]\w*)/);
  return match?.[1] ?? null;
}

function isDataHook(text: string): boolean {
  if (!exportedHookName(text)) return false;
  return DATA_LIBS.some((lib) => text.includes(`"${lib}"`) || text.includes(`'${lib}'`));
}

function rankHook(relative: string): number {
  if (relative.includes("/hooks/")) return 0;
  if (relative.includes("/api/")) return 1;
  if (relative.includes("/lib/")) return 2;
  return 3;
}

function clientImport(relative: string, source: string): string {
  if (/export\s+default\b/.test(source)) return `import client from "${relative}"`;
  const named = source.match(/export\s+(?:const|function|class)\s+(\w+)/);
  return `import { ${named?.[1] ?? "client"} } from "${relative}"`;
}

export function scanProject(rootInput: string): ScanReport {
  const root = path.resolve(rootInput);
  const absoluteFiles: string[] = [];
  walk(root, root, absoluteFiles);
  const declared = declaredDependencies(root);
  const external = new Set<string>();
  const undeclared = new Set<string>();
  const parseErrors: string[] = [];
  const scriptRels: string[] = [];
  const schemas: string[] = [];
  const stateStores: string[] = [];
  const apiClients: string[] = [];
  const hookCandidates: string[] = [];
  const texts = new Map<string, string>();

  if (fs.existsSync(path.join(root, "prisma", "schema.prisma"))) schemas.push("prisma/schema.prisma");

  for (const absolute of absoluteFiles) {
    const relative = toPosix(path.relative(root, absolute));
    if (!scriptKindFor(relative)) continue;
    const stat = fs.statSync(absolute);
    if (stat.size > 1_000_000) {
      parseErrors.push(`${relative}: skipped, larger than 1 MB`);
      continue;
    }
    scriptRels.push(relative);
    let text: string;
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      parseErrors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    texts.set(relative, text);
    if (
      /from\s+["']drizzle-orm(?:\/[^"']*)?["']/.test(text) ||
      /\b(?:pgTable|sqliteTable|mysqlTable)\s*\(/.test(text)
    ) {
      schemas.push(relative);
    }
    if (isStateStore(text)) stateStores.push(relative);
    if (isApiClient(text, relative)) apiClients.push(relative);
    if (isDataHook(text) && !isStateStore(text)) hookCandidates.push(relative);

    let source;
    try {
      source = simulateSource(relative, text);
    } catch (error) {
      parseErrors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!source) continue;
    const specifiers = [
      ...source.getImportDeclarations().map((item) => item.getModuleSpecifierValue()),
      ...source.getExportDeclarations().map((item) => item.getModuleSpecifierValue() ?? ""),
    ].filter((item) => item.length > 0);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      external.add(specifier);
      const pkg = packageNameOf(specifier);
      if (BUILTINS.has(specifier) || BUILTINS.has(pkg)) continue;
      if (!declared.has(pkg)) undeclared.add(pkg);
    }
  }

  const roots = new Set<string>();
  const rootFiles: string[] = [];
  for (const relative of scriptRels) {
    const dir = path.posix.dirname(relative);
    if (dir === ".") rootFiles.push(relative);
    else roots.add(dir.split("/")[0] ?? dir);
  }
  const scope = [...roots].sort().map((dir) => `${dir}/**`);
  for (const file of rootFiles.sort()) scope.push(file);
  if (scope.length === 0) scope.push("**/*");

  const lockfiles = LOCKFILE_NAMES.filter((name) => fs.existsSync(path.join(root, name)));
  const milestone = `${projectSlug(root)}-foundation`;
  const canonical = [...hookCandidates].sort((a, b) => rankHook(a) - rankHook(b) || a.length - b.length || a.localeCompare(b))[0] ?? null;
  const canonicalText = canonical ? texts.get(canonical) ?? "" : "";
  const hookName = exportedHookName(canonicalText) ?? "useClient";
  const hookInstead = canonical ? `import { ${hookName} } from "${canonical}"` : null;
  const clientFile = apiClients.find((file) => /axios\.create\s*\(/.test(texts.get(file) ?? "")) ?? null;
  const clientText = clientFile ? texts.get(clientFile) ?? "" : "";
  const usesAxios = [...external].some((specifier) => packageNameOf(specifier) === "axios");

  const detected: DetectedArchitecture = {
    schemas: [...schemas].sort(),
    stateStores: [...stateStores].sort(),
    apiClients: [...apiClients].sort(),
    canonicalHook: canonical,
  };

  const locked = new Set<string>([...lockfiles, "dist/**", "coverage/**", ...detected.schemas, ...detected.stateStores, ...detected.apiClients]);

  const bannedImports = [...undeclared].sort().map((name) => ({
    pattern: name,
    reason: "Imported by source but not declared in package.json dependencies.",
    useInstead: `Remove the undeclared import of ${name}, or declare it in package.json.`,
  }));
  if (usesAxios && !undeclared.has("axios")) {
    bannedImports.push({
      pattern: "axios",
      reason: "Components must not import axios directly.",
      useInstead: clientFile ? clientImport(clientFile, clientText) : "the project axios client",
    });
  }

  const restrictedCalls = [
    { callPattern: "eval", inPaths: ["**"], useInstead: "a named function in the project, never eval" },
    { callPattern: "Function", inPaths: ["**"], useInstead: "a named function in the project, never new Function" },
    ...(hookInstead ? [{ callPattern: "fetch", inPaths: ["src/components/**"], useInstead: hookInstead }] : []),
  ];

  const config = normalizeConfig({
    version: 1,
    activeMilestone: {
      id: milestone,
      title: "Foundation scope discovered by ctc scan",
      allowedPaths: scope,
      status: "active",
    },
    lockedFiles: [...locked],
    bannedImports,
    restrictedCalls,
    degradation: {
      maxFunctionLength: 80,
      maxCyclomaticComplexity: 12,
      flagUnusedImports: true,
    },
    circuitBreaker: { maxStrikes: 3 },
  });
  const flightPlan: FlightPlan = normalizeFlightPlan({
    milestone,
    intent: "Scanned foundation scope",
    paths: scope,
  });
  return {
    root,
    config,
    flightPlan,
    inventory: {
      filesScanned: scriptRels.length,
      sourceRoots: [...roots].sort(),
      externalImports: [...external].sort(),
      undeclaredImports: [...undeclared].sort(),
      lockfiles: [...lockfiles],
      parseErrors,
      detected,
    },
    detected,
  };
}

export function writeScan(
  rootInput: string,
  report: ScanReport,
  options: { force?: boolean; configPath?: string } = {},
): { configPath: string; flightPlanPath: string } {
  const root = path.resolve(rootInput);
  const configFile = path.resolve(root, options.configPath ?? "ctc.config.json");
  if (!options.force && fs.existsSync(configFile)) {
    throw new Error(`${configFile} already exists. Pass --force to overwrite it.`);
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(report.config, null, 2)}\n`, "utf8");
  saveFlightPlan(root, report.flightPlan);
  return { configPath: configFile, flightPlanPath: path.join(root, ".ctc", "flightplan.json") };
}
