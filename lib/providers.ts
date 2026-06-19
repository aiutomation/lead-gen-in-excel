// Provider registry. Each entry is one selectable LLM provider.
// `grounded: true` means it can pull live web data (Gemini Google Search).
// `baseURL`/`models` are used by the OpenAI-compatible adapter (Groq, MiMo) and
// for listing available models. `modelsUrl` overrides where we GET the model list.
export type ProviderId = "gemini" | "groq" | "mimo";

export interface ProviderConfig {
  label: string;
  env: string; // name of the env var holding the API key
  grounded: boolean;
  baseURL?: string; // OpenAI-compatible chat endpoint (Groq / MiMo)
  models: string[]; // curated fallback list (used if the live /models call fails)
  modelsUrl?: string; // where to GET the live model list (defaults to baseURL/models)
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    label: "Gemini",
    env: "GEMINI_API_KEY",
    grounded: true,
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    // OpenAI-compatible model list (generation still uses the @google/genai SDK).
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
  },
  groq: {
    label: "Groq",
    env: "GROQ_API_KEY",
    grounded: false,
    baseURL: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  mimo: {
    // OPTIONAL. Pay-as-you-go sk- key uses the STANDARD platform endpoint below.
    // (The tp- grant token uses token-plan-sgp.xiaomimimo.com and forbids backends.)
    label: "MiMo",
    env: "MIMO_API_KEY",
    grounded: false,
    baseURL: "https://api.xiaomimimo.com/v1",
    models: ["mimo-v2.5-pro", "mimo-v2.5"],
  },
};

// The default model for a provider (first in its list).
export const defaultModel = (id: ProviderId) => PROVIDERS[id].models[0];

// Resolve a request's (possibly missing/unknown) provider id to a valid one,
// falling back to `fallback`. The review agent uses this to default to the
// research agent's provider when the UI didn't send a separate review provider.
export function resolveProviderId(
  candidate: string | undefined,
  fallback: ProviderId
): ProviderId {
  return candidate && candidate in PROVIDERS ? (candidate as ProviderId) : fallback;
}

// Which providers actually have an API key configured — drives the dropdown so a
// provider with no key never appears (MiMo vanishes unless MIMO_API_KEY is set).
export function enabledProviders(): ProviderId[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).filter(
    (id) => !!process.env[PROVIDERS[id].env]
  );
}

// Keep only models that make sense for our chat/JSON generation use-case.
function isUsableModel(id: ProviderId, model: string): boolean {
  const m = model.toLowerCase();
  // Drop non-text models (speech/audio/image/robotics/specialised) — keep chat/JSON-capable ones.
  const bad = [
    "embedding", "embed", "whisper", "tts", "guard", "imagen", "image", "aqa",
    "rerank", "vision-only", "audio", "asr", "robotics", "live", "computer-use", "orpheus",
  ];
  if (bad.some((b) => m.includes(b))) return false;
  if (id === "gemini") return m.includes("gemini"); // skip non-Gemini families
  return true;
}

// Ask a provider which models its key can actually use (live), falling back to the
// curated list if the call fails. Gemini/Groq/MiMo all expose an OpenAI-style
// /models endpoint that accepts the key as a Bearer token.
export async function listModels(id: ProviderId): Promise<string[]> {
  const cfg = PROVIDERS[id];
  const key = process.env[cfg.env];
  const url = cfg.modelsUrl ?? `${cfg.baseURL}/models`;
  if (!key) return cfg.models;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return cfg.models;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const live = (data.data ?? [])
      .map((m) => (m.id ?? "").replace(/^models\//, "")) // Gemini prefixes "models/"
      .filter(Boolean)
      .filter((m) => isUsableModel(id, m));
    if (!live.length) return cfg.models;
    // Put the curated "known-good" models first (so the UI default is reliable —
    // e.g. gemini-2.5-flash, not a free-tier-blocked model), then the rest sorted.
    const preferred = cfg.models.filter((m) => live.includes(m));
    const rest = live.filter((m) => !preferred.includes(m)).sort();
    return [...preferred, ...rest];
  } catch {
    return cfg.models;
  }
}
