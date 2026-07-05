import { callModel, type LlmRun } from "./llm";
import type { ProviderId } from "./providers";
import {
  tavilySearch,
  firecrawlScrape,
  hitsToContext,
  hasTavily,
  hasFirecrawl,
  type SearchHit,
  type ToolEvent,
} from "./search";

// ---------------------------------------------------------------- LINKEDIN ENRICHMENT
// "Find the person-in-charge of a building." LinkedIn blocks scraping + forbids it
// in ToS, so we do NOT log in or harvest profiles. Instead we search PUBLIC web data:
//   1. resolve the company that owns/operates the building,
//   2. search that company's people for a facilities/property/building manager,
//   3. (optional) read a real company page via Firecrawl for confirmation,
//   4. an LLM extracts a structured contact — and returns N/A when not confident
//      (no guessing — a wrong contact is worse than a blank).

export type PersonInCharge = {
  name: string; // "N/A" when no confident match
  role: string;
  linkedin: string; // public profile/company URL, or "N/A"
  company: string;
};

const NA: PersonInCharge = { name: "N/A", role: "N/A", linkedin: "N/A", company: "N/A" };

// Parse the LLM's extraction, coercing anything missing/blank to "N/A".
function toPerson(obj: unknown): PersonInCharge {
  const r = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const s = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t && t.toLowerCase() !== "n/a" && t.toLowerCase() !== "unknown" ? t : "N/A";
  };
  return { name: s(r.name), role: s(r.role), linkedin: s(r.linkedin), company: s(r.company) };
}

export type EnrichResult = { person: PersonInCharge; events: ToolEvent[] };

export async function findPersonInCharge(
  provider: ProviderId,
  model: string,
  building: string,
  address: string,
  // Optional AI-SDK completer (unified registry); falls back to legacy callModel.
  run?: LlmRun
): Promise<EnrichResult> {
  const events: ToolEvent[] = [];
  // No web-search key → can't look anyone up. Honest N/A rather than a hallucinated name.
  if (!hasTavily()) return { person: NA, events };

  const label = [building, address].filter((x) => x && x !== "N/A").join(", ");
  if (!label) return { person: NA, events };

  // Two searches in parallel: who operates the building, and who manages it on LinkedIn.
  const companyQuery = `company that owns or operates "${building}" ${address} property management`;
  const peopleQuery = `"${building}" facilities manager OR property manager OR building manager`;
  const [companyHits, peopleHits] = await Promise.all([
    tavilySearch(companyQuery, { maxResults: 4 }),
    tavilySearch(peopleQuery, { maxResults: 5, includeDomains: ["linkedin.com"] }),
  ]);
  // Record both searches so the UI can prove web search + LinkedIn lookup ran.
  events.push({
    stage: "enrich", tool: "tavily", label: `Operator search · ${building}`,
    query: companyQuery, resultCount: companyHits.length,
    urls: companyHits.map((h) => h.url).filter(Boolean).slice(0, 5), ok: companyHits.length > 0,
  });
  events.push({
    stage: "enrich", tool: "tavily", label: `LinkedIn people search · ${building}`,
    query: peopleQuery, resultCount: peopleHits.length,
    urls: peopleHits.map((h) => h.url).filter(Boolean).slice(0, 5), ok: peopleHits.length > 0,
  });

  let context = hitsToContext([...companyHits, ...peopleHits]);

  // Optional deepening: if Firecrawl is configured, read the top REAL company page
  // (skip linkedin.com — it serves a login wall, not content) for extra detail.
  if (hasFirecrawl()) {
    const page = pickCompanyUrl([...companyHits, ...peopleHits]);
    if (page) {
      const md = await firecrawlScrape(page);
      events.push({
        stage: "enrich", tool: "firecrawl", label: `Scrape operator page`,
        query: page, resultCount: md ? 1 : 0, urls: [page], ok: !!md,
      });
      if (md) context += `\n\nPage content from ${page}:\n${md}`;
    }
  }

  if (!context.trim()) return { person: NA, events };

  const system =
    "You extract the single best 'person in charge' of a building's facilities from web search results. " +
    "Be conservative: only return a person if the results clearly tie a NAMED individual to managing/" +
    "operating THIS building or its operator company. If unsure, return N/A for that field. Never invent a name.";
  const user = [
    `Building: ${label}`,
    "",
    "Search results:",
    context,
    "",
    'Output JSON ONLY: {"name": "...", "role": "...", "linkedin": "<public url>", "company": "<operator>"}.',
    'Use "N/A" for any field you cannot support from the results above. Do not guess.',
  ].join("\n");

  try {
    const text = run
      ? await run(system, user, false)
      : (await callModel(provider, model, system, user, false)).text;
    const person = toPerson(parseFirstObject(text));
    // The enrichment OUTCOME — so the user sees whether LinkedIn/web actually yielded a person.
    events.push({
      stage: "enrich", tool: "extract", label: `Person-in-charge · ${building}`,
      query: label, resultCount: person.name !== "N/A" ? 1 : 0,
      urls: person.linkedin !== "N/A" ? [person.linkedin] : [], ok: person.name !== "N/A",
      detail:
        person.name !== "N/A"
          ? `Found: ${person.name}${person.role !== "N/A" ? ` — ${person.role}` : ""}`
          : "No confident match — left N/A",
    });
    return { person, events };
  } catch {
    return { person: NA, events }; // enrichment is best-effort — never fail the row over it
  }
}

// First real (non-LinkedIn) URL in the hits — the operator's own site is worth scraping;
// linkedin.com is not (login wall).
function pickCompanyUrl(hits: SearchHit[]): string | null {
  const hit = hits.find((h) => h.url && !/linkedin\.com/i.test(h.url));
  return hit?.url ?? null;
}

// Tiny local JSON extractor (the LLM may wrap the object in prose/fences).
function parseFirstObject(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(cleaned.slice(a, b + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}
