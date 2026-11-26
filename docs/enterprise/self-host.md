# Self-hosting VectorCTC

VectorCTC is a Node.js 20+ CLI. "Self-hosting" means running it where your code already is.

## 1. On developer machines (default)
`npx vectorctc init --agent auto` wires the gate into the agent (MCP, hooks or rules). Decisions are
logged to `.ctc/findings.jsonl` in each repo. No network access is needed.

## 2. In CI on your own runners
Use the composite action (`action.yml`) on self-hosted GitHub runners, or call the CLI directly anywhere:

```sh
npx vectorctc ci --base origin/main --markdown ctc-report.md --json > ctc-report.json
```

Exit code 2 means held. `--observe` reports without failing (rollout). `--github` posts the sticky PR comment with
`GITHUB_TOKEN`; omit it on GitHub Enterprise Server if you post comments another way (the markdown file is written
either way).

Dependency advisories are offline: the package ships an OSV seed. To refresh it inside an air-gapped network,
run `ctc advisories sync` on a connected machine (free OSV API, no key), commit `.ctc/advisories.json`, or point
`sca.advisoryFile` in policy at a file you mirror internally.

## 3. As a shared service
`ctc serve --http --port 4317` starts Streamable HTTP MCP plus the REST API (`/v1/*`, OpenAPI at `/openapi.json`)
on 127.0.0.1. Put it behind your reverse proxy (TLS, auth) if agents on other hosts should use it. See
`examples/self-host/` for a Dockerfile and compose file.

## 4. Team dashboard
`ctc dashboard --repo ../api --repo ../web` serves a read-only page on 127.0.0.1:4318 that aggregates the findings
logs of the listed checkouts. `ctc dashboard --out report.html` writes a static file you can publish internally.
The page has no scripts and a `default-src 'none'` CSP.

## 5. Org policy
Ship one org policy file to every machine and runner (config management, a dotfiles repo, or the CI image) and
point `CTC_ORG_POLICY` at it, or set `orgPolicy` in each repo's `ctc.config.json`. Rules marked `locked: true`
cannot be weakened by repo or directory policy; `ctc policy explain` shows who set what.
