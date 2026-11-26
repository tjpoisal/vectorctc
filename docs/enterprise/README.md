# VectorCTC enterprise pack (v0.4)

Everything here ships in the Apache-2.0 Core package. Nothing calls home, nothing needs an account, nothing is metered.

| Need | What exists today | Status |
|---|---|---|
| Run it inside your network | `ctc serve --http` (MCP + REST), `ctc ci` in your own runners, `ctc dashboard` on 127.0.0.1 — see [self-host.md](self-host.md) | Working |
| Audit trail | `.ctc/findings.jsonl`: one record per gate decision, SHA-256 hash chain, optional HMAC signatures, `ctc audit verify`, `ctc audit export --format jsonl\|csv\|cef` — see [audit-log.md](audit-log.md) | Working |
| Org-wide policy | org → repo → directory policy files with `locked` rules and `lockMode`; observe mode for rollout (`ctc policy explain`) | Working |
| Identity / SSO | Verified actor from an OIDC ID token, checked offline against your JWKS — see [sso.md](sso.md) | **Stub**: verification only; no login flow, no JWKS fetch, no group-based permissions yet |
| Bring your own model | Semantic step talks to any OpenAI-compatible endpoint or Anthropic, with your key — see [byok.md](byok.md) | Working (optional; off without a key) |
| Data residency | Code never leaves the machine running the gate unless you turn the semantic step on, and then only to the endpoint you configure | By design |

What is **not** built: a hosted or multi-tenant policy server, a hosted dashboard, SAML, SCIM, RBAC beyond policy
locks, and support SLAs. The site's pricing section lists these as *proposed* paid features; none is on sale.
