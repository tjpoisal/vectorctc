import fs from "node:fs";
import path from "node:path";

import type { CtcConfig } from "../config/schema.js";
import { HttpUnimatrixClient } from "./unimatrix.js";
import type { MemoryAdapter, MemoryHit, MemoryWrite } from "./types.js";

let testAdapter: MemoryAdapter | null = null;

export function setMemoryAdapterForTests(adapter: MemoryAdapter | null): void {
  testAdapter = adapter;
}

export function adapterFor(config: CtcConfig): MemoryAdapter | null {
  if (!config.unimatrix.enabled) return null;
  if (testAdapter) return testAdapter;
  const apiKey = process.env.UNIMATRIX_API_KEY;
  if (!apiKey) return null;
  return new HttpUnimatrixClient({
    endpoint: config.unimatrix.endpoint,
    apiKey,
    spaceId: config.unimatrix.spaceId,
    locationId: config.unimatrix.locationId,
  });
}

function repoName(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name) return pkg.name;
  } catch {
    // The directory name is enough when package.json is missing or invalid.
  }
  return path.basename(root);
}

function settle(result: void | Promise<void>): void {
  if (result && typeof (result as Promise<void>).then === "function") {
    void (result as Promise<void>).catch(() => undefined);
  }
}

export function remember(root: string, config: CtcConfig, input: MemoryWrite): void {
  try {
    const adapter = adapterFor(config);
    if (!adapter) return;
    settle(adapter.store({ ...input, repo: input.repo ?? repoName(root) }));
  } catch {
    // Local .ctc files stay authoritative when Unimatrix is down.
  }
}

export async function recallMemories(config: CtcConfig, query: string): Promise<MemoryHit[]> {
  try {
    const adapter = adapterFor(config);
    if (!adapter) return [];
    const [searched, recalled, context] = await Promise.all([
      Promise.resolve(adapter.search(query)).catch(() => []),
      Promise.resolve(adapter.recall(query)).catch(() => []),
      Promise.resolve(adapter.getContext(query)).catch(() => []),
    ]);
    const seen = new Set<string>();
    const hits: MemoryHit[] = [];
    for (const hit of [...searched, ...recalled, ...context]) {
      if (seen.has(hit.content)) continue;
      seen.add(hit.content);
      hits.push(hit);
    }
    return hits;
  } catch {
    return [];
  }
}

export function rememberFeedback(config: CtcConfig, query: string, note: string): void {
  if (!config.unimatrix.feedbackOnRepeat) return;
  try {
    const adapter = adapterFor(config);
    if (!adapter) return;
    settle(adapter.feedback({ rating: "wrong", query, note }));
  } catch {
    // Feedback is optional telemetry.
  }
}
