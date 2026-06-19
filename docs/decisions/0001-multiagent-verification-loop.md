# ADR 0001 — Multi-agent verification loop + citations

**Date:** 2026-06-11
**Status:** Accepted

## Context
The lead table was generated in a single LLM pass and taken at face value. We
wanted a self-correcting layer (research → fact-check → regenerate the gaps),
modelled on `multiagent_langgraph_autogen.py` (LangGraph `entrypoint` + `@task`
+ `MemorySaver`). We also need a `Citations` column with real source URLs.

## Decision 1 — LangGraph.js, not a native-TS port
Use `@langchain/langgraph` (`entrypoint`, `task`, `MemorySaver`, `getPreviousState`,
`entrypoint.final`) so the loop faithfully mirrors the Python reference.

- **Alternative considered:** hand-rolled TS loop (no dep, ~10MB lighter).
- **Why LangGraph won:** the user explicitly chose it; gives real checkpointer
  semantics (state persists per `thread_id` across `invoke` calls) instead of a
  bespoke accumulator. Driver (`runResearchLoop`) adds the AutoGen-style round cap
  + "stop when a round adds nothing" termination.

## Decision 2 — Two-call researcher for real citations
When `Citations` is requested on Gemini: do a **grounded prose** pass (returns real
`groundingChunks` source URLs) then a **non-grounded structuring** pass → JSON.

- **Why:** Gemini suppresses `groundingChunks` whenever the response contains JSON.
  Search still *informs* JSON answers (good data), but the retrievable source URLs
  only come back with prose. The reviewer keeps a single grounded JSON call — it
  needs verdicts, not URLs, and grounding still informs it.
- **Cost:** ~2 Gemini calls per research batch; paid only when the `Citations`
  column is present. Drop that column (or use Groq/MiMo) → single fast call.
- **Limitation:** citations are batch-level (one source list per round), not per-row.

## Files
- `lib/agents.ts` — the LangGraph workflow + `runResearchLoop` driver
- `lib/llm.ts` — `callModel` (grounded flag) + `researchBuildings` + `reviewBuildings`
- `app/api/generate/route.ts` — `verify` mode + round trace
