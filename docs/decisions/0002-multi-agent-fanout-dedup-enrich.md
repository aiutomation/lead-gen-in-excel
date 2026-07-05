# ADR 0002 — Concurrent research fan-out, dedup cycle, web-search-for-all + LinkedIn enrichment

**Date:** 2026-06-29
**Status:** Accepted
**Supersedes (partially):** ADR 0001 — the verify path no longer uses the round-based
`runResearchLoop`; it now uses `runMultiAgentResearch`. `runResearchLoop` is kept as the
legacy single-researcher loop but is no longer wired to the route.

## Context
New client requirements:
1. 1–5 AI research agents running **concurrently** on the same brief.
2. A **dedup cycle**: review agent #1 removes duplicate buildings; review agent #2
   proofchecks the data.
3. **Every** agent must have web search (built-in or Tavily/Firecrawl), including a
   **LinkedIn** lookup for the person-in-charge of each building.

## Decision 1 — Fan-out → funnel topology, plain `Promise.all` (not LangGraph)
N researchers run via `Promise.allSettled` (one agent failing doesn't sink the run),
then the combined pile flows through two sequential review gates and optional enrichment.

- **Alternative:** extend the LangGraph `entrypoint`/`task` graph from ADR 0001.
- **Why plain async won:** this is a single pass, not a resumable multi-round loop —
  no checkpointer/`thread_id` semantics needed. Plain `Promise.all` is ~30 lines and
  obvious; the graph machinery would add ceremony with no payoff here.
- **Diversity:** "same brief + dedup" (user's choice) → each agent gets a different
  `temperature` (0.30, 0.42, …) + a neutral angle nudge, so five agents don't return
  five identical lists. Each over-fetches (`target * 1.5 / agents`) so the deduped
  union still clears the target.

## Decision 2 — LLM dedup agent, deterministic merge
Review agent #1 (`dedupeBuildings`) asks an LLM only to **group** rows that are the
same physical building (aliases/typos the exact-string key misses), then code merges
each group (keep most-complete row, back-fill `N/A` from mates).

- **Why split:** fuzzy "is KLCC the same as Suria KLCC?" needs an LLM; the merge is
  mechanical and must be deterministic/testable (`applyDedupGroups`, unit-tested).
- **Cheap exact-key dedup runs first** so the LLM only judges what survives — saves tokens.
- Review agent #2 = the existing `reviewBuildings` fact-checker, unchanged.

## Decision 3 — Tavily + Firecrawl, raw `fetch` (no SDK)
`lib/search.ts` wraps both as single-endpoint `fetch` calls, matching the existing
Groq/MiMo style in `callModelOnce`.

- **Alternative:** `@tavily/core` + `@mendable/firecrawl-js` SDKs.
- **Why raw fetch won:** each API is one POST; the codebase already calls OpenAI-compatible
  providers via raw fetch; zero new deps to version-chase. ("use sdk if needed" → not needed.)
- **Tavily** = LLM-tuned search → injected as grounding context for non-grounded providers
  (Groq/MiMo), so "every agent has web search". Gemini keeps its native Google-Search grounding.
- **Firecrawl** = optional page scrape to deepen the LinkedIn lookup.
- Both **degrade to empty** when their key is missing — the app still runs keyless.

## Decision 4 — LinkedIn via public search, conservative, opt-in
`findPersonInCharge` resolves the operator company → searches its people on
`linkedin.com` (public snippets) → an LLM extracts a contact, returning **N/A when not
confident** (no guessing).

- **Why not authenticated scraping:** LinkedIn blocks it and forbids it in ToS. We never
  log in; we read public SERP data only.
- **Opt-in toggle + bounded concurrency (3):** ~2–3 search calls per building would burn
  Tavily's free tier fast at always-on; gated behind the `Enrich` switch.

## Files
- `lib/search.ts` *(new)* — `tavilySearch`, `firecrawlScrape`, key-presence flags
- `lib/enrich.ts` *(new)* — `findPersonInCharge`
- `lib/llm.ts` — web-context injection, `temperature` param, `dedupeBuildings` + `applyDedupGroups`
- `lib/agents.ts` — `runMultiAgentResearch` orchestrator
- `lib/columns.ts` — `Person In Charge`, `PIC LinkedIn`
- `app/api/generate/route.ts` — `agents` (1–5) + `enrich` inputs, multi-agent verify path
- `app/page.tsx` — Agents/Enrich controls, dedup-merge + pipeline-trace UI
- Tests: `lib/search.test.ts`, `lib/dedup.test.ts`
