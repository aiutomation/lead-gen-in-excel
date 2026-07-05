// Shared web-search layer. Gives EVERY agent live web access — not just Gemini.
//
// Two backends, both raw `fetch` (no SDK) to match the existing Groq/MiMo style in
// llm.ts → callModelOnce. Why raw fetch over @tavily/core / @mendable/firecrawl-js:
// each is a single-endpoint POST, the codebase already calls OpenAI-compatible
// providers this way, and it keeps zero extra deps to version-chase.
//
//   Tavily    → LLM-tuned web SEARCH (snippets + URLs). Cheap, fast. The default.
//   Firecrawl → full-page SCRAPE to markdown. Heavier; used to read a specific page
//               (e.g. a company / public LinkedIn page) when a snippet isn't enough.
//
// Both degrade gracefully: if the API key is missing or the call fails, they return
// an empty result instead of throwing — web search is best-effort enrichment, it must
// never crash a generation run.

export type SearchHit = {
  title: string;
  url: string;
  content: string; // snippet / excerpt
};

// One observable tool call in a run, surfaced to the UI so the user can SEE that
// web search / LinkedIn lookup / enrichment actually happened (and with what result).
// Built by the leaf function that made the call (it knows the query + gets the hits),
// then aggregated by the orchestrator into a per-run tool log.
export type ToolEvent = {
  stage: "research" | "enrich"; // which pipeline phase made the call
  agent?: number; // research agent index (0-based), when applicable
  tool: "tavily" | "firecrawl" | "gemini" | "extract"; // web-search / scrape / native grounding / LLM extraction
  label: string; // human summary of the call's purpose (e.g. building name, "LinkedIn people search")
  query: string; // the actual query / target sent to the tool
  resultCount: number; // hits returned (0 = nothing found)
  urls: string[]; // top result URLs — the evidence the user can click
  ok: boolean; // did the call succeed (vs missing key / error / empty)
  detail?: string; // outcome note, e.g. "Found: Jane Doe — Facilities Manager" or "no confident match"
};

const TAVILY_URL = "https://api.tavily.com/search";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

// True only when the corresponding key is present — lets callers branch (e.g. skip
// LinkedIn enrichment entirely when no search key is configured).
export const hasTavily = () => !!process.env.TAVILY_API_KEY;
export const hasFirecrawl = () => !!process.env.FIRECRAWL_API_KEY;
// "Can any agent search the web?" — Gemini grounding is handled separately in llm.ts;
// this is specifically the shared Tavily/Firecrawl path for non-grounded providers.
export const hasWebSearch = () => hasTavily() || hasFirecrawl();

// ---------------------------------------------------------------- Tavily search
// Returns up to `maxResults` hits, or [] on any failure / missing key.
// `includeDomains` narrows the search (e.g. ["linkedin.com"] for people lookups).
export async function tavilySearch(
  query: string,
  { maxResults = 5, includeDomains }: { maxResults?: number; includeDomains?: string[] } = {}
): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
        ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
    }));
  } catch {
    return []; // best-effort — never break a run on a search hiccup
  }
}

// ---------------------------------------------------------------- Firecrawl scrape
// Fetches one page as markdown, or null on any failure / missing key. Truncated to
// `maxChars` so a huge page can't blow the LLM context budget downstream.
export async function firecrawlScrape(
  url: string,
  { maxChars = 4000 }: { maxChars?: number } = {}
): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { markdown?: string } };
    const md = data.data?.markdown;
    return md ? md.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- helper
// Flatten search hits into a compact text block agents can read as grounding context.
export function hitsToContext(hits: SearchHit[]): string {
  if (!hits.length) return "";
  return hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`)
    .join("\n\n");
}
