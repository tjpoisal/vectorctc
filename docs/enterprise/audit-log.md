# Audit log

Every gate decision (agent write, hook, CLI check, CI run, fix-loop retry) appends one JSON line to
`.ctc/findings.jsonl`:

```json
{"v":1,"ts":"…","file":"src/pay.ts","decision":"held","surface":"mcp","taskId":"T-12","sessionId":"…","actor":"dev@example.com","idp":"oidc","ms":41,
 "findings":[{"rule":"SecretScan","code":"SECRET_AWS_KEY","line":3,"severity":"block"}],"prev":"<hash of previous record>","hash":"<sha256 of this record>","sig":"<hmac>"}
```

- **No code content** is logged: paths, rule codes, line numbers, decisions, timings, identity.
- **Hash chain:** each record carries the previous record's SHA-256. `ctc audit verify` finds any edited, removed,
  reordered or inserted line.
- **Signatures (optional):** set `CTC_AUDIT_HMAC_KEY` (from your secret store) on the machines that write the log
  and on the machine that verifies it. Each record then carries an HMAC of its hash, so someone who rewrites the
  whole chain — recomputing every hash — still fails verification without the key.
- **Export:** `ctc audit export --format jsonl|csv|cef [--since ISO] [--out file]`. CSV cells that start with
  `= + - @` are quoted and prefixed against spreadsheet formula injection. CEF works with ArcSight-compatible SIEMs
  (Splunk, QRadar, Sentinel via CEF connectors). Export refuses a broken chain unless `--force`.
- **Turn it off:** `CTC_FINDINGS_LOG=off`.

Limitations: the log is per checkout. Collect it centrally by exporting from CI (for example, upload
`ctc audit export` output as a build artifact, or ship it with your log forwarder). A local hash chain proves
integrity relative to a trusted copy or key; it does not stop someone with write access deleting the whole file.
Anchor the head hash somewhere you control (a CI artifact, a commit message) if you need that.
