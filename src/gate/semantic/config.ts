import fs from "node:fs";

/**
 * Provider selection for the optional semantic review step. Nothing here creates keys or accounts: the
 * step runs only when the environment already holds a key, and is skipped cleanly otherwise.
 *
 *   CTC_SEMANTIC=off                      never run it
 *   CTC_SEMANTIC_API_KEY                  key for the provider below (preferred)
 *   CTC_SEMANTIC_API_KEY_FILE             or: a file holding the key (mounted secret); read at start, never logged
 *   CTC_SEMANTIC_PROVIDER                 "openai" (any OpenAI-compatible /chat/completions API) or "anthropic"
 *   CTC_SEMANTIC_BASE_URL                 e.g. http://localhost:11434/v1 for a local OpenAI-compatible server
 *   CTC_SEMANTIC_MODEL                    model id
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY    used only with CTC_SEMANTIC=on, when CTC_SEMANTIC_API_KEY is not set
 */
export type SemanticProvider = "openai" | "anthropic";

export interface SemanticProviderConfig {
  provider: SemanticProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  jsonMode: boolean;
}

export type SemanticAvailability = { enabled: true; config: SemanticProviderConfig } | { enabled: false; reason: string };

const DEFAULTS: Record<SemanticProvider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
};

export function semanticProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SemanticAvailability {
  const flag = (env.CTC_SEMANTIC ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return { enabled: false, reason: "CTC_SEMANTIC is off" };
  const requested = (env.CTC_SEMANTIC_PROVIDER ?? "").trim().toLowerCase();
  if (requested && requested !== "openai" && requested !== "anthropic") {
    return { enabled: false, reason: `unknown CTC_SEMANTIC_PROVIDER '${requested}' (use openai or anthropic)` };
  }
  let provider: SemanticProvider | null = requested === "anthropic" ? "anthropic" : requested === "openai" ? "openai" : null;
  let apiKey = (env.CTC_SEMANTIC_API_KEY ?? "").trim();
  if (!apiKey && env.CTC_SEMANTIC_API_KEY_FILE) {
    // BYOK from a mounted secret (Kubernetes / Docker secrets, a vault agent sink). The key is read, never logged.
    try {
      apiKey = fs.readFileSync(env.CTC_SEMANTIC_API_KEY_FILE, "utf8").trim();
    } catch {
      return { enabled: false, reason: "CTC_SEMANTIC_API_KEY_FILE is set but the file cannot be read" };
    }
  }
  // Privacy: an ambient vendor key (often exported for other tools) never sends code anywhere on its own.
  // Only CTC_SEMANTIC_API_KEY(_FILE) or an explicit CTC_SEMANTIC=on opts in.
  const optedIn = flag === "on" || flag === "1" || flag === "true";
  if (!apiKey && optedIn) {
    if ((provider === null || provider === "anthropic") && env.ANTHROPIC_API_KEY?.trim()) {
      apiKey = env.ANTHROPIC_API_KEY.trim();
      provider = "anthropic";
    } else if ((provider === null || provider === "openai") && env.OPENAI_API_KEY?.trim()) {
      apiKey = env.OPENAI_API_KEY.trim();
      provider = "openai";
    }
  }
  if (!apiKey) return { enabled: false, reason: "off by default: set CTC_SEMANTIC_API_KEY (or CTC_SEMANTIC_API_KEY_FILE), or CTC_SEMANTIC=on to use ANTHROPIC_API_KEY / OPENAI_API_KEY" };
  const chosen: SemanticProvider = provider ?? "openai";
  return {
    enabled: true,
    config: {
      provider: chosen,
      apiKey,
      baseUrl: (env.CTC_SEMANTIC_BASE_URL?.trim() || DEFAULTS[chosen].baseUrl).replace(/\/+$/, ""),
      model: env.CTC_SEMANTIC_MODEL?.trim() || DEFAULTS[chosen].model,
      jsonMode: (env.CTC_SEMANTIC_JSON_MODE ?? "").trim().toLowerCase() !== "off",
    },
  };
}
