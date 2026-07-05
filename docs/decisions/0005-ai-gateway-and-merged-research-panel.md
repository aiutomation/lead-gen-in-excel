# ADR 0005 — Vercel AI Gateway for premium official models + merged Research panel

**Date:** 2026-06-30
**Status:** Accepted
**Builds on:** ADR 0004 (selectable per-agent model registry)

## Context
Two asks: (1) the AI SDK layer should offer *a lot* of providers including the
**premium official** flagships (Claude, GPT, Gemini Pro, Grok, Mistral); (2) **merge**
the separate model-panel section into the Research-agent panel — one cohesive card.

## Decision 1 — Add the Vercel AI Gateway as the premium-breadth provider
Rather than install `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/mistral` + … (a
package + key per provider), register the **Vercel AI Gateway** (`ai-gateway.vercel.sh/v1`)
as one OpenAI-compatible entry. One key (`AI_GATEWAY_API_KEY`) → hundreds of premium
official models behind `creator/model` ids (`anthropic/claude-…`, `openai/gpt-…`, etc.).

- **Why the gateway won:** it's Vercel's own product for exactly this; one key unlocks every
  premium provider; **zero new dependencies** (OpenAI-compatible); and `resolveModel`
  already splits on the first `:` so `gateway:anthropic/claude-sonnet-4` parses cleanly.
- Also added **Mistral** direct (official, OpenAI-compatible, no dep) for a direct-key option.
- **Anthropic still has no dedicated dep** (user declined it earlier) — Claude is reachable
  via the gateway. Direct `@ai-sdk/anthropic` remains a one-line future add if wanted.
- Registry is now 9 providers; `cap` per provider keeps big catalogs (gateway 30, OpenRouter
  24) from flooding the picker.

## Decision 2 — Merge the model panel into the Research card
`MultiModelResearch` (a component mirroring `AgentPicker`) replaces the single research
provider/model picker when Multi-model is on — the Research card itself shows one dropdown
per agent, with the distinct-count and "add key" hints inline. The standalone section below
the run controls was deleted.

- **Why:** research configuration now lives in one place; the card reads as part of the same
  panel as Review. Off → the classic single Research picker returns.

## Verification
- 36 tests (incl. gateway `creator/model` id parsing) · `tsc` clean · production build green.
- Live: home 200 with the merged panel; `/api/models` → 9 providers (3 keyed, 6 "add key").

## Files
- `lib/ai-models.ts` — `+ gateway, + mistral`; per-provider `cap`
- `app/page.tsx` — `MultiModelResearch` component; conditional Research card; standalone section removed
- `.env.example` — `AI_GATEWAY_API_KEY`, `MISTRAL_API_KEY`
- `lib/ai-models.test.ts` — gateway id-parsing test; status length ≥ 9
