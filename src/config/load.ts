import fs from "node:fs";
import path from "node:path";

import { ConfigError, normalizeConfig, type CtcConfig } from "./schema.js";

export const CONFIG_FILENAME = "ctc.config.json";

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILENAME);
}

export function loadConfig(root: string): CtcConfig {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `No ${CONFIG_FILENAME} at ${root}. Run \`ctc init\` or \`ctc scan --write\` in the project root.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${message}`);
  }
  try {
    return normalizeConfig(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${CONFIG_FILENAME} failed validation: ${message}`);
  }
}
