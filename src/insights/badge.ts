import fs from "node:fs";
import path from "node:path";

import { pct, windowRecords } from "./records.js";

/**
 * README badge (v0.5): "gated by VectorCTC · hold rate X%" from the local findings log only. Writes an SVG and a
 * shields.io endpoint JSON (https://shields.io/badges/endpoint-badge); prints a README snippet. No network.
 */

export interface BadgeResult {
  label: string;
  message: string;
  color: string;
  decisions: number;
  held: number;
  svgPath: string;
  jsonPath: string;
  snippet: string;
}

const LABEL = "gated by VectorCTC";

// Approximate Verdana 11px advance widths (shields' own measure), enough to size the badge boxes.
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[il.,:;|!' ]/.test(char) ? 3.6 : /[mwMW%]/.test(char) ? 10 : /[A-Z0-9]/.test(char) ? 7.5 : 6.6;
  return Math.ceil(width);
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function badgeSvg(label: string, message: string, color: string): string {
  const left = textWidth(label) + 12;
  const right = textWidth(message) + 12;
  const total = left + right;
  const fill = { brightgreen: "#4c1", green: "#97ca00", yellow: "#dfb317", orange: "#fe7d37", blue: "#007ec6", lightgrey: "#9f9f9f" }[color] ?? color;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeXml(`${label}: ${message}`)}">
<title>${escapeXml(`${label}: ${message}`)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${fill}"/><rect width="${total}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text><text x="${left / 2}" y="14">${escapeXml(label)}</text>
<text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text><text x="${left + right / 2}" y="14">${escapeXml(message)}</text>
</g>
</svg>
`;
}

export function writeBadge(root: string, options: { out?: string; days?: number; repo?: string; branch?: string; now?: Date } = {}): BadgeResult {
  const days = options.days ?? 30;
  const records = windowRecords([root], { days, ...(options.now ? { now: options.now } : {}) });
  const held = records.filter((item) => item.decision === "held").length;
  const message = records.length ? `hold rate ${pct(held / records.length)}` : "hold rate n/a";
  const color = records.length ? "blue" : "lightgrey";
  const outDir = path.resolve(root, options.out ?? ".ctc/badge");
  fs.mkdirSync(outDir, { recursive: true });
  const svgPath = path.join(outDir, "vectorctc.svg");
  const jsonPath = path.join(outDir, "vectorctc.json");
  fs.writeFileSync(svgPath, badgeSvg(LABEL, message, color), "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify({ schemaVersion: 1, label: LABEL, message, color }, null, 2)}\n`, "utf8");
  const relSvg = path.relative(root, svgPath).split(path.sep).join("/");
  const relJson = path.relative(root, jsonPath).split(path.sep).join("/");
  const raw = options.repo ? `https://raw.githubusercontent.com/${options.repo}/${options.branch ?? "main"}/${relJson}` : `<raw URL of ${relJson}>`;
  const snippet = [
    `<!-- local SVG, commit ${relSvg} -->`,
    `[![${LABEL}: ${message}](./${relSvg})](https://vectorctc.com)`,
    "",
    "<!-- or a shields.io endpoint badge that reads the committed JSON -->",
    `[![${LABEL}](https://img.shields.io/endpoint?url=${options.repo ? encodeURIComponent(raw) : raw})](https://vectorctc.com)`,
  ].join("\n");
  return { label: LABEL, message, color, decisions: records.length, held, svgPath, jsonPath, snippet };
}
