# Identity and SSO (preview stub — coming soon)

By default the audit log's `actor` is whatever `CTC_ACTOR` says — useful, but self-asserted.

With an OIDC ID token, the actor is verified:

| Variable | Meaning |
|---|---|
| `CTC_ID_TOKEN` | The ID token (JWT). In GitHub Actions, request one with `id-token: write` and the Actions OIDC endpoint; elsewhere, mint one with your IdP's CLI. |
| `CTC_OIDC_JWKS` | Path to the issuer's JWKS JSON. Verification is offline: fetch and pin the JWKS yourself. |
| `CTC_OIDC_ISSUER` | Expected `iss` (recommended). |
| `CTC_OIDC_AUDIENCE` | Expected `aud` (recommended). |

Supported algorithms: RS256/384/512, PS256, ES256/384. `none` and HMAC algorithms are rejected. `exp`/`nbf` are
checked with 60 s leeway. On success the actor is the token's `email`, else `preferred_username`, else `sub`, and
records get `"idp":"oidc"`; `groups` are read for future use. A token that fails any check is not trusted: the
actor falls back to `CTC_ACTOR` without `idp`, and `ctc whoami` prints the reason.

**What a stub means here:** there is no interactive login, no token refresh, no JWKS download, no SAML, no SCIM,
and groups do not yet change what a user may do. The interface (`resolveIdentity()` in
`src/enterprise/identity.ts`) is what a hosted or self-hosted policy server would call.
