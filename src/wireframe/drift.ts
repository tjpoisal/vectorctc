import { minimatch } from "minimatch";

import type { FlightPlanContract } from "../schemas/flightPlan.js";
import type { GateViolation } from "../schemas/gate.js";
import { allComponents, isApproved, loadWireframes, type Wireframe } from "./schema.js";

/**
 * Wireframe drift (v0.4). UI code marks wireframe components with data-wf="<component id>" (and regions
 * with data-wf-region="<region id>"), which `ctc wireframe` and the agent instructions ask for. The gate then
 * compares each write to the agreed wireframe:
 *   WIREFRAME_NOT_APPROVED     UI code for a wireframe nobody agreed to yet (or edited after approval)
 *   WIREFRAME_EXTRA_COMPONENT  a data-wf id the wireframe does not have
 *   WIREFRAME_EXTRA_REGION     a data-wf-region the wireframe does not have
 *   WIREFRAME_COMPONENT_REMOVED a component that was there and is now gone
 *   WIREFRAME_TYPE_MISMATCH    data-wf on the wrong kind of element (a link where a button was agreed)
 *   WIREFRAME_EXTRA_ROUTE      a new route no wireframe covers
 *   WIREFRAME_INCOMPLETE       components not built yet (warning, or a hold when the plan says uiComplete)
 *   WIREFRAME_MISSING_ROUTE    a router file without an agreed route (warning)
 */

const UI_FILE = /\.(tsx|jsx|vue|svelte|html|astro)$/;

const TAG_TYPES: Array<[RegExp, string[]]> = [
  [/^(button|Button|IconButton)$/, ["button"]],
  [/^(a|Link|NavLink|Anchor)$/, ["link", "nav"]],
  [/^(input|Input|TextField)$/, ["input", "search", "checkbox", "toggle"]],
  [/^(textarea|Textarea)$/, ["textarea", "input"]],
  [/^(select|Select|Dropdown)$/, ["select"]],
  [/^(table|Table|DataGrid|DataTable)$/, ["table"]],
  [/^(ul|ol|List)$/, ["list", "nav", "tabs", "pagination"]],
  [/^(h[1-6]|Heading|Title)$/, ["heading"]],
  [/^(img|Image|Avatar)$/, ["image", "avatar"]],
  [/^(form|Form)$/, ["form"]],
  [/^(nav|Nav|Navbar)$/, ["nav"]],
  [/^(Tabs|TabList)$/, ["tabs"]],
  [/^(canvas|Chart|LineChart|BarChart)$/, ["chart"]],
  [/^(dialog|Modal|Dialog)$/, ["modal"]],
  [/^(footer|Footer)$/, ["footer"]],
];

interface Marked {
  id: string;
  line: number;
  tag: string | null;
}

function marks(content: string, attribute: "data-wf" | "data-wf-region"): Marked[] {
  const out: Marked[] = [];
  const pattern = new RegExp(`${attribute}=\\{?["'\`]([a-z0-9][a-z0-9-]*)["'\`]\\}?`, "g");
  const lines = content.split("\n");
  lines.forEach((text, index) => {
    for (const match of text.matchAll(pattern)) {
      if (attribute === "data-wf" && text.slice((match.index ?? 0) + 7, (match.index ?? 0) + 14) === "-region") continue;
      const before = lines.slice(Math.max(0, index - 3), index).join("\n") + "\n" + text.slice(0, match.index ?? 0);
      const tag = [...before.matchAll(/<([A-Za-z][\w.]*)/g)].pop()?.[1] ?? null;
      out.push({ id: match[1] ?? "", line: index + 1, tag });
    }
  });
  return out.filter((item) => item.id);
}

export function routesIn(content: string): Array<{ route: string; line: number }> {
  const out: Array<{ route: string; line: number }> = [];
  content.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(/<Route\b[^>]*\bpath=["'{`]+([^"'`}]+)|\bpath\s*:\s*["'`](\/[^"'`]*)["'`]|\b(?:router|app)\.(?:get|post|put|delete|route)\(\s*["'`](\/[^"'`]*)["'`]/g)) {
      const route = match[1] ?? match[2] ?? match[3];
      if (route) out.push({ route, line: index + 1 });
    }
  });
  return out;
}

function hasMarkup(content: string): boolean {
  return /<([A-Za-z][\w.]*)[\s>/]/.test(content) && /<\/|\/>/.test(content);
}

function governs(frame: Wireframe, relativePath: string): boolean {
  return frame.files.some((glob) => minimatch(relativePath, glob, { dot: true }));
}

function routeMatches(pattern: string, route: string): boolean {
  const norm = (value: string): string => value.replace(/\/+$/, "") || "/";
  const a = norm(pattern).split("/");
  const b = norm(route).split("/");
  return a.length === b.length && a.every((part, i) => part === b[i] || part.startsWith(":") || (b[i] ?? "").startsWith(":") || part === "*");
}

