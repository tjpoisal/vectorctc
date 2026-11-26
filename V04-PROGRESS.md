# VectorCTC v0.4 progress log

Branch `v0.4` from `v0.3` (1050301, 102 tests). Read this first on resume.

## Status
- [x] Phase A (core) — items 1-5, then benchmark rerun
- [x] Phase B (surfaces) — items 6-8
- [x] Phase C (reach) — items 9-11
- [x] Phase D (product) — items 12-14
- [x] Added scope (Timothy): heldout3 written+locked first, then behavioural layer (structural/behavioural duplicates, differential testing)
- [x] Release bundle + bench tarball

## Log
- A1 done (commit): breaking-change line resolved from identifiers at the caller diagnostic; edit scope expands to type users (changed lines use a planned symbol or a member it just gained) and callees of planned declarations.
- A2-A5 done (commit): src/explain (explain.ts, ledger.ts, apply-fix.ts), src/policy (policy.ts, rulefiles.ts, check.ts), src/security (secrets, sast, sca/advisories, lockfiles, semver), src/telemetry/findings-log.ts (hash chain), src/gate/pipeline.ts (extensions registry for Phase C), src/cli/v04.ts (explain, fix, rules import, policy explain/report/init, advisories sync/import/audit, audit verify). MCP: ctc_apply_fix, ctc_explain, ctc_policy. data/osv-seed.json built from api.osv.dev 2026-11-23 (1709 advisories / 86 pkgs). tests/mcp.test.ts tool list updated for the 3 new tools. 118 tests.
- (fixed in B) `ctc hook` now runs v1 reviewWrite then the v0.4 checkContent.
- Bench after Phase A (locks intact, B-v4 = --export-scope --edit-scope, 3 runs deterministic on all sets):
  main 21/21 recall, 0/11 FP, precision 50/50; heldout 11/11, 0/4, 11/12; heldout2 9/11, 0/4, 13/13 (v0.3: 8/11, 1/4).
  Diffs vs v0.3: ufo-x02 now caught (correct line), app-x04 FP cleared, app-12 / app-x03 add POLICY_BANNED_IMPORT (AGENTS.md import active in bench repos).
  Disclosure: ufo-x02 and app-x04 (heldout2) were looked at while fixing A1. Warm median: main 104 ms (p95 235), heldout2 112 ms.
  score.mjs gained D-v4+<reviewer> union arms.
- Phase B done: src/ci (ci.ts, github.ts) + `ctc ci`, action.yml, examples/workflows/vectorctc.yml, .pre-commit-hooks.yaml, integrations/vscode, src/universal/agents-gated.ts (`ctc init --agent cursor|claude|copilot [--strict]`).
- Item 11 done: src/wireframe (yaml, schema, render, cli, drift) + `ctc wireframe new|render|approve|list|check`, MCP ctc_wireframe, BUILTIN_EXTENSIONS "wireframes".
- Item 9 done: web-tree-sitter 0.25.10 + vendored data/grammars (python, go wasm from tree-sitter-wasms 0.1.13), src/lang/{treesitter,outline,stdlib,polyglot}.ts; extension "python-go": phantom imports/symbols, duplicates, length/complexity (diff-aware), allowedEditSymbols. Line-based fallback when grammar not loaded. 140 tests.
- Item 10 done: src/crossrepo/impact.ts (CROSS_REPO_BREAK blocks, CROSS_REPO_SIGNATURE / SIBLING_MISSING warn; policy crossRepo.siblings; `ctc impact <file>`), src/intent/intent.ts (INTENT_OUT_OF_SCOPE blocks, INTENT_UNRELATED warns or enforces via policy intent.unrelated; ticketCoverage in `ctc ci` + PR body as ticket; blueprint tasks with acceptance criteria get plan.ticket; semantic prompt gets the ticket). 147 tests.
- Bench regression on Phase C build (d6f0b5c), B-v4 3 runs each, locks intact, deterministic on all sets:
  main 21/21, 0/11 FP, precision 51/51, CLI median 1254 ms; heldout 11/11, 0/4, 11/12, 1311 ms; heldout2 9/11, 0/4, 14/14, 1284 ms.
  Only diff vs post-A run: INTENT_UNRELATED (warn) added on pathe-08 and ufo-x04, both already held, both matched the labeled defect. No decision changed.
