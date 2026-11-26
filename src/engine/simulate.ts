import path from "node:path";
import { ModuleKind, Project, ScriptKind, ScriptTarget, type SourceFile } from "ts-morph";

const SCRIPT_KINDS: Record<string, ScriptKind> = {
  ".ts": ScriptKind.TS,
  ".tsx": ScriptKind.TSX,
  ".mts": ScriptKind.TS,
  ".cts": ScriptKind.TS,
  ".js": ScriptKind.JS,
  ".jsx": ScriptKind.JSX,
  ".mjs": ScriptKind.JS,
  ".cjs": ScriptKind.JS,
};

export function scriptKindFor(relativePath: string): ScriptKind | null {
  const ext = path.posix.extname(relativePath);
  return SCRIPT_KINDS[ext] ?? null;
}

/**
 * Parse proposed contents in a throwaway in-memory project.
 * Nothing is read from or written to the real filesystem.
 */
export function simulateSource(relativePath: string, content: string): SourceFile | null {
  const kind = scriptKindFor(relativePath);
  if (!kind) return null;
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      noEmit: true,
      strict: true,
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
    },
  });
  return project.createSourceFile(relativePath, content, { overwrite: true, scriptKind: kind });
}
