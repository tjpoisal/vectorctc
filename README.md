# VectorCTC — Code Traffic Control

VectorCTC (Code Traffic Control, CTC) is a local guardrail between an AI coding agent and the filesystem. Cursor, Claude Code, Copilot and other agents propose a change; CTC parses it in memory, runs the Runway Gate (scope, architecture, phantom symbols, duplicates, dead code, behaviour changes, secrets, and more), and lets the write land only when every check passes. A hold comes back as a self-correction payload the agent fixes and resubmits. The bad bytes never land.

- **Deterministic and local.** Same input, same answer. The gate makes no network calls by default (see [Privacy](#privacy-and-telemetry)).
- **Before the write, not after the PR.** It runs as an MCP server, agent hooks, git hooks, or a CI check.
- **Node.js MCP server and CLI**: strict TypeScript, the official MCP SDK, Zod, ts-morph, and web-tree-sitter for Python and Go.

Website: <https://vectorctc.com> · License: Apache 2.0 (see `LICENSE` and `NOTICE`) · Security: `SECURITY.md`

> **Status:** pre-release. The npm package `vectorctc` is **not published yet**; until it is, install from source (below).

## Install

Requires **Node.js 20.11 or newer** (22 or 24 recommended).

Once published:

```bash
npx vectorctc try                      # zero setup: what the gate would have held in your last 50 commits (read-only)
npx vectorctc init --agent auto        # in your project: writes ctc.config.json and wires up detected agents
# or
npm install --save-dev vectorctc && npx ctc init --agent cursor
```

From source today:

```bash
git clone https://github.com/tjpoisal/vectorctc.git
cd vectorctc && npm ci && npm run build
cd /path/to/your/project && node /path/to/vectorctc/dist/index.js try          # optional trial, changes nothing
cd /path/to/your/project && node /path/to/vectorctc/dist/index.js init --agent auto
```

## Quick start

```bash
ctc init --agent cursor          # or claude, copilot, or a comma list; --strict denies native edit tools where possible
ctc scan . --write               # optional: derive a starting policy from the repo
ctc check src/file.ts            # gate one file (exit 0 clear, 2 hold, 1 error)
ctc serve                        # MCP server on stdio (agents spawn this; ctc init writes the config for you)
```

`init` writes `ctc.config.json` and a `.ctc/` directory (add `.ctc/` to `.gitignore` if you do not want the local logs committed). `--agent cursor|claude|copilot` uses the gated setup: the MCP server plus the strongest edit routing each agent allows (see [Integration matrix](#integration-matrix)).

## MCP configuration

`ctc init --agent …` writes these for you. To do it by hand (replace `npx -y vectorctc` with `node /path/to/vectorctc/dist/index.js` when running from source):

**Cursor** — `.cursor/mcp.json`

```json
{ "mcpServers": { "code-traffic-control": { "command": "npx", "args": ["-y", "vectorctc", "serve"], "env": { "CTC_ROOT": "." } } } }
```

**Claude Code** — `.mcp.json` (or `claude mcp add code-traffic-control -- npx -y vectorctc serve`)

```json
{ "mcpServers": { "code-traffic-control": { "command": "npx", "args": ["-y", "vectorctc", "serve"], "env": { "CTC_ROOT": "." } } } }
```

**GitHub Copilot (VS Code agent mode)** — `.vscode/mcp.json`

```json
{ "servers": { "code-traffic-control": { "type": "stdio", "command": "npx", "args": ["-y", "vectorctc", "serve"], "env": { "CTC_ROOT": "${workspaceFolder}" } } } }
```

MCP alone is advisory (the agent can still use its native write tool). For enforcement add the agent hook (Claude Code `PreToolUse`, Cursor `preToolUse` on `Write`) — `ctc init --agent claude|cursor` does this — and/or git hooks (`ctc install-git-hooks`) and the CI check.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CTC_ROOT` | Project root (else CTC walks up to `ctc.config.json`). `--root` overrides it. |
| `CTC_BEHAVIOR=off` | Disable the behavioural (code-executing) checks. |
| `CTC_BEHAVIOR_BUDGET_MS` | Wall-clock budget for behavioural checks per gate call (default 400). |
| `CTC_BEHAVIOR_PERSISTENT=0` | Use a one-shot sandbox child per call instead of a long-lived one. |
| `CTC_SEMANTIC_API_KEY` / `CTC_SEMANTIC_API_KEY_FILE` | Opt in to the optional semantic review step with your own key. |
| `CTC_SEMANTIC=on` / `off` | Opt in using an existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or force the step off. |
| `CTC_SEMANTIC_PROVIDER`, `CTC_SEMANTIC_BASE_URL`, `CTC_SEMANTIC_MODEL`, `CTC_SEMANTIC_JSON_MODE` | Semantic step provider settings (see [Semantic review](#semantic-review-optional-v03)). |
| `CTC_FINDINGS_LOG=off` | Do not write `.ctc/findings.jsonl`. |
| `CTC_AUDIT_HMAC_KEY` | HMAC-sign each findings-log record. |
| `CTC_ACTOR` | Free-text actor name recorded in the findings log. |
| `CTC_AGENT` | Agent name for the report card when there is no MCP client info (CLI, hooks, CI). |
| `CTC_MODEL` | Model id for the report card. MCP does not tell the server which model the client uses, so this is the only source. |
| `CTC_REPLAY=off` | Do not store replays of held writes in `.ctc/replays/`. |
| `CTC_HTTP_TOKEN` | Bearer token required by `ctc serve --http`. |
| `CTC_COMMAND` | Command written into agent configs and git hooks (default: this install, or `npx -y vectorctc@<version>` when run via npx). |
| `UNIMATRIX_API_KEY` | Key for the optional Unimatrix memory sync (off unless `unimatrix.enabled`). |

## Privacy and telemetry

VectorCTC has **no telemetry** and does not phone home. With default settings it makes no network requests at all. Network use happens only when you opt in:

| Feature | When | Where it connects |
| --- | --- | --- |
| Semantic review step | `CTC_SEMANTIC_API_KEY(_FILE)` set, or `CTC_SEMANTIC=on` with a vendor key | Your chosen OpenAI-compatible or Anthropic endpoint (the diff and nearby code are sent) |
| `ctc advisories sync` | You run it | api.osv.dev (package names and versions from your lockfiles) |
| Unimatrix memory sync | `unimatrix.enabled: true` | The configured Unimatrix endpoint |
| GitHub Action `--github` | In your CI | GitHub API (PR comment / review) |

Written locally under `.ctc/` in your repo: `findings.jsonl` (gate decisions: file path, rule codes, line numbers, timing, optional actor — never file contents), `radar.jsonl` (decision log), `state.json` (circuit breaker and handoff), `fix-ledger.json`, `replays/` (v0.5: the diff of each held or observed write, its rules and fixes, newest 200; a change containing a secret is stored without its diff; `CTC_REPLAY=off` disables), `badge/` (only when you run `ctc badge`), `violations.jsonl` and `snapshots/` (only with `ctc watch`; snapshots contain file contents), `advisories.json`, `wireframes/`. Nothing leaves the machine unless you commit or share it.

## Benchmark (honest summary)

We built a small pre-registered benchmark (answer keys hash-locked before scoring) of agent-style changes to real open-source TypeScript repos, each case either a seeded defect or a clean change. The raw results, rubric and caveats are in the benchmark repo; the scoreboard is on vectorctc.com.

| Set | Cases (defects / clean) | VectorCTC v0.4 | Greptile | Qodo | CodeRabbit | Graphite |
| --- | --- | --- | --- | --- | --- | --- |
| Original (dev set) | 21 / 11 | 21/21 caught, 0 false positives | 21/21, 2 FP | 19/21, 5 FP | 15/21, 3 FP | 4/21, 0 FP |
| Held-out 1 (dev set) | 11 / 4 | 11/11, 0 FP | 7/11, 0 FP | 7/11, 1 FP | 5/11, 1 FP | 1/11, 1 FP |
| Held-out 2 | 11 / 4 | 11/11, 0 FP | not run | not run | not run | not run |
| Held-out 3 (not blind) | 10 / 5 | 10/10, 0 FP | not run | not run | not run | not run |

Caveats, please read them:
- **Small samples.** 10/10 has a 95% confidence interval of roughly 72–100%.
- **Same author** wrote the gate, the cases and the rubric. The original and held-out-1 sets were used during development. Held-out 3 was written after earlier misses were known (locked before the code that catches them existed), so it is not blind.
- **Different stages.** VectorCTC gates writes before they land, with a task scope; the PR reviewers saw finished pull requests. Reviewers were run once (2026-11-23), on free plans or trials, on the original and held-out-1 sets only.
- **Latency.** Warm median per check in a long-lived server: about 150 ms (original), 197 ms and 225 ms on the held-out sets; p95 up to about 660 ms.
- The optional semantic (LLM) step was **not** used in any of these numbers.

## Preview features

- **VS Code extension** (`integrations/vscode/`): a scaffold, not published to the Marketplace. Coming soon.
- **OIDC-verified actor** (`ctc whoami`, `docs/enterprise/sso.md`): preview stub. It verifies an ID token offline against a JWKS file you pin; there is no login flow, JWKS fetching or SAML. Coming soon.

## What's new in v0.5

Five tools built on the local findings log. All of them run offline and read only what is already in `.ctc/`.

| Command | What it does |
| --- | --- |
| `ctc try [--commits 50] [--timeout 60]` | Zero-setup trial. Replays your last N commits (first-parent, newest first) through the gate and prints what it would have held, by rule. It works in a throwaway `git clone --shared` in the OS temp directory, infers a config there if you have none, deletes the clone, and never writes to your repo. It stops at the time limit and says how many commits it covered. Also `npx vectorctc try` once the package is published. |
| `ctc replay [id] [--last] [--list] [--json]` | "Why it held." Shows the attempted change as a diff, each rule broken, why the rule exists and the suggested fix. The local dashboard has the same page at `/replay/<repo>/<id>`, and the MCP tool `ctc_replay` returns it to the agent. |
| `ctc report-card [--days 30] [--json]` | Agent report card: decisions, hold rate, top rules and median attempts to clear, by agent and model. The agent comes from the MCP client's `clientInfo` (recorded in the findings log), else `CTC_AGENT`, else `CTC_ACTOR`. The model comes only from `CTC_MODEL`. Also a section of `ctc dashboard`. |
| `ctc suggest-rules [--accept <id>]` | Reads the hold history and proposes repo-specific policy entries: enforce a code that keeps firing in observe mode, lock a rule in the directory where its holds concentrate, or forbid a module agents keep reaching for. Deterministic heuristics, no model. `--accept` merges one into `.ctc/policy.json` and validates it. |
| `ctc badge [--repo owner/name]` | Writes `.ctc/badge/vectorctc.svg` ("gated by VectorCTC · hold rate X%") and a shields.io endpoint JSON from local data only, and prints a README snippet. |

## What's new in v0.4

Each item lists the command or file that proves it. Details are in `V04-PROGRESS.md`.

| Area | What | Where |
| --- | --- | --- |
| Explain the block | Every hold carries `ctc.explain.v1`: why the rule exists, a snippet, and a fix (revert-hunk / remove-lines / replace-literal / manual) with a unified diff. Secrets are redacted and never get a patch. | `ctc explain <file>`, MCP `ctc_explain` |
| Fix loop | `ctc fix` / MCP `ctc_apply_fix` applies the suggested fix and re-gates it. `.ctc/fix-ledger.json` tracks attempts and marks a finding *stuck* after 2. | `src/explain/` |
| Agent rule files as policy | AGENTS.md, CLAUDE.md, `.cursorrules`, `.cursor/rules/*.mdc`, Copilot instructions compile to enforceable rules (banned imports, forbidden code, locked paths, function length, JSDoc on exports). | `ctc rules import`, `src/policy/rulefiles.ts` |
| Policy as code | org → repo → directory layers, `locked` rules, `enforce` / `observe` / `off` per code, rule or glob, `forbid` regexes. Observe mode logs "would have blocked" without blocking. | `.ctc/policy.json`, `ctc policy explain|report|init` |
| Security | Secrets (provider patterns + entropy, CWE-798), high-precision SAST with CWE ids, dependency advisories from an offline OSV seed (1,709 advisories) and `ctc advisories sync`. | `src/security/` |
| CI | `ctc ci` gates merge-base..head, writes annotations and a sticky PR comment, scores risk factors, and can auto-approve (opt-in) only when every factor passes. Ticket acceptance criteria (flight plan ticket, or the PR body) get a coverage table. | `action.yml`, `examples/workflows/vectorctc.yml` |
| Pre-commit / editor | pre-commit framework hook; VS Code extension scaffold showing holds as diagnostics (**preview, not published**). | `.pre-commit-hooks.yaml`, `integrations/vscode/` |
| Gated init | `ctc init --agent cursor|claude|copilot [--strict]`: route edits through CTC, deny native writes where the agent supports it. | `src/universal/agents-gated.ts` |
| Python and Go | tree-sitter (wasm) parsing: phantom imports and symbols (stdlib tables, repo tree, requirements/pyproject/go.mod), duplicate logic, diff-aware length/complexity, `allowedEditSymbols`. Line-based fallback if the grammar is not loaded. | `src/lang/` |
| Cross-repo impact | Sibling repos in policy (`crossRepo.siblings`). Removing an export a sibling uses blocks with file:line; arity changes warn. | `ctc impact <file>`, `src/crossrepo/` |
| Ticket intent | "Out of scope / Do not change X" in the ticket blocks writes touching X; changes unrelated to the ticket warn (or block with `intent.unrelated: "enforce"`). | `src/intent/` |
| Wireframes | YAML/JSON layout spec → SVG; approve before UI code; drift (extra / missing / mistyped components, regions, routes) is held. | `ctc wireframe new|render|approve|list|check`, MCP `ctc_wireframe` |
| Behavioural checks | Each modified function runs old vs new on generated inputs (plus literal arguments from your tests) in a locked-down child process (`node --permission`, `vm`, frozen clock, stubbed imports). Output changes the plan does not ask for block when the plan says behaviour must be kept or the edit only adds optional parameters, and warn otherwise; the responsible line is found by reverting each changed line on its own. New small helpers that return the same results as an existing helper are held as duplicates even when worded differently. Exported functions that gain required parameters are held. Off with `CTC_BEHAVIOR=off`. | `src/behavior/` |
| Dashboard | Local, read-only team dashboard over the findings logs of one or more repos; static HTML export. | `ctc dashboard [--repo …] [--out file.html]` |
| Enterprise | Hash-chained (optionally HMAC-signed) audit log with SIEM export, OIDC-verified actor (**preview stub**), BYOK semantic step, self-host docs. | `docs/enterprise/`, `ctc audit verify|export`, `ctc whoami` |

## Running from a source checkout

```bash
node dist/index.js --help
npm run ctc -- status
node dist/index.js scan fixtures/sample-project
```

`scan` is read-only unless you pass `--write`, which also saves `.ctc/flightplan.json`. `serve` speaks MCP over stdio and must be the process the agent spawns. It does not print logs on stdout.

## Blueprint workflow

The task contract lives next to the milestone gate. `ctc_onboard_idea` does not call a model. The agent sends the decomposition (components, invariants, boundaries, banned packages, and tasks). CTC validates it with Zod, rejects a missing `dependsOn` or a cycle, and writes `.ctc/blueprint.json`. An idea with no tasks comes back as questions plus a template.

`ctc_promote_task_to_flight_plan` requires every dependency to be `DONE`, marks that one task `IN_PROGRESS`, and writes `.ctc/flight-plan.json`. `allowedFileGlobs` is the task's `targetFiles`. `ctc_write_file` and `ctc_patch_file` refuse anything outside those globs, check canaries and invariant patterns, then run `RunwayGateAnalyzer` (`src/gate/`). The rules are phantom symbols (TS2339, TS2304, TS2554, TS2305, TS2307, TS2724, TS2551, TS2552), duplicate logic, dead-code regression, long methods (40 lines or complexity over 10), naming, import boundaries, cross-file breaking changes, and (when the plan lists `allowedNewExports`) export scope. Complexity, length, naming and dead code compare with the pre-edit file, so only new or worsened findings block. `enabled: false` switches in `ctc.config.json` apply to the gate too (`rules.phantom.gate: false` switches off its symbol check). A failed check does not touch the file. The overlay on the TypeScript project is restored before the call returns.

`ctc_update_task` can set `TODO`, `IN_PROGRESS`, or `BLOCKED` directly. `DONE` re-runs the analyzer on every concrete target file. Glob targets are not required to exist as single files.

`ctc_propose_write`, `ctc_propose_patch`, `ctc_check_flightplan`, `ctc_log_decision`, and `ctc_query_radar` stay on the milestone gate (`allowedPaths`, locks, the per-file breaker). A RED lock from the read radar also holds those writes until it is cleared.

## Read radar

`ctc_read_file` estimates tokens as characters / 4. That is not a model tokenizer. Under 40% of a 128,000-token window is GREEN. 40–65% is YELLOW. Over 65% is RED. The second identical read of the same file and line range is YELLOW even when the estimate is still low, and a whole TypeScript file then comes back with function bodies replaced by a comment. The third identical read locks RED. Three consecutive `ctc_write_file` / `ctc_patch_file` failures lock RED as well.

The lock writes a ground-crew handoff into `.ctc/state.json` (the breaker fields stay on that file). `bootstrapPrompt` is the clean-slate note. Clear the lock by reading `.ctc/state.json`, passing a new `sessionId`, or running `ctc reset`.

Try the fixture:

```bash
node dist/index.js scan fixtures/sample-project
```

That project imports `react` (declared) and `left-pad` (not declared). The suggested config locks `package-lock.json`, sets `activeMilestone.allowedPaths` to `src/**`, and bans `left-pad`. `fixtures/detected-stack` is the architecture scan: Prisma and Drizzle schemas, a Zustand store, an axios client, and a tRPC client are suggested locks, and raw `fetch(` under `src/components/**` is pointed at `useInvoices`.

## Configure

`ctc.config.json` is validated with Zod. Unknown keys are rejected. `version` defaults to `1`.

| Field | Required | Meaning |
| --- | --- | --- |
| `activeMilestone` | yes | `{ id, title, allowedPaths, status }`. `status` is `active` or `locked`. A locked milestone rejects every write. `allowedPaths` is the ceiling. |
| `lockedFiles` | no | Globs or repo-relative paths that agents cannot land. `ctc.config.json` and `.ctc/**` are always locked. |
| `bannedImports` | no | `{ pattern, reason, useInstead }`. A bare package name also matches its subpaths (`axios` matches `axios/lib`). Globs are allowed. `useInstead` is the Required Action shown to the agent. |
| `restrictedCalls` | no | `{ callPattern, inPaths, useInstead }`. The call is rejected only in files matching `inPaths`. `**` means everywhere. `eval` matches `eval(...)` and `window.eval(...)`. Dotted names such as `document.write` match that callee exactly. `new Function` is treated as a call. |
| `degradation.maxFunctionLength` | no | Maximum function length in lines. `null` disables the rule. |
| `degradation.maxCyclomaticComplexity` | no | Maximum cyclomatic complexity per function. `null` disables the rule. |
| `degradation.flagUnusedImports` | no | Reject unused import bindings. Default `false`. `ctc scan` turns it on. |
| `circuitBreaker.maxStrikes` | no | Consecutive rejections of the same file before that file's breaker opens. Default `3`. |

See [`ctc.config.example.json`](ctc.config.example.json).

A persisted flight plan at `.ctc/flightplan.json` narrows `allowedPaths`. Create one with `ctc_check_flightplan` (`persist: true`) or `ctc scan --write`. A write must match the milestone's allowed paths and, when a plan is saved, the plan. A path outside that ceiling is a RUNWAY INCURSION. A milestone with `status: "locked"` is a RUNWAY INCURSION for every write.

Paths are repo-relative and posix. `..` segments that leave the project are rejected. Matching is lexical: a symlink inside the root that points outside it is not resolved. Treat that as a V1 limit.

## Runway Gate

The CLI is `src/index.ts`. Config schemas for `ctc.config.json` and `flightplan.json` live in `src/config/schema.ts`. The gate is `src/engine/runway-gate.ts`, with the flight plan in `src/engine/flight-plan.ts`, the radar log in `src/engine/radar-memory.ts`, and per-file strikes in `src/engine/circuit-breaker.ts`. `ctc scan` is `src/scanner/repo-scanner.ts`. The MCP server is `src/mcp/server.ts`. Rule modules under `src/engine/rules/` run through `runRules`. Every rule runs. CTC does not stop at the first failure, so one resubmit can fix the whole set. Nothing is written unless the list is empty.

1. **Lock gate.** `lockedFiles`, plus the control files named above.
2. **Flight-plan scope gate.** Active milestone `allowedPaths`, then the persisted plan if it belongs to that milestone. A miss is labeled `RUNWAY INCURSION`. A plan for a different milestone is a runway incursion too. `status: "locked"` rejects every write.
3. **AST contract gate.** ts-morph parses the proposal in an in-memory project. Imports (including `export ... from`, `import x = require(...)`, and `import("...")`) are checked against `bannedImports`. Call and `new` expressions are checked against `restrictedCalls`. Line and column point at the specifier or the callee.
4. **Degradation rules**, when configured. Function length, cyclomatic complexity (decision points, `&&` / `||`, and `case` labels, not counting nested functions), and unused import bindings.
5. **Circuit breaker.** Strikes are counted per file in `.ctc/state.json`. The third consecutive rejection of the same file opens the breaker for that file. The hold then includes `[CTC CIRCUIT BREAKER — HUMAN OVERRIDE REQUIRED]`. A clean rewrite of that file does not land and does not clear the strikes. Other files are unaffected. `ctc_log_decision` with `decision: "waived"` clears every open file. A file that lands before its third strike resets only its own count. Checking a flight plan does not move the strike count.

Additional rules live in the same list and can be turned off under `rules` in `ctc.config.json`. Defaults: naming off, duplicate detection on, dead-code regression on, phantom symbols off, read zones advisory.

| Rule | What it does |
| --- | --- |
| `rules.naming` | camelCase functions (including `const` arrows), PascalCase types, camelCase or `UPPER_SNAKE` variables. PascalCase names in `.tsx` / `.jsx` are treated as components and skipped. If `customHookPrefix` is set, a function that calls a hook must start with that prefix. Variable misses are warnings. |
| `rules.boundaries` | Layer bans. `sourcePattern` is a path or glob. Package bans match the package name (`pg` does not match `postgres` or `pg-pool`). Relative imports are resolved from the file (`../../db/client` from `src/components/pages` is `src/db/client`). |
| `rules.duplicates` | Exact structural hash after alpha-renaming, plus Jaccard similarity on token shingles. A MinHash signature (default 64 permutations) is a candidate filter once the index is large; every smaller index is compared directly. The gate suggests `import { name } from "src/utils/file.ts"`, a repo-relative specifier. The index is built from `utilityGlobs` and updated after a landing. `duplicateWarnThreshold` must be lower than `duplicateBlockThreshold`. Near matches at or above the warn threshold and below the block threshold are warnings. |
| `rules.phantom` | After the cheap rules pass, overlays the proposal on a tsconfig-backed project, reads TypeScript diagnostics for missing symbols and bad calls, and always restores the previous text. Over budget, the findings are discarded and a warning is recorded. Off unless a `tsconfig.json` is present and the rule is enabled. |
| `rules.deadCode` | Blocks unused imports, locals, params, and unexported functions that were not already unused on disk. The baseline is parsed in memory. |
| Breaking changes (gate) | When an exported name is removed or its signature, return type or members change, every importer in the tsconfig project (and callers of a barrel that re-exports it) is type-checked against the old and new text. Errors only the new text causes block as `BREAKING_CHANGE`, reported at the changed export with the broken caller's `file:line`. Turn off with flight-plan `disabledRules: ["breakingChange"]`. |
| Flight-plan `allowedNewExports` | Optional. When present, any export the edit adds that is not on the list blocks as `EXPORT_NOT_IN_PLAN`. Existing exports are never flagged. |
| Flight-plan `allowedEditSymbols` (v0.3) | Optional. When present, changing or removing an existing top-level declaration (or a class member, unless its class is listed) that is not on the list blocks as `EDIT_OUTSIDE_PLAN_SCOPE`. Imports are ignored. A file outside `allowedPaths` is still a runway incursion. |
| `rules.conventions` (v0.3, on by default) | Deterministic. Infers units from names (`Ms`, `_MS`, `Cents`, `Seconds`, `Dollars`), `getTime()` / `Date.now()`, duration constants and JSDoc, including the pre-edit JSDoc. Blocks changed lines that mix units (`UNIT_MISMATCH`, including `setTimeout` arguments) or return a unit other than the documented one (`UNIT_CHANGE`, unless the objective names the new unit). Blocks a `<` / `<=` / `>` / `>=` flip in a function that is exported or called (`BOUNDARY_FLIP`, listing call sites and tests) unless the objective talks about the boundary. Turn off with `disabledRules: ["conventions"]`. |
| Duplicates, v0.3 additions | Also indexes `src/**/_*.*`, `internal`, `helpers` and `shared` files, compares a new function with existing functions in the same file, and ignores one-line delegations such as `return other(x)`. |
| Dead code, v0.3 additions | Unused `private` / `#private` class members that the edit introduces. |
| Boundaries, v0.3 additions | An import that reaches a banned module through a barrel re-export is resolved to the origin and reported. |
| `rules.semantic` (v0.3, optional) | Model-based review; see below. |
| Flight-plan `canaries` and `invariants` | A canary's `requiredPattern` must still match. An invariant's `forbiddenPattern` must not match and its `requiredPattern` must. Patterns are rejected when they are long or contain a nested quantifier. `planId` and `createdAt` are generated when omitted. |

Latency: a long-lived process (`ctc serve`, `ctc serve --http`) keeps one TypeScript project per root between checks and re-reads only project files whose mtime changed (deleted files are dropped; brand-new files outside the edited one are picked up when the project is rebuilt, e.g. on restart). The duplicate index is cached per file the same way. A one-shot `ctc check` still pays Node startup and a full project load on every call; use `serve` when an agent checks many writes.

### Semantic review (optional, v0.3)

After the deterministic rules pass, the gate can ask a model to compare the diff with the flight plan objective and the surrounding code. It is off by default and skipped cleanly unless you opt in, and every deterministic check still runs. The pre-write check stays synchronous when the step is off.

| Env var | Meaning |
| --- | --- |
| `CTC_SEMANTIC_API_KEY` (or `CTC_SEMANTIC_API_KEY_FILE`) | Turns the step on (explicit opt-in). |
| `CTC_SEMANTIC=on` | Opt in using an existing `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. An ambient vendor key alone never sends code anywhere. |
| `CTC_SEMANTIC_PROVIDER` | `openai` (any OpenAI-compatible `/chat/completions`) or `anthropic`. Inferred from the key when unset. |
| `CTC_SEMANTIC_BASE_URL`, `CTC_SEMANTIC_MODEL` | Endpoint and model. Defaults: `https://api.openai.com/v1` with `gpt-4.1-mini`, or `https://api.anthropic.com` with `claude-sonnet-4-5`. |
| `CTC_SEMANTIC_JSON_MODE` | `1` to send `response_format: json_object` to OpenAI-compatible servers. |
| `CTC_SEMANTIC=off` | Disables the step even when a key is set. |

`rules.semantic` in `ctc.config.json`: `enabled` (default true once you have opted in with a key), `mode` `block` or `warn`, `minConfidence` (0.8), `maxFindings` (3), `timeoutMs` (30000). The model is not called when deterministic rules already hold the write. Its findings go through a deterministic filter that drops: malformed items, categories outside the reportable list (behaviour change, unit change, boundary change, plan mismatch, scope creep, contract break), confidence below the minimum, lines outside the edit (±2), findings without evidence or whose evidence is not on the cited line, speculative or style wording, repeats of a deterministic finding, and anything past the limit. Kept findings become `SEMANTIC_*` violations. Provider errors and timeouts fail open with a warning.

Out of scope without the semantic step: semantic changes that keep the same types and carry no unit or boundary signal, such as flipping a boolean default or changing rounding. Those need tests, canaries or invariants.

`ctc init` leaves the degradation rules off. `ctc scan` suggests length 80, complexity 12, and unused-import checks, because a scan is producing a starting policy rather than a blank one.

## Self-correction payload

Holds use `protocol: "ctc.hold.v1"`. This is the V1 contract:

```json
{
  "protocol": "ctc.hold.v1",
  "cleared": false,
  "written": false,
  "gate": "ast",
  "file": "src/api.ts",
  "strikes": 1,
  "maxStrikes": 3,
  "circuit": "closed",
  "violations": [
    {
      "code": "BANNED_IMPORT",
      "rule": "bannedImports",
      "gate": "ast",
      "file": "src/api.ts",
      "line": 3,
      "column": 19,
      "message": "Import \"axios\" is banned: Use the project fetch client.",
      "fix": "Import src/lib/http.ts instead of \"axios\". Use the project fetch client.",
      "useInstead": "src/lib/http.ts"
    }
  ],
  "bytesWritten": null,
  "selfCorrection": "[CTC RUNWAY GATE — WAVE OFF]\nFile: src/api.ts\nViolation: BANNED_IMPORT at line 3: Import \"axios\" is banned: Use the project fetch client.\nRequired Action: src/lib/http.ts\n..."
}
```

MCP tool errors (`isError: true`) lead with that same block, then the JSON:

```
[CTC RUNWAY GATE — WAVE OFF]
File: src/api.ts
Violation: BANNED_IMPORT at line 3: Import "axios" is banned: Use the project fetch client.
Required Action: src/lib/http.ts
```

When the breaker is open for that file, the block also contains `[CTC CIRCUIT BREAKER — HUMAN OVERRIDE REQUIRED]`.

`gate` is the highest-priority violation: `circuit`, then `lock`, `scope`, `config`, `ast`. Violation codes include `LOCKED_FILE`, `RUNWAY_INCURSION`, `BANNED_IMPORT`, `RESTRICTED_CALL`, `FUNCTION_TOO_LONG`, `COMPLEXITY`, `UNUSED_IMPORT`, `NAMING_DRIFT`, `BOUNDARY_VIOLATION`, `DUPLICATE_LOGIC`, `PHANTOM_SYMBOL`, `DEAD_CODE_REGRESSION`, `CANARY_AMNESIA`, `INVARIANT_VIOLATION`, `PATCH_NOT_FOUND`, `PATCH_AMBIGUOUS`, `PATH_ESCAPE`, `CONFIG_INVALID`, and `CIRCUIT_OPEN`. Warnings share that shape with `severity: "warn"` and do not hold the write. Each violation carries `useInstead` when the rule names a replacement.

A landing that CTC itself wrote uses `protocol: "ctc.cleared.v1"`, `written: true`, `strikes: 0`, and `selfCorrection: null`. A flight-plan check that passes uses `protocol: "ctc.flightplan.v1"` and does not reset strikes. Radar reads use `protocol: "ctc.radar.v1"`.

## MCP tools

`ctc serve` registers the milestone tools and the blueprint tools:

| Tool | What it does |
| --- | --- |
| `ctc_onboard_idea` | Validate a structured blueprint. No model call. Missing tasks return questions and a template. |
| `ctc_promote_task_to_flight_plan` | Check dependencies, mark one task `IN_PROGRESS`, and activate `allowedFileGlobs` from its `targetFiles`. |
| `ctc_update_task` | Change a task status. `DONE` requires every concrete target file to pass the analyzer. |
| `ctc_write_file` | Flight-plan scope, canaries, invariants, then the six-rule analyzer. Writes the file only when every check passes. |
| `ctc_patch_file` | Literal unique search/replace, then the same checks as `ctc_write_file`. `$` is copied literally. |
| `ctc_read_file` | Estimated tokens and identical-read tracking. The second identical read is yellow and returns signatures. The third locks red. |
| `ctc_propose_write` | Milestone gate. Full file contents in, disk write only on a clear. |
| `ctc_propose_patch` | Milestone gate. Literal search/replace, then the same checks as `ctc_propose_write`. |
| `ctc_check_flightplan` | Check paths or globs against the milestone ceiling and locks. `persist: true` saves `.ctc/flightplan.json`. |
| `ctc_log_decision` | Append a cleared, rejected, noted, or waived decision. A waiver resets the per-file breaker unless `resetCircuit` is false. |
| `ctc_replay` | v0.5: the stored replay of a held write (diff, rule, why, fix). No id: the newest. `list: true`: recent ids. |
| `ctc_query_radar` | Newest radar entries first. Filter by `gate`, `path`, `decision`, `source`, or `since`. When Unimatrix is configured, the response also includes `memories`. |

Pass `projectRoot` when the server was not started in the project. Otherwise CTC walks up from the working directory, or from `CTC_ROOT`, until it finds `ctc.config.json`.

For a task under a blueprint, agents should call `ctc_write_file` or `ctc_patch_file`. `ctc_propose_write` remains the milestone gate. On a hold, they edit the proposal and call again. They should not route around CTC with another write tool.

## Claude Code (manual)

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "code-traffic-control": {
      "command": "node",
      "args": ["/absolute/path/to/vectorctc/dist/index.js", "serve"],
      "env": {
        "CTC_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

If this package is installed in the target project, `npx --no-install ctc serve` works as the command and CTC finds `ctc.config.json` from the project working directory.

Optional PreToolUse hook, for when the agent still has a raw Write or Edit tool. The hook runs the same gate, does not write the file, and denies the tool call on a hold. Add this to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|StrReplace",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/vectorctc/dist/index.js hook"
          }
        ]
      }
    ]
  }
}
```

`ctc hook` reads the hook JSON on stdin. A denial exits 2 and prints the self-correction text on stderr, and also prints the Claude Code `hookSpecificOutput` object on stdout. Reads and other tools are ignored. Edits are applied to the current file in memory; the hook denies the call when `old_string` is missing or ambiguous.

## Cursor hook

Cursor can deny a write before it lands. `preToolUse` with matcher `Write` is the pre-write hook (there is no `beforeFileEdit`). `ctc hook --cursor` prints `{ "permission": "deny" | "allow", "user_message", "agent_message" }`.

`.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "node /absolute/path/to/vectorctc/dist/index.js hook --cursor",
        "matcher": "Write"
      }
    ]
  }
}
```

Without that hook, Cursor's built-in Write tool does not pass through CTC. The MCP tools are then advisory: the agent can still write with the native tool. Disable or stop using the native write tools if you want the gate to be mandatory. `afterFileEdit` runs too late to reject a write.

## Cursor MCP (manual)

Project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "code-traffic-control": {
      "command": "node",
      "args": ["/absolute/path/to/vectorctc/dist/index.js", "serve"],
      "env": {
        "CTC_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Point `CTC_ROOT` at the repo that contains `ctc.config.json`. Ask the agent to land code through `ctc_propose_write`. The same `ctc hook` command can sit on a Cursor pre-tool hook if you deny `Write` and `StrReplace` there.

## CLI

| Command | Behavior |
| --- | --- |
| `ctc init` | Write a starter config. `--force` overwrites. `--agent <name>` writes that agent's config. `--agent auto` detects installed CLIs. |
| `ctc scan [dir]` | Print a scan report. `--write` saves the config and flight plan. `--force` overwrites. `--out` changes the config path. |
| `ctc serve` | MCP server on stdio. |
| `ctc serve --http --port 4317` | Streamable HTTP MCP at `/mcp`, plus the REST API, bound to `127.0.0.1`. |
| `ctc check <file>` | Analyzer only. Exit 0 pass, 2 hold, 1 error. `--content-from stdin` reads the proposal. `--json` prints `ctc.hold.v1` or `ctc.cleared.v1`. |
| `ctc apply <file>` | Write stdin when the analyzer passes. Same exit codes. |
| `ctc export-tools --format openai` | Function definitions for `openai`, `anthropic`, `gemini`, or `json-schema`. |
| `ctc install-git-hooks` | `pre-commit` and `pre-push` run the analyzer. Files outside the milestone's `allowedPaths` are not held at commit time unless the hook runs `ctc git-guard <kind> --scope` (same default as `ctc ci`). |
| `ctc watch --revert` | Watch the tree, append `.ctc/violations.jsonl`, restore `.ctc/snapshots` on a hold. |
| `ctc status` | Milestone, breaker, flight plan, recent radar. `--json` for machines. `--limit` controls the radar window. |
| `ctc reset` | Clear the RED read lock and the consecutive gate-failure counter. |
| `ctc hook` | PreToolUse hook. `--cursor` prints a Cursor permission response. |
| `ctc ci` | v0.4: gate a PR diff; `--markdown`, `--github`, `--auto-approve`, `--observe`, `--ticket`. |
| `ctc explain <file>` / `ctc fix <file>` | v0.4: explain the last hold; apply its fix and re-gate. |
| `ctc policy explain\|report\|init`, `ctc rules import` | v0.4: effective policy, observe-mode report, starter policy, compiled agent rule files. |
| `ctc advisories sync\|import\|audit` | v0.4: OSV advisories (the gate itself is offline). |
| `ctc wireframe new\|render\|approve\|list\|check` | v0.4: UI wireframe contracts. |
| `ctc impact <file>` | v0.4: where sibling repos use this file's exports. |
| `ctc dashboard` | v0.4: local team dashboard (`--out` for static HTML). |
| `ctc audit verify\|export`, `ctc whoami` | v0.4: audit log integrity, SIEM export, recorded identity. |
| `ctc try` | v0.5: replay the last N commits through the gate in a temp clone; prints holds by rule. Read-only. |
| `ctc replay [id]` | v0.5: why a write was held — diff, rule, explanation, suggested fix. |
| `ctc report-card` | v0.5: hold rate, top rules and attempts to clear by agent and model. `--json`. |
| `ctc suggest-rules` | v0.5: policy suggestions from the hold history; `--accept <id>` writes `.ctc/policy.json`. |
| `ctc badge` | v0.5: hold-rate SVG badge and shields.io endpoint JSON from local data. |
| `--root <dir>` | Project root. Overrides `CTC_ROOT`. |

`CTC_HTTP_TOKEN` is an optional bearer token for the HTTP server. Leave it unset for a localhost process with no token. `GET /openapi.json` stays open so a client can import the spec. `ctc check` does not count a hold toward the RED lock. `ctc apply` and `POST /v1/write` do.

When `.ctc/flight-plan.json` exists, check, apply, the REST API, git hooks, and watch use that blueprint contract. When it does not, they synthesize a flight plan from `ctc.config.json` (`allowedPaths`, package bans, naming patterns, thresholds) and still run `RunwayGateAnalyzer`. An invalid active flight plan is an error.

## Integration matrix

Every row uses the same analyzer. **Enforces** means a bad write is denied or restored without the model choosing to cooperate. **Advisory** means the model can still use a native write tool. Git hooks enforce at commit and push either way.

| Agent | Method | Effect |
| --- | --- | --- |
| Claude Code | MCP (`.mcp.json`) plus PreToolUse hook | Enforces when the hook is installed. MCP alone is advisory. |
| Cursor | MCP (`.cursor/mcp.json`) plus `preToolUse` matcher `Write` | Enforces for the Write tool when the hook is installed. Other native edits stay advisory. |
| Windsurf / Devin | MCP `mcpServers` | Advisory. Cascade can still edit files itself. |
| Cline | MCP `mcpServers` snippet for the global settings file, plus `AGENTS.md` | Advisory until the snippet is merged and the tools are used. |
| Roo Code | Project `.roo/mcp.json` | Advisory for native edits. MCP writes are enforced. |
| Gemini CLI | `.gemini/settings.json` `mcpServers` | Advisory for native edits. MCP writes are enforced. `GEMINI.md` tells the model to use CTC. |
| OpenCode | `opencode.json` `mcp.servers` | Advisory for native edits. MCP writes are enforced. |
| Codex CLI | `.codex/config.toml` `mcp_servers` | Advisory for native edits. MCP writes are enforced. |
| Zed | `.zed/settings.json` `context_servers` | Advisory for native edits. MCP writes are enforced. |
| Continue | `.continue/mcpServers/*.yaml` | Advisory for native edits. MCP writes are enforced. |
| Warp | `.warp/.mcp.json` | Advisory. Project MCP servers need a user approval before they spawn. |
| Google Antigravity | `.agents/mcp_config.json` | Advisory for native edits. MCP writes are enforced. |
| Aider | No MCP. `CONVENTIONS.md`, `.aider.conf.yml`, git hooks, `ctc watch` | Git hooks enforce at commit and push. The conventions file is advisory. `ctc watch --revert` enforces by restoring the last good snapshot. |
| Grok, DeepSeek, OpenAI-compatible | `ctc export-tools` plus REST, or the shell CLI | Enforces only when the model calls the tool or the shell before writing. Otherwise advisory. |
| Mobile and other agents | REST, CLI, git hooks, or watch | Same as the row above. A phone that can reach `127.0.0.1` on the machine running `ctc serve --http` can call the API. Git hooks still enforce on that machine. |

`ctc init --agent <name>` writes the file for that row and the instruction files `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/ctc.mdc`, and `.windsurfrules`. Names: `claude`, `cursor`, `windsurf`, `cline`, `roo`, `gemini`, `opencode`, `codex`, `zed`, `continue`, `warp`, `antigravity`, `aider`, `auto`. An unknown name gets `.ctc/agents/<name>.md` instead of a native config.

## Unimatrix

Unimatrix sync is off unless `unimatrix.enabled` is true. The API key is read from `UNIMATRIX_API_KEY` and is never written into `ctc.config.json`. Set `endpoint` (default `https://www.deployunimatrix.com/api`), and either `spaceId` (REST `POST /memories`) or `locationId` (MCP tool `unimatrix_store_memory`). Local `.ctc/` files stay the source of truth. A Unimatrix error does not block a landing, a hold, or a radar query.

When sync is on, CTC stores flight-plan invariants, `ctc_log_decision` entries, wave-off lessons (tags such as `ctc`, `gate-failure`, plus the file and repo), and ground-crew handoffs. `ctc_query_radar` and handoff bootstrap also search, recall, and fetch context. `feedbackOnRepeat` sends `unimatrix_feedback` with rating `wrong` when a file's breaker opens.

Verified against the public docs: Bearer auth, `POST /memories`, `GET /search`, `POST /tools/call`, `unimatrix_store_memory` (`location_id`, `content`, `tags`), `unimatrix_search_memories` (`query`, optional `space_id` and `limit`), and the `unimatrix_get_context` example (`query`, `intent`, `limit`). Not confirmed by a published schema: the argument names for `unimatrix_recall` (the docs say activation runs unless `activate` is false, and that `space_id`, `limit`, and `session_id` are optional) and for `unimatrix_feedback` (the docs only say it records `helped`, `wrong`, or `stale`). The client sends `{ query, activate: true, space_id, limit }` and `{ rating, query, note }` respectively.

## State on disk

`.ctc/state.json` keeps the per-file breaker. On a RED lock it also carries the ground-crew handoff (`bootstrapPrompt`, `pendingFiles`, `triggerReason`, and the violations). `.ctc/blueprint.json` is the task list. `.ctc/flight-plan.json` is the active task contract (`allowedFileGlobs`). `.ctc/flightplan.json` is still the milestone ceiling used by `ctc_check_flightplan`. `.ctc/handoff.json` is the older saturation manifest from the advisory read-zone helper. `.ctc/read-zone.json` holds those advisory counters. `.ctc/radar.jsonl` is the decision log. The lock gate refuses writes under `.ctc/**`.

Read zones default to warnings. `rules.readZones.lockOnRed` and `lockOnReRead` are off, so a re-read loop does not freeze the session. Registering a flight plan (`persist: true`) resets the counters. Yellow is 40% and red is 65% of `contextWindowTokens` unless you change them. Those percentages are applied to the character estimate, not to a measured model context.

## Tests

```bash
npm run check   # lint + typecheck + build + tests
```

The suite covers the milestone gate, the per-file breaker, the blueprint flow (onboard, promote, a gated write, a blocked DONE, a fix, then DONE), each of the six analyzer rules, the GREEN → YELLOW → RED read lock, the handoff in `.ctc/state.json`, the MCP server in-process and over stdio, the CLI exit codes, the REST API, the four tool-export formats, the git hooks, and watch with revert.

## Layout

```text
src/schemas/     Zod contracts: blueprint, flight plan, radar, gate result
src/blueprint/   Persist the blueprint and the active task flight plan
src/gate/        RunwayGateAnalyzer, overlay rollback, and the six rules
src/radar/       Identical-read zones, RED lock, ground-crew handoff
src/mcp/         Milestone tools, onboarding tools, write/patch/read tools
src/universal/   CLI gate, REST, Streamable HTTP, git hooks, watch, agent configs
src/engine/      Milestone runway gate, per-file breaker, advisory read zones
src/memory/      Optional Unimatrix adapter
src/explain/     v0.4 explanations, fix ledger, apply-fix
src/policy/      v0.4 layered policy, agent rule-file import
src/security/    v0.4 secrets, SAST, lockfiles, OSV advisories
src/lang/        v0.4 tree-sitter loader, Python/Go outline and rules
src/crossrepo/   v0.4 cross-repo impact
src/intent/      v0.4 ticket intent and coverage
src/wireframe/   v0.4 wireframe schema, renderer, drift
src/ci/          v0.4 CI report, GitHub comment/approve
src/dashboard/   v0.4 local dashboard
src/enterprise/  v0.4 identity (OIDC stub)
src/telemetry/   v0.4 hash-chained findings / audit log
```

The Claude Code and Cursor wiring below is unchanged: point the MCP server at `node dist/index.js serve`, and install the pre-write hook if native Write should be denied. Ask the agent to onboard a task and then call `ctc_write_file` instead of the editor's own write tool.

## Agent skills and marketplace installation

Install the companion skills and find client setup, listing status, and pricing boundaries in [the marketplace guide](docs/marketplaces.md).

```text
/plugin install vectorctc --marketplace tjpoisal/vectorctc
```
