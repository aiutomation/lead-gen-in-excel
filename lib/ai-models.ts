import { generateText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { tavilySearch, hitsToContext, hasTavily, type ToolEvent } from "./search";
import {
  asArray,
  parseJsonLoose,
  normalizeRow,
  rawCitations,
  rawUngrounded,
  applyGrounding,
  type Row,
} from "./llm";
import { FEW_SHOT_EXAMPLES } from "./columns";

// ─────────────────────────────────────────────────────────────────────────
// Vercel AI SDK model registry — the "different model per agent" layer.
//
// Each fan-out research agent can run a DIFFERENT model so their strengths
// complement, then the combined pile is deduped + fact-checked. Models are
// SELECTABLE per agent in the UI; a provider only appears once its API key is
// set, so you add a key afterward and its models light up.
//
// Almost every provider here is OpenAI-compatible (/chat/completions + /models),
// so they share ONE adapter (@ai-sdk/openai-compatible) — no per-provider dep.
// Only Gemini uses its own SDK (native grounding lives on the classic path).
// ─────────────────────────────────────────────────────────────────────────

type ProviderKind = "google" | "openai-compatible";

type AiProvider = {
  id: string; // short key used in model ids: "openai", "xai", …
  label: string;
  envKey: string; // env var holding the API key
  kind: ProviderKind;
  baseURL?: string; // OpenAI-compatible chat/models base
  modelsUrl?: string; // override for the /models listing endpoint
  grounded: boolean; // native web access? (only Gemini — others lean on Tavily)
  models: string[]; // curated fallback ids (live listing is preferred when keyed)
  cap?: number; // max models to surface in the picker (gateways list hundreds)
  brandGrouped?: boolean; // ids are "creator/model" → curate to 5 per brand (gateway/OpenRouter)
};

// The registry. Add a provider here and it becomes selectable the moment its key
// is present. baseURL must be the root the OpenAI-compatible adapter appends to.
const PROVIDERS: AiProvider[] = [
  {
    id: "gemini",
    label: "Gemini",
    envKey: "GEMINI_API_KEY",
    kind: "google",
    grounded: true,
    // `*-latest` aliases: gemini-2.5-flash 404s for new accounts; flash-lite-latest
    // has usable free-tier quota. Aliases won't silently expire by name.
    models: ["gemini-flash-lite-latest", "gemini-flash-latest"],
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
  },
  {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    grounded: false,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    // PREMIUM, OFFICIAL — placed 3rd so the default panel is Gemini → Groq → GPT
    // once an OpenAI key is present. OpenAI-compatible (chat models).
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    grounded: false,
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  {
    id: "mimo",
    label: "MiMo",
    envKey: "MIMO_API_KEY",
    kind: "openai-compatible",
    baseURL: process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1",
    grounded: false,
    models: ["mimo-v2.5-pro", "mimo-v2.5"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    envKey: "XAI_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://api.x.ai/v1",
    grounded: false,
    models: ["grok-2-latest"],
  },
  {
    // Cheap, strong. OpenAI-compatible.
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    grounded: false,
    models: ["deepseek-chat"],
  },
  {
    // One key → hundreds of (often cheap) models. ids look like "vendor/model".
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    grounded: false,
    models: ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b-instruct"],
    cap: 24,
    brandGrouped: true,
  },
  {
    // PREMIUM, OFFICIAL — Mistral's flagship models, direct. OpenAI-compatible.
    id: "mistral",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://api.mistral.ai/v1",
    grounded: false,
    models: ["mistral-large-latest", "mistral-small-latest"],
  },
  {
    // Vercel AI Gateway — ONE key → every PREMIUM OFFICIAL model (Claude, GPT,
    // Gemini, Grok, Mistral…) behind "creator/model" ids. The Vercel-native way to
    // get many official providers at once. OpenAI-compatible → no extra dependency.
    id: "gateway",
    label: "Vercel AI Gateway",
    envKey: "AI_GATEWAY_API_KEY",
    kind: "openai-compatible",
    baseURL: "https://ai-gateway.vercel.sh/v1",
    grounded: false,
    models: [
      // gpt-4o first so the default 3rd agent is "one gpt" (per the goal) when the
      // gateway is the 3rd keyed provider and no direct OpenAI key is set.
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.5-pro",
      "xai/grok-3",
      "mistralai/mistral-large",
    ],
    // ~16 brands × 5 — premium brands first, then the rest (incl. Qwen, capped at 5).
    cap: 80,
    brandGrouped: true,
  },
];

const getProvider = (id: string) => PROVIDERS.find((p) => p.id === id);
const isKeyed = (p: AiProvider) => !!process.env[p.envKey];

export type ModelEntry = {
  id: string; // "provider:model" — model part may itself contain ":" (OpenRouter ":free")
  label: string; // shown in the UI / trace
  grounded: boolean;
  make: () => LanguageModel; // lazily build the AI SDK model
};

// Drop non-chat models (embeddings, audio, and image/video generators like Wan,
// Veo, Sora, Flux…) so the picker only shows text models worth selecting.
function isUsableModel(model: string): boolean {
  const m = model.toLowerCase();
  const bad = [
    "embedding", "embed", "whisper", "tts", "audio", "transcribe", "speech", "voice",
    "image", "dall-e", "imagen", "vision-only", "ocr", "moderation", "rerank", "guard",
    "realtime", "search-", // media generators (flood the gateway, not text-chat):
    "wan", "veo", "sora", "kling", "flux", "video", "stable-diffusion", "sdxl", "music",
  ];
  return !bad.some((b) => m.includes(b));
}

// Status of every registered provider — lets the UI show "add OPENAI_API_KEY" hints.
export function aiProviderStatus() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envKey: p.envKey,
    grounded: p.grounded,
    keyed: isKeyed(p),
  }));
}

