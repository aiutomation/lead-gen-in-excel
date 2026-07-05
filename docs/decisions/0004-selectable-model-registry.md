# ADR 0004 — Selectable per-agent models via an extensible provider registry

**Date:** 2026-06-30
**Status:** Accepted
**Builds on:** ADR 0003 (the Vercel AI SDK model panel)

## Context
ADR 0003 auto-cycled a fixed 3-model pool. Two gaps surfaced:
1. **No model was selectable** — the user couldn't choose which model each agent runs.
2. **Only 3 models existed**, so "5 distinct research agents" was impossible. The user
   wanted to add API keys *afterward* and have new providers' models appear.

## Decision 1 — A provider REGISTRY gated by env keys
`lib/ai-models.ts` replaced the hardcoded 3-provider `buildModelPool` with a `PROVIDERS[]`
registry: Gemini, Groq, MiMo (existing) + **OpenAI, xAI/Grok, DeepSeek, OpenRouter**. A
provider appears only when its key is present, so adding `OPENAI_API_KEY` later just lights
it up — no code change.

- **Anthropic skipped** (user didn't pick it) → **no new dependency**: every new provider is
  OpenAI-compatible and reuses `@ai-sdk/openai-compatible`. Only Gemini uses its own SDK.
- **OpenRouter** is the highest-leverage entry: one key → hundreds of (often cheap) models.

## Decision 2 — Live model listing, curated fallback
`listAiModels()` fetches each keyed provider's `/models` endpoint (real ids, never stale),
filters non-chat models, puts curated ids first, and caps per provider (12) so big catalogs
(OpenRouter) don't flood the picker. Falls back to curated ids on any failure.

- **Why live:** hardcoding model ids (gpt-5? grok-4?) goes stale fast; the provider knows
  its own current models. Verified live: 3 keyed providers → **28 selectable models**.

## Decision 3 — `provider:model` ids; split on the FIRST colon
Model ids are `"<provider>:<model>"`. `resolveModel` splits on the first `:` only, so
OpenRouter ids like `openrouter:google/gemini-2.0-flash-exp:free` keep their inner `:free`.

## Decision 4 — Explicit per-agent picks, distinct by default
`runMultiAgentResearch` takes `agentModels: string[]` (index = agent). The UI renders one
dropdown per agent (`/api/models` feeds it), auto-defaulting each slot to a **distinct**
model and showing "add `X_API_KEY`" for unkeyed providers. Explicit pick → pool round-robin
→ single-model fallback. Verified live: 3 explicit distinct models each ran on their agent.

## Files
- `lib/ai-models.ts` — `PROVIDERS` registry, `listAiModels`, `aiProviderStatus`, `resolveModel`
- `app/api/models/route.ts` *(new)* — selectable models + provider status
- `lib/agents.ts` — `runMultiAgentResearch` gains `agentModels`; per-agent resolution
- `app/api/generate/route.ts` — accepts `agentModels`
- `app/page.tsx` — per-agent model dropdowns + "add key" hints
- `.env.example` — `OPENAI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`
- `lib/ai-models.test.ts` — registry gating, id parsing, resolution (10 tests)