- Item 12 done: src/dashboard (aggregate, render, server) + tests/v04-dashboard.test.ts; CLI `ctc dashboard` wired in src/cli/v04.ts (committed with item 14). Site pricing section edited in /workspace/ctc/site/public/index.html (not a git repo; pre-edit copy in /workspace/ctc/site-public-pre-v04). Team/Enterprise prices are PROPOSED placeholders ($8/active committer is a draft), competitor prices from vendor pages 2026-11-23.
- Item 13 done: /workspace/ctc/site/scripts/build-scoreboard.mjs -> site/public/scoreboard.html + scoreboard.json (3 sets, caveats section, reviewers marked not run on heldout2). Not deployed.
- Item 14 done: src/enterprise/identity.ts (offline OIDC JWT verify: RS/PS/ES, rejects none/HMAC; `ctc whoami`), findings log HMAC signatures (CTC_AUDIT_HMAC_KEY) + `ctc audit export --format jsonl|csv|cef`, BYOK CTC_SEMANTIC_API_KEY_FILE, docs/enterprise/{README,self-host,audit-log,sso,byok}.md, examples/self-host (Dockerfile, compose, Caddyfile; untested). README v0.4 section. 153 tests.
- Heldout3 (15 cases: 10 defects, 5 clean) written and locked 2026-11-24T04:40:06Z (23:40 EST) BEFORE any behavioural code; task-file comments say 23:45 (typo, left as-is because the files are hashed). Baseline on Phase D build: A2-tsc 2/10 recall 0/5 FP; B-v4-base 3/10, 0/5 FP, precision 3/4.
- Behavioural layer done (14428b7): src/behavior/{sandbox,extract,inputs,checks}.ts, extension "behavior". DIFFERENTIAL (old vs new on generated inputs of the old signature + literal args harvested from tests; BEHAVIOR_CHANGED blocks when objective preserves behaviour or edit only adds optional params, warns otherwise, silent when objective names the function with a change verb; culprit line by single-line revert), EQUIVALENCE (DUPLICATE_BEHAVIOR: new small function == existing same-typed helper on all inputs, >=2 distinct outputs), ARITY (SIGNATURE_BREAK). Sandbox: child node --permission + vm, frozen clock, stubbed imports, 40 ms/call, 400 ms budget (CTC_BEHAVIOR_BUDGET_MS), CTC_BEHAVIOR=off. Structural (alpha-renamed) fingerprints already existed in ast-hasher; the new catch on renamed/reworded copies comes from the behavioural check. 160 tests.
- Old B-v4 raw dirs renamed B-v4-phaseC / B-v4-noscope-phaseC; final build rerun as B-v4 (runlogs/final.sh).
- Sandbox perf (938213f): long-lived child behind a worker bridge, cached compiled modules, one timeout per job.
- FINAL bench (938213f, B-v4 3 runs each, deterministic, all 4 locks intact): main 21/21, 0/11 FP, 56/58; heldout 11/11, 0/4, 13/14; heldout2 11/11, 0/4, 18/19; heldout3 10/10, 0/5, 11/12 (baseline 3/10). Warm median: main 149.6 ms (p95 307), heldout2 196.9 ms, heldout3 225.3 ms — over the 150 ms target on the held-out sets. FINDINGS.md v0.4 section written; scoreboard rebuilt with 4 sets.
- Release: /workspace/ctc/release/vectorctc-v0.4.bundle + vectorctc-v0.4-patches/ (v0.3..v0.4), DEPLOY.md v0.4 section; bench tarball repacked.
