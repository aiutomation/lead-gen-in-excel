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

## How it works

**Fast path** (Verify off) — one research pass:
```
page.tsx ──POST /api/generate──▶ researchBuildings ──▶ Gemini (grounded) / Groq / MiMo ──▶ { rows }
```

**Verify path** (Verify on) — the multi-agent loop (LangGraph functional API, ported
from `multiagent_langgraph_autogen.py`):
```
runResearchLoop (driver, round cap)
  └─ entrypoint + MemorySaver  ── per round ──▶ researchTask ──▶ reviewTask
       (verified rows persist                   (find gap)      (web fact-check:
        across rounds via thread_id)                             keep / flag / drop)
  stops when target met OR a round adds nothing
```
Dropped rows shrink the verified count, so the next round web-searches for replacements.
Each kept row carries a `verified`/`flagged` status + reviewer note; the response includes
a per-round `trace`.

- `lib/agents.ts` — the LangGraph workflow + `runResearchLoop` driver (the loop).
- `lib/llm.ts` — `callModel` primitive (grounded flag) + `researchBuildings` + `reviewBuildings`.
- `lib/providers.ts` — provider registry; `enabledProviders()` drives the dropdown.
- `lib/auth.ts` — password gate; checked again server-side in `/api/generate`.
- `lib/export.ts` — SheetJS writes CSV/XLSX in the current (drag-reorderable) column order.
- `lib/columns.ts` — the 22 default columns + default prompt.

**Citations:** on Gemini, a grounded prose pass captures real source URLs (a JSON
response returns none), then a structuring pass builds the rows.

**Columns:** drag a chip to reorder — the table *and* the exported spreadsheet follow that order.

## Stack
Next.js (App Router) · TypeScript · Tailwind v4 · shadcn/ui · `@google/genai` · SheetJS (`xlsx`).