// Brand ranking for "creator/model" gateways. Premium/popular brands surface first;
// within a brand we prefer curated flagships, then cost-effective/recent variants.
const PREMIUM_BRANDS = [
  "openai", "anthropic", "google", "xai", "meta", "meta-llama",
  "mistralai", "mistral", "deepseek", "moonshotai", "cohere",
];
const CHEAP_RECENT = ["mini", "flash", "lite", "haiku", "small", "nano", "turbo", "latest"];
// Older / legacy families — demoted so "recent" models win the 5-per-brand slots.
const LEGACY = ["gpt-3.5", "gpt-3-", "-instruct", "davinci", "babbage", "llama-2", "claude-2", "claude-1", "claude-3-", "text-"];

const brandOf = (id: string) => {
  const i = id.indexOf("/");
  return i === -1 ? "other" : id.slice(0, i).toLowerCase();
};

// Curate a "creator/model" catalog: group by brand, keep at most `perBrand` per brand
// (premium brands first), preferring curated + cost-effective/recent models. Stops one
// brand (e.g. Qwen's many size variants) from flooding; media-gen is dropped upstream.
export function curateBrandGrouped(live: string[], curated: string[], perBrand = 5): string[] {
  const byBrand = new Map<string, string[]>();
  for (const id of live) {
    const b = brandOf(id);
    (byBrand.get(b) ?? byBrand.set(b, []).get(b)!).push(id);
  }
  const score = (id: string) => {
    const m = id.toLowerCase();
    if (curated.includes(id)) return 3; // curated flagship
    if (LEGACY.some((k) => m.includes(k))) return 0; // old/legacy → last
    if (CHEAP_RECENT.some((k) => m.includes(k))) return 2; // cost-effective / recent
    return 1;
  };
  const ordered = [
    ...PREMIUM_BRANDS.filter((b) => byBrand.has(b)),
    ...[...byBrand.keys()].filter((b) => !PREMIUM_BRANDS.includes(b)).sort(),
  ];
  const out: string[] = [];
  for (const b of ordered) {
    out.push(
      ...byBrand
        .get(b)!
        .map((id, i) => ({ id, s: score(id), i }))
        .sort((a, z) => z.s - a.s || a.i - z.i) // score desc, otherwise stable
        .slice(0, perBrand)
        .map((x) => x.id)
    );
  }
  return out;
}

