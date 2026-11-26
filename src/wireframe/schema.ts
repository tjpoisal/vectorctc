import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { parseYaml } from "./yaml.js";

export const COMPONENT_TYPES = ["heading", "text", "button", "link", "input", "textarea", "select", "checkbox", "toggle", "table", "list", "card", "image", "form", "nav", "tabs", "chart", "modal", "badge", "avatar", "search", "pagination", "footer"] as const;

export const ComponentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are kebab-case"),
  type: z.enum(COMPONENT_TYPES),
  label: z.string().optional(),
  /** Optional components are never reported missing. */
  optional: z.boolean().optional(),
  /** Table columns, list item fields, select options, tabs. */
  items: z.array(z.string()).optional(),
});

export const RegionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Grid area: x, y, w, h in grid units (columns × rows). */
  area: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(1), z.number().int().min(1)]),
  label: z.string().optional(),
  components: z.array(ComponentSchema).default([]),
});

export const WireframeSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().default(""),
  route: z.string().optional(),
  /** UI files this wireframe governs (globs). */
  files: z.array(z.string()).default([]),
  grid: z.object({ columns: z.number().int().min(1).max(24).default(12), rows: z.number().int().min(1).max(60).default(8) }).default({ columns: 12, rows: 8 }),
  regions: z.array(RegionSchema).min(1),
  status: z.enum(["draft", "approved"]).default("draft"),
  approval: z.object({ by: z.string(), at: z.string(), hash: z.string() }).optional(),
});

export type Wireframe = z.infer<typeof WireframeSchema>;
export type WireframeComponent = z.infer<typeof ComponentSchema>;

export const WIREFRAME_DIR = ".ctc/wireframes";

/** Hash of everything except approval/status, so editing an approved wireframe invalidates the approval. */
export function wireframeHash(frame: Wireframe): string {
  const { approval: _approval, status: _status, ...rest } = frame;
  void _approval;
  void _status;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

export function isApproved(frame: Wireframe): boolean {
  return frame.status === "approved" && frame.approval?.hash === wireframeHash(frame);
}

export function parseWireframe(text: string, file: string): Wireframe {
  const raw = /\.ya?ml$/.test(file) ? parseYaml(text) : (JSON.parse(text) as unknown);
  return WireframeSchema.parse(raw);
}

export function wireframeFiles(root: string): string[] {
  const dir = path.join(root, WIREFRAME_DIR);
  try {
    return fs.readdirSync(dir).filter((name) => /\.(json|ya?ml)$/.test(name)).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

const cache = new Map<string, { mtime: number; frame: Wireframe | null; error: string | null }>();

export function loadWireframes(root: string): { frames: Array<{ file: string; frame: Wireframe }>; errors: string[] } {
  const frames: Array<{ file: string; frame: Wireframe }> = [];
  const errors: string[] = [];
  for (const file of wireframeFiles(root)) {
    const mtime = fs.statSync(file).mtimeMs;
    let hit = cache.get(file);
    if (!hit || hit.mtime !== mtime) {
      try {
        hit = { mtime, frame: parseWireframe(fs.readFileSync(file, "utf8"), file), error: null };
      } catch (error) {
        hit = { mtime, frame: null, error: `${path.basename(file)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
      }
      cache.set(file, hit);
    }
    if (hit.frame) frames.push({ file, frame: hit.frame });
    if (hit.error) errors.push(hit.error);
  }
  return { frames, errors };
}

export function allComponents(frame: Wireframe): Array<WireframeComponent & { region: string }> {
  return frame.regions.flatMap((region) => region.components.map((component) => ({ ...component, region: region.id })));
}
