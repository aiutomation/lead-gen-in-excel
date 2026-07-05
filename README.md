# Chilled-Water Lead Console

A tiny Next.js app that replaces the manual "prompt ChatGPT → paste into Excel" loop for
finding large buildings/facilities likely to run a **central chilled-water (HVAC)** system —
qualified sales leads. You write a search brief, pick an LLM, get a structured table, tweak
it inline, and export to **CSV / XLSX**.

## Quick start

```bash
cp .env.example .env.local   # then paste at least one API key
npm run dev                  # http://localhost:3000
```

Password: **`Sales123@`** (placeholder — change `APP_PASSWORD` in `.env.local`).

## Providers (set at least one key)

A provider only appears in the dropdown if its key is present in `.env.local`.

| Key | Provider | Notes |
|-----|----------|-------|
| `GEMINI_API_KEY` | Gemini 2.5 Flash | **Web-grounded** (Google Search) — fills the *Citations* column with source URLs. The default. |
| `GROQ_API_KEY` | Groq · Llama 3.3 70B | Fast, knowledge-only. |
| `MIMO_API_KEY` | MiMo v2.5 | **Optional.** Pay-as-you-go `sk-` key → `api.xiaomimimo.com` (the `tp-` grant token uses a different host and forbids app backends). |

**Model picker:** for the chosen provider, the UI lists every usable model fetched live
from that provider's `/models` endpoint (`lib/providers.ts → listModels`), so you can pick
e.g. `gemini-2.5-pro`, `llama-3.3-70b-versatile`, or `mimo-v2.5-pro`.

## Web search (optional — for multi-agent verify + LinkedIn enrichment)

| Key | Service | What it unlocks |
|-----|---------|-----------------|
| `TAVILY_API_KEY` | [Tavily](https://app.tavily.com) (free ~1k/mo) | Gives **every** provider live web search (not just Gemini) and powers the `Enrich` LinkedIn person-in-charge lookup. |
| `FIRECRAWL_API_KEY` | [Firecrawl](https://firecrawl.dev) (free ~500 credits) | Optional deepener — scrapes a real operator/company page to confirm a contact. |

Without these, Gemini still web-searches via its own grounding, Groq/MiMo stay
knowledge-only, and `Enrich` returns `N/A`. The app runs fine keyless. **Note:** the
LinkedIn lookup uses *public web search only* — it never logs into or scrapes LinkedIn
(blocked + against ToS), and leaves the contact `N/A` when it can't find a confident match.

## How it works

**Fast path** (Verify off) — one research pass:
```
page.tsx ──POST /api/generate──▶ researchBuildings ──▶ Gemini (grounded) / Groq / MiMo ──▶ { rows }
```

**Verify path** (Verify on) — the multi-agent **fan-out → funnel** (`runMultiAgentResearch`):
```
N research agents (1–5, concurrent, same brief, diversified by temperature)
   └─▶ merge ─▶ dedup agent #1 ─▶ fact-check agent #2 ─▶ enrich (optional)
       (exact-key   (LLM groups      (web fact-check:      (LinkedIn person-
        dedup free)  fuzzy aliases)   keep/flag/drop)        in-charge lookup)
```
- **Agents (1–5):** each over-fetches and explores a slightly different angle, so the
  combined pile is diverse enough to be worth deduping.
- **Multi-model** (toggle): the Research card *becomes* a per-agent model picker — each
  agent runs a *different*, **selectable** model via the **Vercel AI SDK** (`lib/ai-models.ts`),
  auto-defaulted to distinct. Off → the classic single Research picker.
  - **Key-gated registry** (9 providers): Gemini, Groq, MiMo, OpenAI, xAI, DeepSeek,
    OpenRouter, **Mistral**, and the **Vercel AI Gateway**. Add a key to `.env.local` and that
    provider's models appear in the picker — no code change.
  - **Premium official models:** the easiest path is one `AI_GATEWAY_API_KEY` (Vercel AI
    Gateway) → hundreds of flagship models (`anthropic/claude-…`, `openai/gpt-…`,
    `google/gemini-…`, `xai/grok-…`, `mistralai/…`). Or add direct provider keys.
  - 3 keyed providers → 28 selectable models today; add ≥2 keys → 5 distinct agents.
- **Dedup agent #1** (`dedupeBuildings`) groups same-building aliases ("KLCC" / "Suria
  KLCC") an exact-string match can't catch; the merge keeps the most-complete row.
- **Fact-check agent #2** (`reviewBuildings`) votes verified / flagged / reject per row.
- **Enrich** (opt-in toggle) fills `Person In Charge` + `PIC LinkedIn` via public web
  search — `N/A` when no confident match (never a guess).

The response includes `before` (raw candidates), `dropped` (+reasons), `merges` (deduped
pairs), and a `trace` of per-stage counts.

- `lib/agents.ts` — `runMultiAgentResearch` (new verify path) + legacy `runResearchLoop`.
- `lib/llm.ts` — `callModel` (grounded + temperature) + `researchBuildings` + `reviewBuildings` + `dedupeBuildings`.
- `lib/search.ts` — Tavily search + Firecrawl scrape (raw fetch, key-optional).
- `lib/enrich.ts` — `findPersonInCharge` (company → public LinkedIn people search).
- `lib/providers.ts` — provider registry; `enabledProviders()` drives the dropdown.
- `lib/auth.ts` — password gate; checked again server-side in `/api/generate`.
- `lib/export.ts` — SheetJS writes CSV/XLSX in the current (drag-reorderable) column order.
- `lib/columns.ts` — the 24 default columns + default prompt.

**Citations:** on Gemini, a grounded prose pass captures real source URLs (a JSON
response returns none), then a structuring pass builds the rows.

**Columns:** drag a chip to reorder — the table *and* the exported spreadsheet follow that order.

## Stack
Next.js (App Router) · TypeScript · Tailwind v4 · shadcn/ui · `@google/genai` · Vercel AI SDK
(`ai` + `@ai-sdk/google` + `@ai-sdk/openai-compatible`) · LangGraph · Tavily/Firecrawl · SheetJS (`xlsx`).
