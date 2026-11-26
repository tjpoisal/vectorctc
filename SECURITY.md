# Security policy

## Reporting a vulnerability

Email **tim@deployunimatrix.com** with the subject `VectorCTC security`. Please include the version (`ctc --version`),
your Node.js version and OS, and steps to reproduce. Do not open a public issue for a vulnerability.

VectorCTC is maintained by one person. You can expect an acknowledgement within 3 business days and a status update
within 10 business days. Fixed issues are credited in the CHANGELOG unless you ask otherwise.

## Supported versions

Only the latest published minor version receives security fixes while the project is pre-1.0.

## Threat model, in brief

- **The gate runs locally.** It reads your repository and the proposed change. By default it makes no network calls.
- **Agent-written code is untrusted.** The behavioural check executes modified functions on generated inputs. It runs
  them in a separate `node --permission` process (no file system, child processes, workers or native addons) inside a
  `vm` context that is given no host objects, with `fetch`, `require`, `process.getBuiltinModule` and bindings removed
  from the child. `vm` is not a hard security boundary against V8 engine bugs; set `CTC_BEHAVIOR=off` if you treat
  agent output as actively hostile.
- **Optional network features are opt-in:** the semantic review step (your own API key, explicit opt-in),
  `ctc advisories sync` (queries api.osv.dev), Unimatrix memory sync (`unimatrix.enabled`), and the GitHub Action's
  PR comment (GitHub API, inside your CI).
- **Local HTTP servers** (`ctc serve --http`, `ctc dashboard`) bind to `127.0.0.1` only. Set `CTC_HTTP_TOKEN` to require
  a bearer token.
