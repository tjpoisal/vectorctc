import type { Replay } from "../replay/store.js";
import type { DashboardData } from "./aggregate.js";

const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const pct = (value: number): string => `${Math.round(value * 1000) / 10}%`;

function dailyChart(data: DashboardData): string {
  const width = 720;
  const height = 160;
  const max = Math.max(1, ...data.daily.map((day) => day.held + day.cleared + day.observed));
  const bar = width / Math.max(1, data.daily.length);
  const rects = data.daily
    .map((day, index) => {
      const x = index * bar + 1;
      let y = height;
      const parts: string[] = [];
      for (const [key, color] of [["cleared", "#2f855a"], ["observed", "#b7791f"], ["held", "#c53030"]] as const) {
        const h = (day[key] / max) * (height - 10);
        if (h <= 0) continue;
        y -= h;
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bar - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"><title>${esc(day.day)} ${key}: ${day[key]}</title></rect>`);
      }
      return parts.join("");
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height + 18}" role="img" aria-label="Decisions per day" width="100%"><line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="#ccc"/>${rects}<text x="0" y="${height + 14}" font-size="11" fill="#666">${esc(data.daily[0]?.day ?? "")}</text><text x="${width}" y="${height + 14}" font-size="11" fill="#666" text-anchor="end">${esc(data.daily[data.daily.length - 1]?.day ?? "")}</text></svg>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function renderDashboard(data: DashboardData, options: { refreshSeconds?: number } = {}): string {
  const t = data.totals;
  const chainOk = data.repos.every((repo) => repo.chain.ok);
  const card = (label: string, value: string, note = ""): string => `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="muted">${esc(note)}</div>` : ""}</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
<title>VectorCTC — team dashboard</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#1a202c;background:#f7fafc}
header{background:#1a202c;color:#fff;padding:16px 24px}header h1{margin:0;font-size:18px}header .muted{color:#a0aec0}
main{padding:20px 24px;max-width:1100px}section{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 16px}
h2{font-size:15px;margin:0 0 10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px}.label{color:#718096;font-size:12px}.value{font-size:22px;font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #edf2f7;vertical-align:top}th{font-size:12px;color:#718096}
code{font:12px ui-monospace,Menlo,monospace;background:#edf2f7;padding:1px 4px;border-radius:3px}.muted{color:#718096}.ok{color:#2f855a}.bad{color:#c53030}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:800px){.grid{grid-template-columns:1fr}}
.legend span{display:inline-block;width:10px;height:10px;margin:0 4px 0 12px;border-radius:2px}
</style></head><body>
<header><h1>VectorCTC — team dashboard</h1><div class="muted">${esc(data.repos.map((repo) => repo.name).join(", ") || "no repos")} · last ${data.windowDays} days · generated ${esc(data.generatedAt)} · local data only</div></header>
<main>
<div class="cards">
${card("Gate decisions", String(t.decisions))}
${card("Held", String(t.held), pct(t.holdRate))}
${card("Observe-mode", String(t.observed), "would block under enforce")}
${card("Median gate time", t.medianMs === null ? "—" : `${Math.round(t.medianMs)} ms`, t.p95Ms === null ? "" : `p95 ${Math.round(t.p95Ms)} ms`)}
${card("Recovered holds", String(data.fixLoop.recovered), data.fixLoop.medianAttempts === null ? "" : `median ${data.fixLoop.medianAttempts} attempts to clear`)}
${card("Audit chain", chainOk ? "intact" : "BROKEN", chainOk ? "SHA-256 hash chain verified" : "run ctc audit verify")}
</div>
<section><h2>Decisions per day</h2><div class="legend muted"><span style="background:#2f855a"></span>cleared<span style="background:#b7791f"></span>observed<span style="background:#c53030"></span>held</div>${dailyChart(data)}</section>
<div class="grid">
<section><h2>Top rules</h2>${table(["Code", "Rule", "Blocks", "Observe", "Warn", "Files"], data.codes.map((item) => [`<code>${esc(item.code)}</code>`, esc(item.rule), String(item.blocks), String(item.observes), String(item.warns), String(item.files)]), "No findings in this window.")}</section>
<section><h2>Rollout: what enforce mode would add</h2>${table(["Code", "Would block", "Files"], data.rollout.map((item) => [`<code>${esc(item.code)}</code>`, String(item.wouldBlock), item.files.map((file) => `<code>${esc(file)}</code>`).join(" ")]), "Nothing is in observe mode.")}</section>
<section><h2>Hotspots</h2>${table(["File", "Holds", "Last held"], data.hotspots.map((item) => [`<code>${esc(`${item.repo}/${item.file}`)}</code>`, String(item.holds), esc(item.lastHeld.slice(0, 16).replace("T", " ")) + " UTC"]), "No holds.")}</section>
<section><h2>Fix loop</h2>${table(["Measure", "Value"], [["Holds later cleared on the same file", String(data.fixLoop.recovered)], ["Median attempts to clear", data.fixLoop.medianAttempts === null ? "—" : String(data.fixLoop.medianAttempts)], ["Files still held", String(data.fixLoop.stillHeld)], ["Files stuck (≥2 failed fixes)", String(data.fixLoop.stuckFiles)], ["Open / resolved ledger findings", `${data.fixLoop.openFindings} / ${data.fixLoop.resolvedFindings}`]], "")}</section>
<section><h2>By surface</h2>${table(["Surface", "Decisions", "Held"], data.surfaces.map((item) => [esc(item.name), String(item.decisions), String(item.held)]), "No decisions.")}</section>
<section><h2>By actor</h2>${table(["Actor (CTC_ACTOR)", "Decisions", "Held"], data.actors.map((item) => [esc(item.name), String(item.decisions), String(item.held)]), "No decisions.")}</section>
</div>
<section><h2>Agent report card</h2>${table(["Agent", "Model", "Decisions", "Hold rate", "Median attempts to clear", "Top rules"], data.reportCard.map((row) => [esc(row.agent) + (row.versions.length ? ` <span class="muted">${esc(row.versions.join(", "))}</span>` : ""), row.model ? esc(row.model) : `<span class="muted">—</span>`, String(row.decisions), `${pct(row.holdRate)} <span class="muted">(${row.held})</span>`, row.medianAttemptsToClear === null ? "—" : String(row.medianAttemptsToClear), row.topRules.map((item) => `<code>${esc(item.code)}</code>×${item.holds}`).join(" ") || `<span class="muted">none</span>`]), "No decisions in this window.")}<p class="muted">Agent: MCP clientInfo, CTC_AGENT or CTC_ACTOR. Model: CTC_MODEL (MCP does not report it).</p></section>
<section><h2>Why it held: recent replays</h2>${table(["When (UTC)", "File", "Decision", "Rules", "Agent"], data.replays.map((item) => [esc(item.ts.slice(0, 16).replace("T", " ")), `<a href="/replay/${item.repo}/${esc(item.id)}"><code>${esc(item.file)}</code></a>`, esc(item.decision), item.codes.map((code) => `<code>${esc(code)}</code>`).join(" "), esc(item.agent ?? "—")]), "No held or observed writes stored (.ctc/replays).")}</section>
<section><h2>Repos</h2>${table(["Repo", "Records", "Audit chain"], data.repos.map((repo) => [`${esc(repo.name)} <span class="muted">${esc(repo.root)}</span>`, String(repo.records), repo.chain.ok ? `<span class="ok">intact</span>` : `<span class="bad">broken at record ${esc(repo.chain.brokenAt)}: ${esc(repo.chain.reason)}</span>`]), "No repos.")}</section>
<p class="muted">Source: .ctc/findings.jsonl (no code content is logged — paths, rule codes, lines, decisions) and .ctc/fix-ledger.json in each repo.</p>
</main></body></html>
`;
}

export function renderReplayPage(replay: Replay, repoName: string): string {
  const diff = replay.diff
    ? replay.diff
        .trimEnd()
        .split("\n")
        .map((line) => `<span class="${line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}">${esc(line)}</span>`)
        .join("\n")
    : esc(replay.diffWithheld === "secret" ? "(withheld: the change contained a secret, so it was not stored)" : "(withheld: the diff was too large to store)");
  const items = replay.explanations
    .map(
      (item) => `<section><h2><code>${esc(item.code)}</code> <span class="muted">${esc(item.rule)} · ${esc(item.severity)}${item.lines ? ` · lines ${item.lines.start}–${item.lines.end}` : ""}</span></h2>
<p><b>What:</b> ${esc(item.message)}</p><p><b>Why this rule exists:</b> ${esc(item.why)}</p>
<p><b>Suggested fix</b> <span class="muted">(${esc(item.fix.kind)}, ${esc(item.fix.confidence)})</span>: ${esc(item.fix.summary)}</p>${item.fix.patch ? `<pre>${esc(item.fix.patch)}</pre>` : ""}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay ${esc(replay.id)} — VectorCTC</title>
<style>body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#1a202c;background:#f7fafc}header{background:#1a202c;color:#fff;padding:16px 24px}header h1{margin:0;font-size:18px}header a,header .muted{color:#a0aec0}
main{padding:20px 24px;max-width:1100px}section{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0 0 16px}h2{font-size:15px;margin:0 0 10px}
pre{font:12px/1.5 ui-monospace,Menlo,monospace;background:#1a202c;color:#e2e8f0;padding:12px;border-radius:6px;overflow:auto}.add{color:#9ae6b4}.del{color:#feb2b2}.hunk{color:#90cdf4}code{font:12px ui-monospace,Menlo,monospace;background:#edf2f7;padding:1px 4px;border-radius:3px}.muted{color:#718096}</style></head><body>
<header><h1>Why it held · <code style="background:none;color:#fff">${esc(replay.file)}</code></h1><div class="muted">${esc(repoName)} · ${esc(replay.decision)} · ${esc(replay.ts)} · surface ${esc(replay.surface)} · agent ${esc(replay.agent ?? "unknown")}${replay.model ? ` · model ${esc(replay.model)}` : ""} · <a href="/">back to dashboard</a></div></header>
<main><section><h2>Attempted change</h2><pre>${diff}</pre></section>
${items}
<p class="muted">Stored locally in .ctc/replays/${esc(replay.id)}.json. Same view in a terminal: <code>ctc replay ${esc(replay.id)}</code></p></main></body></html>
`;
}
