import fs from "node:fs";
import path from "node:path";

/**
 * The command written into agent configs and git hooks. A run from the npx cache (`npx vectorctc init`) must not
 * bake in that cache path, which npm may delete; it writes `npx -y vectorctc@<version>` instead.
 * CTC_COMMAND (space-separated) overrides both, e.g. CTC_COMMAND="pnpm exec ctc".
 */
export function selfCommand(self: string, version: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.CTC_COMMAND?.trim();
  if (override) return override.split(/\s+/);
  const dist = path.resolve(path.dirname(self), "../dist/index.js");
  const entry = fs.existsSync(dist) ? dist : self;
  if (/[\\/]_npx[\\/]/.test(entry)) return ["npx", "-y", `vectorctc@${version}`];
  return [process.execPath, entry];
}
