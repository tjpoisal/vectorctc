import type { MemoryAdapter, MemoryFeedback, MemoryHit, MemoryWrite } from "./types.js";

export interface UnimatrixClientOptions {
  endpoint: string;
  apiKey: string;
  spaceId?: string | null;
  locationId?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * REST client for https://www.deployunimatrix.com/api
 *
 * Verified from the public docs (2026-11-16):
 * - Authorization: Bearer umx_...
 * - POST /api/memories { spaceId, content, tags }
 * - GET /api/search?q=&spaceId=
 * - POST /api/tools/call { toolName, args } for MCP tool names
 * - unimatrix_store_memory args: location_id, content, tags
 * - unimatrix_search_memories args: query, space_id?, limit?
 * - unimatrix_get_context example args: query, intent, limit
 *
 * Not confirmed by a published JSON schema: unimatrix_recall argument names
 * (the docs say it runs associative activation unless activate is false, and
 * that space_id, limit, and session_id are optional) and unimatrix_feedback
 * argument names (the docs only say it records helped, wrong, or stale).
 */
export class HttpUnimatrixClient implements MemoryAdapter {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: UnimatrixClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async store(input: MemoryWrite): Promise<void> {
    const tags = [...input.tags];
    if (input.file) tags.push(`file:${input.file}`);
    if (input.repo) tags.push(`repo:${input.repo}`);
    if (this.options.locationId) {
      await this.callTool("unimatrix_store_memory", {
        location_id: this.options.locationId,
        content: input.content,
        tags,
      });
      return;
    }
    if (!this.options.spaceId) throw new Error("Unimatrix store needs locationId or spaceId.");
    await this.request("/memories", {
      method: "POST",
      body: JSON.stringify({ spaceId: this.options.spaceId, content: input.content, tags }),
    });
  }

  async search(query: string): Promise<MemoryHit[]> {
    const params = new URLSearchParams({ q: query });
    if (this.options.spaceId) params.set("spaceId", this.options.spaceId);
    const body = await this.request(`/search?${params.toString()}`, { method: "GET" });
    return hitsFrom(body);
  }

  async recall(query: string): Promise<MemoryHit[]> {
    const body = await this.callTool("unimatrix_recall", {
      query,
      activate: true,
      ...(this.options.spaceId ? { space_id: this.options.spaceId } : {}),
      limit: 8,
    });
    return hitsFrom(body);
  }

  async getContext(query: string): Promise<MemoryHit[]> {
    const body = await this.callTool("unimatrix_get_context", {
      query,
      intent: "ctc handoff",
      limit: 8,
      ...(this.options.spaceId ? { space_id: this.options.spaceId } : {}),
    });
    return hitsFrom(body);
  }

  async feedback(input: MemoryFeedback): Promise<void> {
    await this.callTool("unimatrix_feedback", {
      rating: input.rating,
      query: input.query,
      ...(input.note ? { note: input.note } : {}),
    });
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("/tools/call", {
      method: "POST",
      body: JSON.stringify({ toolName, args, sourceLlm: "ctc" }),
    });
  }

  private async request(pathname: string, init: { method: string; body?: string }): Promise<unknown> {
    const response = await this.fetchImpl(`${this.endpoint}${pathname}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      ...(init.body ? { body: init.body } : {}),
    });
    if (!response.ok) {
      throw new Error(`Unimatrix ${init.method} ${pathname} returned ${response.status}.`);
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

export function hitsFrom(body: unknown): MemoryHit[] {
  const records = unwrap(body);
  return records
    .map((record) => {
      if (!record || typeof record !== "object") return null;
      const item = record as Record<string, unknown>;
      const content = stringField(item, ["content", "text", "memory", "summary"]);
      if (!content) return null;
      const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const id = typeof item.id === "string" ? item.id : null;
      return { id, content, tags };
    })
    .filter((hit): hit is MemoryHit => hit !== null);
}

function unwrap(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["memories", "results", "hits", "items", "data"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : null))
      .filter((text): text is string => text !== null);
    if (texts.length === 1) {
      try {
        return unwrap(JSON.parse(texts[0] ?? "") as unknown);
      } catch {
        return texts.map((text) => ({ content: text }));
      }
    }
    return texts.map((text) => ({ content: text }));
  }
  if (typeof record.content === "string") return [record];
  return [];
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return null;
}
