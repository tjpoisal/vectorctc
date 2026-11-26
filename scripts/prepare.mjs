#!/usr/bin/env node
/* global process */
// Builds dist/ on `npm install` from git (pre-commit hooks, github: dependencies) and on `npm pack`.
// npm runs a git dependency's prepare step with the parent's global flag, so devDependencies (typescript) can be
// missing; install them locally first in that case.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("tsconfig.json")) process.exit(0); // installed from the registry tarball: nothing to build
const tsc = "node_modules/typescript/bin/tsc";
if (!existsSync(tsc)) {
  execSync("npm install --no-save --include=dev --ignore-scripts --no-audit --no-fund", {
    stdio: "inherit",
    env: { ...process.env, npm_config_global: "false", npm_config_omit: "", NODE_ENV: "development" },
  });
}
execSync(`node ${tsc} -p tsconfig.json`, { stdio: "inherit" });
