import fs from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {
  readonly inputPath: string;

  constructor(inputPath: string) {
    super(`Path "${inputPath}" escapes the project root.`);
    this.name = "PathEscapeError";
    this.inputPath = inputPath;
  }
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Resolve `inputPath` against `root` and return a repo-relative posix path.
 * Absolute paths are accepted only when they stay inside the root.
 */
export function normalizeRelative(root: string, inputPath: string): string {
  if (inputPath.trim() === "") {
    throw new PathEscapeError(inputPath);
  }
  const rootResolved = path.resolve(root);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootResolved, inputPath);
  const relative = path.relative(rootResolved, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathEscapeError(inputPath);
  }
  const posix = toPosix(relative);
  if (posix.split("/").includes("..")) {
    throw new PathEscapeError(inputPath);
  }
  return posix;
}

/** Walk parents from `start` and return the nearest directory that contains ctc.config.json. */
export function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  const stop = path.parse(current).root;
  while (true) {
    if (fs.existsSync(path.join(current, "ctc.config.json"))) {
      return current;
    }
    if (current === stop) break;
    current = path.dirname(current);
  }
  return path.resolve(start);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
