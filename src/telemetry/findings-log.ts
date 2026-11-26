import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Findings log (v0.4): one JSON line per gate decision in .ctc/findings.jsonl. It feeds the team
 * dashboard (`ctc dashboard`) and doubles as the audit log: every record carries the SHA-256 of the
 * previous record, so `ctc audit verify` detects any edited, reordered or deleted line.
 * Content is never logged — only file paths, rule codes, lines and decisions.
 */

export const FINDINGS_LOG = ".ctc/findings.jsonl";
export const GENESIS = "0".repeat(64);

export interface LoggedFinding {
  rule: string;
  code: string;
  line: number | null;
  severity: "block" | "warn" | "observe";
}

export interface FindingRecord {
  v: 1;
  ts: string;
  file: string;
  decision: "cleared" | "held" | "observed";
  surface: string;
  taskId: string | null;
  sessionId: string | null;
  actor: string | null;
  ms: number | null;
  findings: LoggedFinding[];
  /** Set when the actor came from a verified OIDC ID token (enterprise); absent for free-text CTC_ACTOR. */
  idp?: "oidc";
  /** v0.5: the agent behind the decision — MCP clientInfo (name/version), or CTC_AGENT. */
  client?: { name: string; version: string | null };
  /** v0.5: model id from CTC_MODEL (MCP does not report the model). */
  model?: string;
  /** v0.5: id of the local replay (.ctc/replays/<id>.json) for a held or observed decision. */
  replay?: string;
  prev: string;
  hash: string;
  /** HMAC-SHA256 of `hash` with CTC_AUDIT_HMAC_KEY, when that key is set: a rewritten chain cannot be re-signed without it. */
  sig?: string;
}

const lastHash = new Map<string, string>();

function logPath(root: string): string {
  return path.join(root, FINDINGS_LOG);
}

export function recordSignature(hash: string, key: string): string {
  return crypto.createHmac("sha256", key).update(hash).digest("hex");
}

export function recordHash(record: Omit<FindingRecord, "hash" | "sig">): string {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function tailHash(file: string): string {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    const lines = buffer.toString("utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return GENESIS;
    return (JSON.parse(last) as FindingRecord).hash ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

export function logDecision(root: string, input: Omit<FindingRecord, "v" | "ts" | "prev" | "hash"> & { ts?: string }): FindingRecord | null {
  if (process.env.CTC_FINDINGS_LOG === "off") return null;
  const file = logPath(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exists = fs.existsSync(file);
    let prev = exists ? lastHash.get(file) : GENESIS;
    if (prev === undefined || !exists) prev = exists ? tailHash(file) : GENESIS;
    const { ts, ...rest } = input;
    const body: Omit<FindingRecord, "hash" | "sig"> = { v: 1, ts: ts ?? new Date().toISOString(), ...rest, prev };
    const hash = recordHash(body);
    const key = process.env.CTC_AUDIT_HMAC_KEY;
    const record: FindingRecord = { ...body, hash, ...(key ? { sig: recordSignature(hash, key) } : {}) };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    lastHash.set(file, record.hash);
    return record;
  } catch {
    return null;
  }
}

export function readFindings(root: string, file = logPath(root)): FindingRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: FindingRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as FindingRecord);
    } catch {
      // a corrupt line is reported by verifyChain
    }
  }
  return out;
}

export function verifyChain(root: string, file = logPath(root), hmacKey: string | undefined = process.env.CTC_AUDIT_HMAC_KEY): { ok: boolean; records: number; brokenAt: number | null; reason: string | null; signed?: number } {
  if (!fs.existsSync(file)) return { ok: true, records: 0, brokenAt: null, reason: null };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
  let prev = GENESIS;
  let signed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let record: FindingRecord;
    try {
      record = JSON.parse(lines[index] ?? "") as FindingRecord;
    } catch {
      return { ok: false, records: lines.length, brokenAt: index + 1, reason: "line is not JSON" };
    }
    if (record.prev !== prev) return { ok: false, records: lines.length, brokenAt: index + 1, reason: "prev hash does not match the previous record (line removed, reordered or inserted)" };
    const { hash, sig, ...body } = record;
    if (recordHash(body) !== hash) return { ok: false, records: lines.length, brokenAt: index + 1, reason: "record content does not match its hash (edited)" };
    if (hmacKey) {
      if (!sig) return { ok: false, records: lines.length, brokenAt: index + 1, reason: "record is not signed although CTC_AUDIT_HMAC_KEY is set (written without the key, or the chain was rebuilt)" };
      const expected = recordSignature(hash, hmacKey);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, records: lines.length, brokenAt: index + 1, reason: "signature does not match (chain rewritten without the key)" };
      signed += 1;
    }
    prev = hash;
  }
  return { ok: true, records: lines.length, brokenAt: null, reason: null, ...(hmacKey ? { signed } : {}) };
}

/** SIEM export: JSON lines (as stored), CSV, or ArcSight CEF. One row per finding (a cleared decision is one row). */
export function exportFindings(records: readonly FindingRecord[], format: "jsonl" | "csv" | "cef"): string {
  if (format === "jsonl") return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  const rows: string[] = [];
  const cefEscape = (value: unknown): string => String(value ?? "").replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, " ");
  const csvCell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : text;
  };
  if (format === "csv") rows.push("ts,decision,file,surface,task,session,actor,idp,rule,code,line,severity,hash");
  for (const record of records) {
    const findings = record.findings.length ? record.findings : [null];
    for (const finding of findings) {
      if (format === "csv") rows.push([record.ts, record.decision, record.file, record.surface, record.taskId, record.sessionId, record.actor, record.idp ?? "", finding?.rule ?? "", finding?.code ?? "", finding?.line ?? "", finding?.severity ?? "", record.hash].map(csvCell).join(","));
      else {
        const severity = record.decision === "held" ? 7 : record.decision === "observed" ? 4 : 1;
        rows.push(`CEF:0|VectorCTC|ctc|0.4|${finding?.code ?? "GATE_CLEARED"}|${record.decision} ${finding?.code ?? ""}`.trimEnd() + `|${severity}|rt=${Date.parse(record.ts)} fname=${cefEscape(record.file)} suser=${cefEscape(record.actor ?? "")} cs1Label=surface cs1=${cefEscape(record.surface)} cs2Label=rule cs2=${cefEscape(finding?.rule ?? "")} cs3Label=hash cs3=${record.hash} cn1Label=line cn1=${finding?.line ?? ""}`);
      }
    }
  }
  return rows.join("\n") + (rows.length ? "\n" : "");
}
