# 0009 — Rich review-model registry + observable tool-event log

- **Date:** 2026-07-05
- **Status:** accepted
- **Repo/area:** Lead Gen in Excel / `lib/*` + `app/page.tsx`

## Context

Two gaps: (1) the review agent (and dedup + LinkedIn enrichment) ran on the legacy
3-provider `callModel` path (`lib/providers.ts`), so its picker offered far fewer
models than research's rich AI-SDK registry (`lib/ai-models.ts`); (2) the pipeline
gave no visibility into the web-search / LinkedIn / enrichment tool calls, so a user
couldn't tell whether Tavily/Firecrawl actually ran or whether LinkedIn was searched.

## Options considered

**Review models:**
1. **Unify onto the AI-SDK registry** — route review/dedup/enrich through the same
   `generateText` backend research uses; review picker shows all keyed providers.
2. Expand the legacy `providers.ts` registry — smaller change but duplicates the
   model registry (two lists to keep in sync).

**Tool-call capture:**
1. **Return events from the leaf fns** — `researchWithModel`/`researchBuildings`/
   `findPersonInCharge` return their tool events with their data; orchestrator
   aggregates. Explicit, unit-testable, no globals.
2. Recorder sink threaded into `search.ts` — touches the shared low-level layer.
3. AsyncLocalStorage request-scoped logger — zero signature churn but implicit flow.

## Decision

Chose **unify onto the AI-SDK registry** and **return events from the leaf fns**.

- `ToolEvent` type lives in `lib/search.ts` (the neutral leaf layer). Leaf fns build
  their own events (they know the query + get the hits); `runMultiAgentResearch`
  stamps the agent index on research events and aggregates into `toolLog`.
- Review path uses **dependency injection** to avoid a cycle: `reviewBuildings` /
  `dedupeBuildings` / `findPersonInCharge` take an optional `LlmRun` callback
  (defined in `llm.ts`); the orchestrator builds it from `completeWithModel(entry)`
  (`ai-models.ts`) and passes it. When absent they fall back to legacy `callModel`.
- UI: the review picker is now `AiModelPicker` over the AI-SDK model list (104
  models in this env, up from 3); a new `ToolActivity` panel renders the log grouped
  by stage/agent with query, hit count, evidence URLs, and enrichment outcome.

## Consequences

- **Easier:** review can pick any keyed model; one text-completion backend shared by
  research + review + dedup + enrich; the run is now observable end-to-end.
- **Harder / debt accepted:** review's fact-check grounding moved from Gemini-native
  Google-Search to the shared Tavily layer (how research already works); more Gemini
  concurrency can rate-limit (mitigated by picking a Groq review model).
- **Verified:** a live run produced `toolLog` of 17 calls (3 research web-searches +
  6 enrichment Tavily incl. LinkedIn + 3 Firecrawl + 3 extractions), review routed to
  `groq:llama`, and the UI rendered the matrix + tool-activity panel
  (`docs/screenshots/tool-activity-and-overlap.png`). tsc clean, 45/45 tests pass.
- **Principle learned:** inject a callback to swap a dependency across a module
  boundary without creating an import cycle; make side-effecting tools *return* their
  observations (explicit data flow) rather than logging to a global.
