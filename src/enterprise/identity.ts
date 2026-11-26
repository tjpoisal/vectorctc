import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Enterprise identity (v0.4 item 14, SSO stub). Who made a gate decision, for the audit log.
 *
 *   - Default: CTC_ACTOR (free text, unverified) — what v0.4 Core logs.
 *   - OIDC: when CTC_ID_TOKEN holds an ID token (e.g. GitHub Actions OIDC, or one your IdP's CLI minted) and
 *     CTC_OIDC_JWKS points at the issuer's JWKS JSON (a file: verification is offline), the token's signature,
 *     issuer (CTC_OIDC_ISSUER), audience (CTC_OIDC_AUDIENCE) and expiry are checked and the actor becomes the
 *     verified `email` / `preferred_username` / `sub`. A token that fails verification is never trusted; the
 *     reason is reported and the actor falls back to unverified.
 *
 * This is a stub in the honest sense: there is no login flow, token refresh or JWKS fetching here. It is the
 * interface a hosted or self-hosted policy server plugs into (see docs/enterprise/sso.md).
 */

export interface Identity {
  actor: string | null;
  verified: boolean;
  idp: "oidc" | null;
  issuer: string | null;
  subject: string | null;
  groups: string[];
  error: string | null;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [key: string]: unknown;
}

const ALGS: Record<string, { hash: string; kind: "rsa" | "rsa-pss" | "ec" }> = {
  RS256: { hash: "sha256", kind: "rsa" },
  RS384: { hash: "sha384", kind: "rsa" },
  RS512: { hash: "sha512", kind: "rsa" },
  PS256: { hash: "sha256", kind: "rsa-pss" },
  ES256: { hash: "sha256", kind: "ec" },
  ES384: { hash: "sha384", kind: "ec" },
};

function b64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifyIdToken(token: string, jwks: { keys: Jwk[] }, expect: { issuer?: string; audience?: string; now?: number; leewaySeconds?: number }): { ok: true; claims: Record<string, unknown> } | { ok: false; error: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "not a JWT" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64url(h).toString("utf8")) as { alg?: string; kid?: string };
    claims = JSON.parse(b64url(p).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "malformed JWT" };
  }
  const alg = header.alg ?? "";
  const spec = ALGS[alg];
  if (!spec) return { ok: false, error: `unsupported or unsafe alg '${alg}'` };
  const candidates = jwks.keys.filter((key) => (!header.kid || key.kid === header.kid) && (!key.alg || key.alg === alg));
  if (candidates.length === 0) return { ok: false, error: `no JWKS key for kid '${header.kid ?? ""}'` };
  const data = Buffer.from(`${h}.${p}`);
  const signature = b64url(s);
  const verified = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
      if (spec.kind === "ec") return crypto.verify(spec.hash, data, { key, dsaEncoding: "ieee-p1363" }, signature);
      if (spec.kind === "rsa-pss") return crypto.verify(spec.hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      return crypto.verify(spec.hash, data, key, signature);
    } catch {
      return false;
    }
  });
  if (!verified) return { ok: false, error: "signature does not verify" };
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const leeway = expect.leewaySeconds ?? 60;
  if (typeof claims.exp !== "number" || claims.exp + leeway < now) return { ok: false, error: "token expired" };
  if (typeof claims.nbf === "number" && claims.nbf - leeway > now) return { ok: false, error: "token not yet valid" };
  if (expect.issuer && claims.iss !== expect.issuer) return { ok: false, error: `issuer '${String(claims.iss)}' is not '${expect.issuer}'` };
  if (expect.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(expect.audience)) return { ok: false, error: `audience does not include '${expect.audience}'` };
  }
  return { ok: true, claims };
}

let cached: { key: string; identity: Identity } | null = null;

export function resolveIdentity(env: NodeJS.ProcessEnv = process.env): Identity {
  const key = [env.CTC_ACTOR, env.CTC_ID_TOKEN, env.CTC_OIDC_JWKS, env.CTC_OIDC_ISSUER, env.CTC_OIDC_AUDIENCE].map((value) => value ?? "").join("\u0000");
  if (cached?.key === key) return cached.identity;
  const fallback = (error: string | null): Identity => ({ actor: env.CTC_ACTOR ?? null, verified: false, idp: null, issuer: null, subject: null, groups: [], error });
  let identity: Identity;
  if (!env.CTC_ID_TOKEN) identity = fallback(null);
  else if (!env.CTC_OIDC_JWKS) identity = fallback("CTC_ID_TOKEN is set but CTC_OIDC_JWKS is not, so the token cannot be verified");
  else {
    try {
      const jwks = JSON.parse(fs.readFileSync(env.CTC_OIDC_JWKS, "utf8")) as { keys: Jwk[] };
      const result = verifyIdToken(env.CTC_ID_TOKEN.trim(), jwks, { ...(env.CTC_OIDC_ISSUER ? { issuer: env.CTC_OIDC_ISSUER } : {}), ...(env.CTC_OIDC_AUDIENCE ? { audience: env.CTC_OIDC_AUDIENCE } : {}) });
      if (!result.ok) identity = fallback(`ID token rejected: ${result.error}`);
      else {
        const c = result.claims;
        const name = [c.email, c.preferred_username, c.actor, c.sub].find((value) => typeof value === "string" && value.length > 0) as string | undefined;
        const groups = Array.isArray(c.groups) ? c.groups.filter((g): g is string => typeof g === "string") : [];
        identity = { actor: name ?? null, verified: true, idp: "oidc", issuer: typeof c.iss === "string" ? c.iss : null, subject: typeof c.sub === "string" ? c.sub : null, groups, error: null };
      }
    } catch (error) {
      identity = fallback(`could not read CTC_OIDC_JWKS: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cached = { key, identity };
  return identity;
}