export function wireframeViolations(root: string, relativePath: string, before: string | null, after: string, plan: FlightPlanContract | null): GateViolation[] {
  if (!UI_FILE.test(relativePath) && !/\.(ts|js)$/.test(relativePath)) return [];
  const { frames: loaded } = loadWireframes(root);
  if (loaded.length === 0) return [];
  const frames = plan?.wireframes ? loaded.filter((item) => plan.wireframes?.includes(item.frame.name)) : loaded;
  const out: GateViolation[] = [];
  const v = (code: string, line: number | null, message: string, fix: string, severity?: "warn"): void => {
    out.push({ rule: "WireframeDrift", code, file: relativePath, line, column: line === null ? null : 1, message, fix, ...(severity ? { severity } : {}) });
  };
  // Routes: judged in any file that defines routes, against every wireframe's route.
  const routed = loaded.filter((item) => item.frame.route).map((item) => item.frame);
  if (routed.length > 0) {
    const now = routesIn(after);
    const was = new Set(routesIn(before ?? "").map((item) => item.route));
    for (const item of now) {
      if (was.has(item.route) || routed.some((frame) => routeMatches(frame.route ?? "", item.route))) continue;
      v("WIREFRAME_EXTRA_ROUTE", item.line, `Route '${item.route}' is new and no wireframe covers it (wireframed routes: ${routed.map((frame) => frame.route).join(", ")}).`, `Add a wireframe for '${item.route}' (ctc wireframe new) and agree it before building the screen, or drop the route.`);
    }
    if (now.length >= 2) {
      for (const frame of routed.filter(isApproved)) {
        if (!now.some((item) => routeMatches(frame.route ?? "", item.route))) v("WIREFRAME_MISSING_ROUTE", null, `This router defines ${now.length} routes but not '${frame.route}' from the approved wireframe '${frame.name}'.`, `Add the '${frame.route}' route.`, "warn");
      }
    }
  }
  if (!UI_FILE.test(relativePath) || !hasMarkup(after)) return out;
  for (const { frame } of frames.filter((item) => governs(item.frame, relativePath))) {
    if (!isApproved(frame)) {
      v("WIREFRAME_NOT_APPROVED", 1, `${relativePath} is UI for wireframe '${frame.name}', which ${frame.status === "approved" ? "was edited after it was approved" : "has not been agreed yet"}.`, `Render it (ctc wireframe render ${frame.name}), agree it (ctc wireframe approve ${frame.name}), then write the UI.`);
      continue;
    }
    const components = allComponents(frame);
    const byId = new Map(components.map((item) => [item.id, item]));
    const regionIds = new Set(frame.regions.map((item) => item.id));
    const nowMarks = marks(after, "data-wf");
    const wasMarks = new Set(marks(before ?? "", "data-wf").map((item) => item.id));
    const nowIds = new Set(nowMarks.map((item) => item.id));
    for (const mark of nowMarks) {
      const spec = byId.get(mark.id);
      if (!spec) {
        v("WIREFRAME_EXTRA_COMPONENT", mark.line, `data-wf="${mark.id}" is not in wireframe '${frame.name}' (components: ${components.map((item) => item.id).slice(0, 12).join(", ")}).`, `Remove it, or add '${mark.id}' to the wireframe and re-agree it.`);
        continue;
      }
      if (mark.tag) {
        const allowed = TAG_TYPES.find(([pattern]) => pattern.test(mark.tag ?? ""))?.[1];
        if (allowed && !allowed.includes(spec.type)) v("WIREFRAME_TYPE_MISMATCH", mark.line, `'${mark.id}' is a ${spec.type} in wireframe '${frame.name}', but the code renders <${mark.tag}>.`, `Render '${mark.id}' as a ${spec.type}.`);
      }
    }
    for (const mark of marks(after, "data-wf-region")) {
      if (!regionIds.has(mark.id)) v("WIREFRAME_EXTRA_REGION", mark.line, `Region '${mark.id}' is not in wireframe '${frame.name}' (regions: ${[...regionIds].join(", ")}).`, `Use one of the agreed regions, or update the wireframe and re-agree it.`);
    }
    for (const id of wasMarks) {
      if (byId.has(id) && !nowIds.has(id)) v("WIREFRAME_COMPONENT_REMOVED", null, `Component '${id}' from wireframe '${frame.name}' was in ${relativePath} and this edit removes it.`, `Keep '${id}', or change the wireframe first.`);
    }
    const missing = components.filter((item) => !item.optional && !nowIds.has(item.id));
    if (missing.length > 0 && (nowIds.size > 0 || plan?.uiComplete)) {
      v("WIREFRAME_INCOMPLETE", null, `${missing.length} component(s) of wireframe '${frame.name}' are not in ${relativePath} yet: ${missing.map((item) => `${item.id} (${item.type})`).slice(0, 10).join(", ")}.`, `Build them with data-wf="<id>", or mark them optional in the wireframe.`, plan?.uiComplete ? undefined : "warn");
    }
  }
  return out;
}
