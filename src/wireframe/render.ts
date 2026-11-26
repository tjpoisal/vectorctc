import type { Wireframe, WireframeComponent } from "./schema.js";
import { isApproved } from "./schema.js";

/** Low-fi SVG: grey boxes and labels only, so nobody mistakes it for a visual design. */
const CELL_W = 80;
const CELL_H = 70;
const PAD = 8;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function component(c: WireframeComponent, x: number, y: number, w: number): { svg: string; h: number } {
  const label = esc(c.label ?? c.id);
  const dash = c.optional ? ' stroke-dasharray="4 3"' : "";
  const tag = `<text x="${x + w - 4}" y="${y + 10}" font-size="8" text-anchor="end" fill="#999">${c.type}#${esc(c.id)}</text>`;
  switch (c.type) {
    case "heading":
      return { svg: `<text x="${x}" y="${y + 18}" font-size="16" font-weight="700" fill="#333">${label}</text>${tag}`, h: 26 };
    case "text":
      return { svg: `<rect x="${x}" y="${y + 4}" width="${w * 0.9}" height="6" fill="#ddd"/><rect x="${x}" y="${y + 14}" width="${w * 0.7}" height="6" fill="#ddd"/>${tag}`, h: 26 };
    case "button":
      return { svg: `<rect x="${x}" y="${y}" width="${Math.min(w, 140)}" height="26" rx="6" fill="#eee" stroke="#555"${dash}/><text x="${x + Math.min(w, 140) / 2}" y="${y + 17}" font-size="11" text-anchor="middle" fill="#333">${label}</text>${tag}`, h: 32 };
    case "link":
      return { svg: `<text x="${x}" y="${y + 14}" font-size="11" fill="#336" text-decoration="underline">${label}</text>${tag}`, h: 20 };
    case "input":
    case "search":
    case "select":
    case "textarea": {
      const h = c.type === "textarea" ? 48 : 26;
      return { svg: `<text x="${x}" y="${y + 9}" font-size="9" fill="#666">${label}</text><rect x="${x}" y="${y + 12}" width="${w}" height="${h}" fill="#fff" stroke="#888"${dash}/>${c.type === "select" ? `<text x="${x + w - 12}" y="${y + 29}" font-size="10" fill="#666">▾</text>` : ""}${c.type === "search" ? `<text x="${x + 6}" y="${y + 29}" font-size="10" fill="#aaa">⌕ search</text>` : ""}`, h: h + 18 };
    }
    case "checkbox":
    case "toggle":
      return { svg: `<rect x="${x}" y="${y + 2}" width="14" height="14" fill="#fff" stroke="#555"/><text x="${x + 20}" y="${y + 13}" font-size="11" fill="#333">${label}</text>${tag}`, h: 22 };
    case "table": {
      const cols = c.items?.length ? c.items : ["", "", ""];
      const cw = w / cols.length;
      let svg = `<rect x="${x}" y="${y}" width="${w}" height="96" fill="#fff" stroke="#555"${dash}/><rect x="${x}" y="${y}" width="${w}" height="20" fill="#eee"/>`;
      cols.forEach((col, i) => (svg += `<text x="${x + i * cw + 4}" y="${y + 14}" font-size="9" fill="#333">${esc(col)}</text>`));
      for (let r = 1; r < 4; r += 1) svg += `<line x1="${x}" y1="${y + 20 + r * 19}" x2="${x + w}" y2="${y + 20 + r * 19}" stroke="#ddd"/>`;
      return { svg: svg + tag, h: 102 };
    }
    case "list":
    case "pagination":
    case "tabs":
    case "nav": {
      const items = c.items?.length ? c.items : [label];
      const horizontal = c.type !== "list";
      let svg = "";
      items.forEach((item, i) => {
        svg += horizontal
          ? `<rect x="${x + i * 84}" y="${y}" width="78" height="22" fill="${c.type === "tabs" && i === 0 ? "#ddd" : "#f4f4f4"}" stroke="#999"/><text x="${x + i * 84 + 39}" y="${y + 15}" font-size="10" text-anchor="middle" fill="#333">${esc(item)}</text>`
          : `<text x="${x + 4}" y="${y + 14 + i * 18}" font-size="10" fill="#333">• ${esc(item)}</text>`;
      });
      return { svg: svg + tag, h: horizontal ? 28 : items.length * 18 + 8 };
    }
    case "image":
    case "chart":
    case "avatar": {
      const h = c.type === "avatar" ? 32 : 80;
      const ww = c.type === "avatar" ? 32 : w;
      return { svg: `<rect x="${x}" y="${y}" width="${ww}" height="${h}" fill="#f4f4f4" stroke="#888"${dash}/><line x1="${x}" y1="${y}" x2="${x + ww}" y2="${y + h}" stroke="#bbb"/><line x1="${x + ww}" y1="${y}" x2="${x}" y2="${y + h}" stroke="#bbb"/><text x="${x + 4}" y="${y + h - 4}" font-size="9" fill="#666">${label}</text>`, h: h + 6 };
    }
    default:
      return { svg: `<rect x="${x}" y="${y}" width="${w}" height="40" rx="4" fill="#fafafa" stroke="#888"${dash}/><text x="${x + 6}" y="${y + 16}" font-size="11" fill="#333">${label}</text>${tag}`, h: 46 };
  }
}

export function renderWireframeSvg(frame: Wireframe): string {
  const width = frame.grid.columns * CELL_W;
  const height = frame.grid.rows * CELL_H + 40;
  const parts: string[] = [];
  parts.push(`<rect width="${width}" height="${height}" fill="#fcfcfc"/>`);
  parts.push(`<text x="8" y="20" font-size="13" font-weight="700" fill="#222">${esc(frame.title || frame.name)}${frame.route ? `  <tspan font-weight="400" fill="#777">${esc(frame.route)}</tspan>` : ""}</text>`);
  parts.push(`<text x="${width - 8}" y="20" font-size="11" text-anchor="end" fill="${isApproved(frame) ? "#2a7" : "#c70"}">${isApproved(frame) ? `approved by ${esc(frame.approval?.by ?? "")}` : "DRAFT — not agreed yet"}</text>`);
  for (const region of frame.regions) {
    const [gx, gy, gw, gh] = region.area;
    const x = gx * CELL_W + PAD / 2;
    const y = gy * CELL_H + 32;
    const w = gw * CELL_W - PAD;
    const h = gh * CELL_H - PAD;
    parts.push(`<g data-region="${esc(region.id)}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#bbb" stroke-dasharray="6 4"/><text x="${x + 4}" y="${y + 12}" font-size="9" fill="#999">${esc(region.label ?? region.id)}</text>`);
    let cy = y + 18;
    for (const item of region.components) {
      const drawn = component(item, x + 8, cy, w - 16);
      parts.push(`<g data-wf="${esc(item.id)}">${drawn.svg}</g>`);
      cy += drawn.h + 6;
    }
    parts.push(`</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, Menlo, monospace">${parts.join("")}</svg>\n`;
}
