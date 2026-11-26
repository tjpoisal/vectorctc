import path from "node:path";

import { changedLines, type ChangedLine } from "../lang/lines.js";
import type { GateViolation } from "../schemas/gate.js";

/**
 * Secrets in the pre-write gate (v0.4). Scans the lines a proposal adds, in any file type, for provider
 * key formats and for high-entropy literals assigned to credential-like names. Unlike a PR or push-time
 * scanner, the secret never reaches the working tree, editor history or git, so there is nothing to scrub
 * from history. Findings never echo the secret: messages carry a redacted fingerprint only.
 */

interface Detector {
  code: string;
  label: string;
  pattern: RegExp;
  env: string;
}

const DETECTORS: Detector[] = [
  { code: "SECRET_AWS_ACCESS_KEY", label: "AWS access key id", pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/, env: "AWS_ACCESS_KEY_ID" },
  { code: "SECRET_GITHUB_TOKEN", label: "GitHub token", pattern: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, env: "GITHUB_TOKEN" },
  { code: "SECRET_SLACK_TOKEN", label: "Slack token", pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/, env: "SLACK_TOKEN" },
  { code: "SECRET_SLACK_WEBHOOK", label: "Slack webhook URL", pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,})/, env: "SLACK_WEBHOOK_URL" },
  { code: "SECRET_STRIPE_KEY", label: "Stripe live key", pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/, env: "STRIPE_SECRET_KEY" },
  { code: "SECRET_GOOGLE_API_KEY", label: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/, env: "GOOGLE_API_KEY" },
  { code: "SECRET_OPENAI_KEY", label: "OpenAI API key", pattern: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/, env: "OPENAI_API_KEY" },
  { code: "SECRET_ANTHROPIC_KEY", label: "Anthropic API key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{32,})\b/, env: "ANTHROPIC_API_KEY" },
  { code: "SECRET_NPM_TOKEN", label: "npm token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/, env: "NPM_TOKEN" },
  { code: "SECRET_PRIVATE_KEY", label: "private key block", pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)/, env: "PRIVATE_KEY" },
  { code: "SECRET_JWT", label: "JSON Web Token", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, env: "JWT" },
  { code: "SECRET_DB_URL", label: "database URL with a password", pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/'"]+:[^@\s'"]{3,}@[^\s'"]+)/, env: "DATABASE_URL" },
];

const NAME = /\b([A-Za-z_][\w-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth))\b["']?\s*[:=]\s*(['"`])([^'"`\s]{8,})\2/i;
const PLACEHOLDER = /^(x+|\*+|<[^>]+>|\$\{[^}]+\}|changeme|change[-_]me|password|secret|example|dummy|test|todo|fake|redacted|your[-_].*|placeholder|null|undefined|process\.env.*|env\..*)$/i;

export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function redact(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

function allowed(line: ChangedLine, value: string, allow: readonly string[]): boolean {
  if (/ctc-allow-secret|gitleaks:allow|pragma: allowlist secret/.test(line.text)) return true;
  return allow.some((item) => value.includes(item) || line.text.includes(item));
}

function envName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

export function secretViolations(relativePath: string, before: string | null, after: string, allow: readonly string[] = []): GateViolation[] {
  const base = path.posix.basename(relativePath);
  // Example env files are meant to carry placeholders; real values in them are still caught by provider formats.
  const example = /\.(example|sample|template)$|^\.env\.(example|sample|template)$/.test(base);
  const out: GateViolation[] = [];
  for (const line of changedLines(relativePath, before, after)) {
    let hit = false;
    for (const detector of DETECTORS) {
      const match = line.text.match(detector.pattern);
      const value = match?.[1];
      if (!value || allowed(line, value, allow)) continue;
      hit = true;
      out.push({
        rule: "SecretScan",
        code: detector.code,
        file: relativePath,
        line: line.line,
        column: Math.max(1, line.text.indexOf(value) + 1),
        message: `A ${detector.label} (${redact(value)}) would be written to ${relativePath}. CTC held the write, so it never reached disk.`,
        fix: `Load it from the environment (process.env.${detector.env}) or a secret manager. If this value is real, rotate it.`,
        cwe: "CWE-798",
      });
      break;
    }
    if (hit || example) continue;
    const named = line.text.match(NAME);
    const name = named?.[1];
    const value = named?.[3];
    if (!name || !value || PLACEHOLDER.test(value) || allowed(line, value, allow)) continue;
    if (value.length < 12 || entropy(value) < 3.5 || /^[a-z]+$/i.test(value) || /^\w+\.\w+$/.test(value)) continue;
    out.push({
      rule: "SecretScan",
      code: "SECRET_GENERIC",
      file: relativePath,
      line: line.line,
      column: Math.max(1, line.text.indexOf(value) + 1),
      message: `'${name}' is assigned a high-entropy literal (${redact(value)}, entropy ${entropy(value).toFixed(1)} bits/char) that looks like a real credential.`,
      fix: `Read it from process.env.${envName(name)} instead of hard-coding it. If the value is real, rotate it. Mark a known-safe value with // ctc-allow-secret.`,
      cwe: "CWE-798",
    });
  }
  return out;
}