// Live model list for a keyed provider (curated ids first, then the rest), capped
// so giant catalogs (OpenRouter / the Gateway) don't flood the dropdown. Falls back to curated.
async function listProviderModels(p: AiProvider): Promise<string[]> {
  const cap = p.cap ?? 12;
  const key = process.env[p.envKey];
  if (!key) return [];
  const url = p.modelsUrl ?? `${p.baseURL}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return p.models;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const live = (data.data ?? [])
      .map((m) => (m.id ?? "").replace(/^models\//, "")) // Gemini prefixes "models/"
      .filter(Boolean)
      .filter(isUsableModel);
    if (!live.length) return p.models;
    // "creator/model" gateways (Vercel Gateway, OpenRouter) → 5 per brand, premium first.
    if (p.brandGrouped) return curateBrandGrouped(live, p.models).slice(0, cap);
    const preferred = p.models.filter((m) => live.includes(m)); // known-good first
    const rest = live.filter((m) => !preferred.includes(m)).sort();
    return [...preferred, ...rest].slice(0, cap);
  } catch {
    return p.models;
  }
}

export type AiModelOption = { id: string; label: string; provider: string; grounded: boolean };

// Flat list of selectable models across all KEYED providers (for the per-agent picker).
export async function listAiModels(): Promise<AiModelOption[]> {
  const out: AiModelOption[] = [];
  for (const p of PROVIDERS) {
    if (!isKeyed(p)) continue;
    const models = await listProviderModels(p);
    for (const m of models) {
      out.push({ id: `${p.id}:${m}`, label: `${m} · ${p.label}`, provider: p.id, grounded: p.grounded });
    }
  }
  return out;
}

// Turn a "provider:model" id into a runnable AI SDK model — or null if the
// provider is unknown or its key is missing (caller falls back).
export function resolveModel(id: string): ModelEntry | null {
  const sep = id.indexOf(":");
  if (sep === -1) return null;
  const providerId = id.slice(0, sep);
  const modelId = id.slice(sep + 1); // keep any further ":" (e.g. OpenRouter ":free")
  const p = getProvider(providerId);
  if (!p || !modelId || !isKeyed(p)) return null;
  const key = process.env[p.envKey]!;
  const label = `${modelId} · ${p.label}`;
  if (p.kind === "google") {
    const google = createGoogleGenerativeAI({ apiKey: key });
    return { id, label, grounded: p.grounded, make: () => google(modelId) };
  }
  // Default (json_schema) structured output — works for Groq/MiMo/OpenAI/DeepSeek/
  // OpenRouter. NB: the Vercel AI Gateway rejects BOTH json_schema and json_object on
  // response_format (and the user's gateway key currently 401s), so GPT-via-gateway
  // can't run — use a direct OPENAI_API_KEY for GPT, which accepts json_schema cleanly.
  const oc = createOpenAICompatible({ name: p.id, baseURL: p.baseURL!, apiKey: key });
  return { id, label, grounded: p.grounded, make: () => oc(modelId) };
}

// Default pool: the first curated model of each KEYED provider (used to
// auto-assign distinct models when the UI doesn't send explicit per-agent picks).
export function buildModelPool(): ModelEntry[] {
  const pool: ModelEntry[] = [];
  for (const p of PROVIDERS) {
    if (!isKeyed(p)) continue;
    const entry = resolveModel(`${p.id}:${p.models[0]}`);
    if (entry) pool.push(entry);
  }
  return pool;
}

// Which model the i-th agent uses by default — cycles the pool so N agents spread
// across all keyed providers (then repeat with a temperature offset upstream).
export function pickModelForAgent(pool: ModelEntry[], i: number): ModelEntry {
  return pool[i % pool.length];
}

// Run ONE research agent on ONE model via the AI SDK, returning normalised rows.
// Every model gets Tavily web context injected (uniform grounding), so "each
// agent has web search" holds regardless of which model it runs.
export type ResearchResult = { rows: Row[]; events: ToolEvent[] };

// Text completion on any AI-SDK model — the unified backend for the review agent,
// dedup, and enrichment extraction (so they share the rich model registry with
// research). No web grounding here; callers inject Tavily context if they want it.
export async function completeWithModel(
  entry: ModelEntry,
  system: string,
  user: string,
  temperature?: number
): Promise<string> {
  const { text } = await generateText({ model: entry.make(), system, prompt: user, temperature });
  return text;
}

export async function researchWithModel(
  entry: ModelEntry,
  brief: string,
  columns: string[],
  count: number,
  opts: { temperature?: number; diversify?: string } = {}
): Promise<ResearchResult> {
  const events: ToolEvent[] = [];
  let webContext = "";
  let sources: string[] = [];
  if (hasTavily()) {
    const hits = await tavilySearch(brief, { maxResults: 6 });
    if (hits.length) {
      webContext = "Live web results (prefer buildings that appear here):\n" + hitsToContext(hits);
      sources = hits.map((h) => h.url).filter(Boolean).slice(0, 8);
    }
    // Record the search so the UI can prove this agent hit the web (Tavily).
    events.push({
      stage: "research", tool: "tavily", label: `Web search · ${entry.label}`,
      query: brief.slice(0, 120), resultCount: hits.length,
      urls: sources.slice(0, 5), ok: hits.length > 0,
    });
  }

  // Free-text JSON + tolerant parse (the same path the classic researchBuildings
  // uses), NOT generateObject's pinned response-schema. Gemini's structured-output
  // constraint engine rejects a schema with this many long column names ("too many
  // states for serving"); a plain text completion + parseJsonLoose sidesteps that
  // and works for every provider. Keys are pinned in the PROMPT instead.
  // The model call + parse are best-effort: the web SEARCH already succeeded (and is
  // logged), so a model error (rate limit / API hiccup) or unparseable JSON must NOT
  // discard the agent and its proof-of-search. On any failure we keep the recorded
  // search event, note what happened, and yield 0 rows — the agent still counts as
  // "searched successfully", it just contributed nothing to the table.
  const wantCitations = columns.includes("Citations");
  let rows: Row[] = [];
  try {
    const { text } = await generateText({
      model: entry.make(),
      temperature: opts.temperature,
      system:
        "You are a building/facility prospecting researcher for a chilled-water (HVAC) sales team. " +
        "Find REAL, named buildings — never invent placeholders.",
      prompt: [
        `Task: ${brief}`,
        opts.diversify ? `Angle for THIS agent: ${opts.diversify}` : "",
        webContext,
        "",
        "Match this format (values only — omit fields you don't know):",
        JSON.stringify(FEW_SHOT_EXAMPLES[0]),
        "",
        `Return up to ${count} buildings as a JSON object {"rows": [ ... ]}.`,
        // The literal word "JSON" above is kept: some OpenAI-compatible providers
        // still expect it, and it steers the model to emit pure JSON.
        "Each row object MUST use EXACTLY these keys (verbatim spelling):",
        JSON.stringify(columns),
        'Use "N/A" when a fact is unknown. Prefer large buildings likely on a central chilled-water system.',
        'Do not invent precise figures; prefix uncertain numbers with "~".',
        // Grounding: cite from the live web results above and flag anything not backed by them.
        wantCitations
          ? '- "Citations": array of the source URLs (from the live web results above) that support THIS building.'
          : "",
        wantCitations
          ? '- "_ungrounded": array of any of the above columns whose value is NOT backed by those results ([] if all cited).'
          : "",
        '- Output JSON ONLY in the form {"rows": [ ... ]}. No prose, no markdown fences.',
      ]
        .filter(Boolean)
        .join("\n"),
    });
    const parsed = asArray(parseJsonLoose(text));
    if (wantCitations) {
      // Grounding gate: keep only URLs Tavily actually returned; drop ungrounded rows.
      const items = parsed.map((o) => {
        const row = normalizeRow(o, columns);
        row.Citations = rawCitations(o);
        return { row, ungrounded: rawUngrounded(o) };
      });
      const { kept, dropped } = applyGrounding(items, sources, columns);
      rows = kept;
      const last = events[events.length - 1];
      if (last && dropped.length) last.detail = `${dropped.length} row(s) rejected — no grounded source`;
    } else {
      rows = parsed.map((o) => normalizeRow(o, columns));
    }
  } catch (e) {
    const last = events[events.length - 1];
    if (last) last.detail = `search ok — model yielded no usable rows (${(e as Error)?.name ?? "error"})`;
  }
  return { rows, events };
}
