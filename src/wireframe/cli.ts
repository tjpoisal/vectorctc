import fs from "node:fs";
import path from "node:path";

import { renderWireframeSvg } from "./render.js";
import { WIREFRAME_DIR, WireframeSchema, isApproved, loadWireframes, parseWireframe, wireframeHash, type Wireframe } from "./schema.js";

export function starterWireframe(name: string, options: { route?: string; title?: string; files?: string[] } = {}): Wireframe {
  return WireframeSchema.parse({
    version: 1,
    name,
    title: options.title ?? name.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
    route: options.route ?? `/${name}`,
    files: options.files ?? [`src/**/${name}*.{tsx,jsx,vue,svelte}`, `src/**/${name}/**`],
    grid: { columns: 12, rows: 8 },
    regions: [
      { id: "header", area: [0, 0, 12, 1], components: [{ id: "page-title", type: "heading", label: options.title ?? name }, { id: "primary-action", type: "button", label: "Primary action" }] },
      { id: "sidebar", area: [0, 1, 3, 7], components: [{ id: "side-nav", type: "nav", items: ["Overview", "Settings"] }] },
      { id: "main", area: [3, 1, 9, 6], components: [{ id: "search", type: "search" }, { id: "results", type: "table", items: ["Name", "Status", "Updated"] }] },
      { id: "footer", area: [3, 7, 9, 1], components: [{ id: "pager", type: "pagination", items: ["‹", "1", "2", "›"] }] },
    ],
    status: "draft",
  });
}

export function wireframePath(root: string, name: string): string {
  const yaml = path.join(root, WIREFRAME_DIR, `${name}.yaml`);
  return fs.existsSync(yaml) ? yaml : path.join(root, WIREFRAME_DIR, `${name}.json`);
}

export function saveWireframe(root: string, frame: Wireframe): string {
  const file = path.join(root, WIREFRAME_DIR, `${frame.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(frame, null, 2)}\n`, "utf8");
  return file;
}

export function renderToFile(root: string, frame: Wireframe): string {
  const svg = path.join(root, WIREFRAME_DIR, `${frame.name}.svg`);
  fs.mkdirSync(path.dirname(svg), { recursive: true });
  fs.writeFileSync(svg, renderWireframeSvg(frame), "utf8");
  return svg;
}

export function startWireframe(root: string, name: string, options: { route?: string; title?: string; files?: string[] } = {}): { json: string; svg: string } {
  const existing = wireframePath(root, name);
  const frame = fs.existsSync(existing) ? parseWireframe(fs.readFileSync(existing, "utf8"), existing) : starterWireframe(name, options);
  const json = fs.existsSync(existing) ? existing : saveWireframe(root, frame);
  return { json, svg: renderToFile(root, frame) };
}

export function loadOne(root: string, name: string): Wireframe {
  const file = wireframePath(root, name);
  if (!fs.existsSync(file)) throw new Error(`No wireframe '${name}' in ${WIREFRAME_DIR}. Create it with ctc wireframe new ${name}.`);
  return parseWireframe(fs.readFileSync(file, "utf8"), file);
}

/** Record agreement. Approval is bound to a hash of the layout, so any later edit needs a new agreement. */
export function approveWireframe(root: string, name: string, by: string, now = new Date()): Wireframe {
  const frame = loadOne(root, name);
  const approved: Wireframe = { ...frame, status: "approved", approval: { by, at: now.toISOString(), hash: wireframeHash(frame) } };
  const file = wireframePath(root, name);
  if (file.endsWith(".json")) fs.writeFileSync(file, `${JSON.stringify(approved, null, 2)}\n`, "utf8");
  else saveWireframe(root, approved);
  renderToFile(root, approved);
  return approved;
}

export function listWireframes(root: string): Array<{ name: string; route: string | null; status: string; approved: boolean; files: string[]; components: number }> {
  return loadWireframes(root).frames.map(({ frame }) => ({ name: frame.name, route: frame.route ?? null, status: frame.status, approved: isApproved(frame), files: frame.files, components: frame.regions.reduce((sum, region) => sum + region.components.length, 0) }));
}
