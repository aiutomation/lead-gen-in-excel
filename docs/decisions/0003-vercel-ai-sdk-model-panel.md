# ADR 0003 — Vercel AI SDK model panel (different model per agent)

**Date:** 2026-06-29
**Status:** Accepted
**Builds on:** ADR 0002 (the multi-agent fan-out)

## Context
Client follow-up: the concurrent research agents should each run a **different model**
so their strengths complement, then dedup + fact-check the combined pile. The chosen
vehicle was the **Vercel AI SDK** (`ai` v7 + `@ai-sdk/*`).

## Decision 1 — Additive AI SDK layer, not a rewrite
Added `lib/ai-models.ts` (model pool + `researchWithModel` via `generateObject`). The
existing `callModel` (llm.ts) is untouched and still powers dedup/fact-check/enrich and
the single-model path. A `modelPanel` flag flips the fan-out to one-model-per-agent.

- **Alternative:** replace `callModel` entirely with the AI SDK (unify on one abstraction).
- **Why additive won:** smaller, reversible diff; doesn't risk the working Gemini
  grounding/citations path. Two abstractions coexist — acceptable given the AI SDK is
  scoped to the fan-out only.
- **Challenger note:** `callModel` already speaks to 3 providers, so "different model per
  agent" was achievable with zero deps by rotating providers. The SDK was added because
  the user asked for it and it opens a clean path to many more models (Anthropic/OpenAI/xAI)
  behind one `generateObject` interface.

## Decision 2 — Pool built from existing keys; OpenAI-compatible covers Groq + MiMo
`buildModelPool()` adds an entry per configured key: Gemini (`@ai-sdk/google`),
Llama-3.3-70B (Groq) and MiMo — the last two via a single `@ai-sdk/openai-compatible`
dep (both expose OpenAI `/chat/completions`), so no separate `@ai-sdk/groq`. Agents
round-robin the pool (`pickModelForAgent`), so 5 agents over 3 models still spread.

## Decision 3 — Pin column names in the Zod schema (bug found in live smoke test)
`generateObject` first used `z.record(z.string(), z.string())` — permissive. Live test:
6 raw rows → deduped to 1 → 0 kept. Cause: with no key names in the schema, models
returned their own keys, `normalizeRow` read `Building` as `"N/A"` for every row, and the
exact-key dedup collapsed them. **Fix:** `buildSchema(columns)` pins the exact column
names as optional string keys, forcing the model to emit them. Re-test: 6 → 5 unique →
5 kept (Petronas Twin Towers, Hilton KL, …). Lesson: structured-output schemas must carry
the field names, not just the prompt.

## Decision 4 — Uniform Tavily grounding (not native per-model grounding)
Every AI-SDK agent injects Tavily web context (reusing `lib/search.ts`) rather than
per-provider native grounding. Keeps one code path and means "every agent has web search"
regardless of model. Native Gemini Google-grounding remains on the non-panel path.

## Files
- `lib/ai-models.ts` *(new)* — `buildModelPool`, `pickModelForAgent`, `researchWithModel`
- `lib/agents.ts` — `runMultiAgentResearch` gains `modelPanel`; per-agent model assignment + `trace.models`
- `app/api/generate/route.ts` — accepts `modelPanel`
- `app/page.tsx` — "Multi-model" toggle + models-used badge
- `lib/ai-models.test.ts` *(new)* — pool gating + round-robin assignment
- Deps: `ai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `zod`
