import type { SemanticProviderConfig } from "./config.js";

export interface ModelRequest {
  system: string;
  user: string;
  timeoutMs: number;
}

/** A provider is just "prompt in, text out"; tests and other integrations can pass their own. */
export type ModelClient = (request: ModelRequest) => Promise<string>;

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

function field(value: unknown, ...keys: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export function httpModelClient(config: SemanticProviderConfig): ModelClient {
  if (config.provider === "anthropic") {
    return async ({ system, user, timeoutMs }) => {
      const json = await postJson(
        `${config.baseUrl}/v1/messages`,
        { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        { model: config.model, max_tokens: 1500, temperature: 0, system, messages: [{ role: "user", content: user }] },
        timeoutMs,
      );
      const parts = field(json, "content");
      if (!Array.isArray(parts)) throw new Error("Anthropic response has no content.");
      return parts.map((part) => (typeof field(part, "text") === "string" ? (field(part, "text") as string) : "")).join("");
    };
  }
  return async ({ system, user, timeoutMs }) => {
    const json = await postJson(
      `${config.baseUrl}/chat/completions`,
      { authorization: `Bearer ${config.apiKey}` },
      {
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
      },
      timeoutMs,
    );
    const content = field(json, "choices", 0, "message", "content");
    if (typeof content !== "string") throw new Error("OpenAI-compatible response has no message content.");
    return content;
  };
}
