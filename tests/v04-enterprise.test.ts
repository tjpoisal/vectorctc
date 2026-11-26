import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveIdentity, verifyIdToken } from "../src/enterprise/identity.js";
import { GENESIS, exportFindings, logDecision, readFindings, recordHash, verifyChain } from "../src/telemetry/findings-log.js";
import { repo } from "./v04-helpers.js";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(alg: "RS256" | "ES256", privateKey: crypto.KeyObject, claims: Record<string, unknown>, kid = "k1"): string {
  const head = `${b64({ alg, kid, typ: "JWT" })}.${b64(claims)}`;
  const signature = alg === "ES256" ? crypto.sign("sha256", Buffer.from(head), { key: privateKey, dsaEncoding: "ieee-p1363" }) : crypto.sign("sha256", Buffer.from(head), privateKey);
  return `${head}.${signature.toString("base64url")}`;
}

describe("v0.4 item 14: enterprise identity (OIDC stub)", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }, { ...ec.publicKey.export({ format: "jwk" }), kid: "k2", alg: "ES256" }] };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://idp.example", aud: "ctc", sub: "u-1", email: "dev@example.com", groups: ["platform"], exp: now + 600 };

  it("verifies RS256 and ES256 tokens offline and rejects bad ones", () => {
    expect(verifyIdToken(sign("RS256", rsa.privateKey, claims), jwks, { issuer: "https://idp.example", audience: "ctc" }).ok).toBe(true);
    expect(verifyIdToken(sign("ES256", ec.privateKey, claims, "k2"), jwks, { audience: "ctc" }).ok).toBe(true);
    const expired = verifyIdToken(sign("RS256", rsa.privateKey, { ...claims, exp: now - 3600 }), jwks, {});
    expect(expired).toEqual({ ok: false, error: "token expired" });
    expect(verifyIdToken(sign("RS256", rsa.privateKey, claims), jwks, { issuer: "https://evil" }).ok).toBe(false);
    const forged = sign("RS256", crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, claims);
    expect(verifyIdToken(forged, jwks, {})).toEqual({ ok: false, error: "signature does not verify" });
    const none = `${b64({ alg: "none", kid: "k1" })}.${b64(claims)}.`;
    expect(verifyIdToken(none, jwks, {}).ok).toBe(false);
  });

  it("resolves a verified actor, and never trusts an unverifiable token", () => {
    const dir = repo({ "jwks.json": JSON.stringify(jwks) });
    const env = { CTC_ACTOR: "claimed", CTC_ID_TOKEN: sign("RS256", rsa.privateKey, claims), CTC_OIDC_JWKS: path.join(dir, "jwks.json"), CTC_OIDC_AUDIENCE: "ctc" };
    expect(resolveIdentity(env)).toMatchObject({ actor: "dev@example.com", verified: true, idp: "oidc", groups: ["platform"] });
    expect(resolveIdentity({ ...env, CTC_OIDC_AUDIENCE: "other" })).toMatchObject({ actor: "claimed", verified: false });
    expect(resolveIdentity({ CTC_ACTOR: "x", CTC_ID_TOKEN: "abc" }).error).toContain("cannot be verified");
  });
});

describe("v0.4 item 14: audit log signing and SIEM export", () => {
  it("detects a chain rebuilt without the HMAC key", () => {
    const root = repo({ "README.md": "x" });
    delete process.env.CTC_FINDINGS_LOG;
    process.env.CTC_AUDIT_HMAC_KEY = "k-test-not-a-secret";
    try {
      for (const decision of ["held", "cleared"] as const) logDecision(root, { file: "src/a.ts", decision, surface: "cli", taskId: null, sessionId: null, actor: "=cmd|' /C calc'!A0", ms: 5, findings: decision === "held" ? [{ rule: "SecretScan", code: "SECRET_AWS_KEY", line: 2, severity: "block" }] : [] });
      expect(verifyChain(root)).toMatchObject({ ok: true, records: 2, signed: 2 });
      // An attacker edits record 1 and recomputes every hash — but cannot recompute signatures.
      const file = path.join(root, ".ctc/findings.jsonl");
      const records = readFindings(root);
      let prev = GENESIS;
      const rebuilt = records.map((record, index) => {
        const { hash: _hash, sig, ...body } = record;
        const edited = { ...body, prev, ...(index === 0 ? { decision: "cleared" as const, findings: [] } : {}) };
        const hash = recordHash(edited);
        prev = hash;
        return JSON.stringify({ ...edited, hash, sig });
      });
      fs.writeFileSync(file, `${rebuilt.join("\n")}\n`);
      expect(verifyChain(root, undefined, "").ok).toBe(true);
      expect(verifyChain(root)).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringContaining("signature") });
    } finally {
      delete process.env.CTC_AUDIT_HMAC_KEY;
      process.env.CTC_FINDINGS_LOG = "off";
    }
  });

  it("exports CSV (formula-injection safe) and CEF", () => {
    const record = { v: 1 as const, ts: "2026-11-20T10:00:00.000Z", file: "src/a.ts", decision: "held" as const, surface: "ci", taskId: "t", sessionId: null, actor: "=HYPERLINK(1)", ms: 3, findings: [{ rule: "SecretScan", code: "SECRET_AWS_KEY", line: 2, severity: "block" as const }], prev: GENESIS, hash: "h" };
    const csv = exportFindings([record], "csv").trim().split("\n");
    expect(csv[0]).toContain("ts,decision,file");
    expect(csv[1]).toContain(`"'=HYPERLINK(1)"`);
    const cef = exportFindings([record], "cef");
    expect(cef).toMatch(/^CEF:0\|VectorCTC\|ctc\|0\.4\|SECRET_AWS_KEY\|held SECRET_AWS_KEY\|7\|/);
    expect(cef).toContain("fname=src/a.ts");
  });
});
