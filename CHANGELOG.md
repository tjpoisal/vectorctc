# Changelog

All notable changes to VectorCTC (Code Traffic Control). Dates are America/New_York. The project is pre-1.0 and
not yet published to npm; versions below are internal milestones.

## 0.5.0 — 2026-11-26

### Added
- `ctc try [--commits 50] [--timeout 60]` (also `npx vectorctc try` once published): zero-setup trial that replays the
  last N commits through the gate in a throwaway `git clone --shared` under the OS temp dir and prints what it would
  have held, by rule. It infers a config in the clone when the repo has none, never writes to the user's repo, and
  stops at the time limit.
- Replay ("why it held"): every held or observed write stores `.ctc/replays/<id>.json` (diff, rules, explanations,
  suggested fixes; newest 200; diff withheld when a secret was found; `CTC_REPLAY=off`). `ctc replay [id|--last|--list]`,
  a dashboard page at `/replay/<repo>/<id>`, and the MCP tool `ctc_replay`. Findings-log records link to it (`replay`).
- Agent report card: the MCP server records the client's `clientInfo` (name, version) in each findings-log record
  (`client`); `CTC_AGENT` and `CTC_MODEL` cover other surfaces. `ctc report-card [--json]` and a dashboard section show
  decisions, hold rate, top rules and median attempts to clear by agent and model.
- `ctc suggest-rules [--accept <id>]`: deterministic policy suggestions (graduate observe-mode codes, lock a rule in the
  directory where its holds concentrate, forbid a repeatedly attempted module); `--accept` writes `.ctc/policy.json`.
- `ctc badge`: "gated by VectorCTC · hold rate X%" SVG and shields.io endpoint JSON from local data, plus a README snippet.
- `ctc init` adds `replays/` to `.ctc/.gitignore`.

### Changed
- License: Apache License 2.0 (was MIT, never published under it). `NOTICE` added.

## Unreleased (launch-ready, folded into 0.5.0)

### Security
- Behaviour sandbox: closed a `vm` escape (`this.constructor.constructor("return process")()` and host objects passed
  into the context) that let code under test reach the host `process`, `process.getBuiltinModule`, `fetch` and network
  sockets. The context now gets no host objects (`vm.constants.DONT_CONTEXTIFY` or a null-prototype sandbox), and the
  child strips `fetch`, `require`, `getBuiltinModule`, bindings and `dlopen` before running anything.
- Behaviour sandbox now uses `--experimental-permission` on Node versions that do not accept `--permission`
  (Node 20, early 22), instead of silently skipping the check.
- Dependencies: zod 4, minimatch 11, ts-morph 28, vitest 4. `npm audit` goes from 7 findings (1 high, 2 critical) to 0.

### Privacy
- The optional semantic review step no longer turns itself on just because `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
  happens to be in the environment. It needs `CTC_SEMANTIC_API_KEY` / `CTC_SEMANTIC_API_KEY_FILE`, or `CTC_SEMANTIC=on`.

### Fixed (found in the launch audit)
- **The installed CLI did nothing.** The entry-point guard compared the symlinked bin path (`node_modules/.bin/ctc`)
  with the real file, so `npx vectorctc …` and any npm install exited silently. Now compares real paths.
- **Agent MCP configs did not start the server.** `ctc init --agent …` wrote the CLI command without `serve`, so every
  agent launched the help text and the MCP connection failed. All MCP config writers now append `serve`.
- Git installs (the pre-commit hook, `github:` dependencies) got no `dist/`; `prepare` now builds, installing
  devDependencies locally when npm's global git-dependency install leaves them out.
- Git hooks held every commit touching files outside the milestone's `allowedPaths` (package.json, README, configs).
  Scope holds at commit time are now opt-in (`ctc git-guard <kind> --scope`), matching `ctc ci`.
- `ctc init` writes `.ctc/.gitignore` for runtime logs, so the pre-commit hook no longer modifies tracked files.
- Git hooks no longer print `fatal: invalid object name 'HEAD'` on a repository's first commit.

### Packaging
- Package renamed to `vectorctc` (bins `ctc` and `vectorctc`); MCP server id stays `code-traffic-control` so existing
  agent configs keep working.
- `npx vectorctc init` writes `npx -y vectorctc@<version>` into agent configs instead of the temporary npx cache path.
  `CTC_COMMAND` overrides the command.
- `files` excludes source maps; `prepare` builds; `prepublishOnly` runs lint, typecheck, build and tests.
- LICENSE (MIT draft, replaced by Apache 2.0 in 0.5.0), THIRD_PARTY_NOTICES.md, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue and PR templates.
- CI workflow (Node 20/22/24, lint, typecheck, build, tests, pack smoke test, `npm audit`), manual release workflow
  with npm provenance. ESLint added.

## 0.4.0 — 2026-11-24
- Behavioural layer: differential testing of modified functions (`BEHAVIOR_CHANGED`), behavioural-equivalence
  duplicates (`DUPLICATE_BEHAVIOR`), required-arity growth on exports (`SIGNATURE_BREAK`), in a sandboxed child.
- Explainable holds (`ctc.explain.v1`) with fix patches, `ctc fix` / `ctc_apply_fix`, fix ledger.
- Agent rule files (AGENTS.md, CLAUDE.md, `.cursorrules`, Cursor rules, Copilot instructions) compiled to rules;
  layered policy-as-code with enforce / observe / off.
- Security checks: secrets, SAST with CWE ids, dependency advisories (offline OSV seed, `ctc advisories sync`).
- `ctc ci` + GitHub Action, pre-commit hook, gated `ctc init --agent cursor|claude|copilot`.
- Python and Go via web-tree-sitter; cross-repo impact; ticket intent; UI wireframe contracts (`ctc wireframe`).
- Local dashboard; hash-chained findings / audit log.
- Preview only: VS Code extension scaffold (`integrations/vscode`, not published) and OIDC actor verification (stub).

## 0.3.0 — 2026-11-23
- Optional bring-your-own-key semantic review step with a deterministic evidence filter.
- Export-scope and edit-scope checks; faster warm checks in long-lived `ctc serve`.

## 0.2.0 — 2026-11-23
- Benchmark-driven fixes to duplicate, phantom-symbol, dead-code and scope rules.

## 0.1.0 — 2026-11-16
- Runway Gate: milestone scope, locks, banned imports, naming, boundaries, duplicates, phantom symbols, dead code.
- MCP server (stdio + Streamable HTTP), CLI, REST API, git hooks, watch-and-revert, agent config writers.
