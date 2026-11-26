import fs from "node:fs";
import path from "node:path";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget, type SourceFile } from "ts-morph";

const projects = new Map<string, Project>();
const depth = new Map<string, number>();
/** mtime of every project file when it was last read, per root, so a long-lived server sees edits on disk. */
const stamps = new Map<string, Map<string, number>>();
const generations = new Map<string, number>();

/** Bumped whenever a cached project picks up a change from disk. Lets callers key their own caches. */
export function projectGeneration(root: string): number {
  return generations.get(path.resolve(root)) ?? 0;
}

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function stampAll(root: string, project: Project): void {
  const map = new Map<string, number>();
  for (const file of project.getSourceFiles()) {
    if (file.isInNodeModules()) continue;
    const at = mtime(file.getFilePath());
    if (at !== null) map.set(file.getFilePath(), at);
  }
  stamps.set(root, map);
}

/** Re-read project files whose mtime changed since they were loaded; drop the ones that were deleted. */
function refreshStale(root: string, project: Project): void {
  const map = stamps.get(root);
  if (!map) return stampAll(root, project);
  let changed = false;
  for (const [file, seen] of map) {
    const now = mtime(file);
    if (now === seen) continue;
    changed = true;
    const source = project.getSourceFile(file);
    if (now === null) {
      map.delete(file);
      if (source) project.removeSourceFile(source);
      continue;
    }
    map.set(file, now);
    try {
      source?.refreshFromFileSystemSync();
    } catch {
      projects.delete(root);
    }
  }
  if (changed) generations.set(root, (generations.get(root) ?? 0) + 1);
}

export function clearGateProjectsForTests(root?: string): void {
  if (!root) {
    projects.clear();
    depth.clear();
    stamps.clear();
    return;
  }
  const resolved = path.resolve(root);
  projects.delete(resolved);
  depth.delete(resolved);
  stamps.delete(resolved);
}

function freshProject(root: string): Project {
  const tsconfig = path.join(root, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    return new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: false });
  }
  return new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      allowJs: true,
      skipLibCheck: true,
    },
  });
}

function projectFor(root: string): Project {
  const outer = (depth.get(root) ?? 0) <= 1;
  const cached = projects.get(root);
  if (cached && outer) {
    refreshStale(root, cached);
    if (projects.get(root) === cached) return cached;
  }
  const created = freshProject(root);
  if (outer) {
    projects.set(root, created);
    stampAll(root, created);
    generations.set(root, (generations.get(root) ?? 0) + 1);
  }
  return created;
}

/**
 * Run `body` against an in-memory overlay of `relativePath`.
 * The previous text is restored before this function returns, including when `body` throws.
 * A re-entrant call uses its own project so two callers cannot observe each other's overlay.
 */
export function withOverlay<T>(rootInput: string, relativePath: string, content: string, body: (source: SourceFile, project: Project) => T): T {
  const root = path.resolve(rootInput);
  const absolute = path.join(root, relativePath);
  const current = (depth.get(root) ?? 0) + 1;
  depth.set(root, current);
  const project = projectFor(root);
  let existing = project.getSourceFile(absolute);
  if (!existing && fs.existsSync(absolute)) {
    existing = project.addSourceFileAtPath(absolute);
    const at = mtime(absolute);
    if (at !== null && projects.get(root) === project) stamps.get(root)?.set(absolute, at);
  }
  const original = existing?.getFullText();
  let created = false;
  try {
    if (existing) existing.replaceWithText(content);
    else {
      project.createSourceFile(absolute, content, { overwrite: true });
      created = true;
    }
    const source = project.getSourceFileOrThrow(absolute);
    return body(source, project);
  } finally {
    const currentFile = project.getSourceFile(absolute);
    try {
      if (created && currentFile) project.removeSourceFile(currentFile);
      else if (currentFile && original !== undefined) currentFile.replaceWithText(original);
    } catch {
      projects.delete(root);
    }
    const next = (depth.get(root) ?? 1) - 1;
    if (next <= 0) depth.delete(root);
    else depth.set(root, next);
  }
}
