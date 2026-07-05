# ADR 0006 — Default model trio, Groq json_object fix, gateway caveat

**Date:** 2026-06-30
**Status:** Accepted
**Builds on:** ADR 0005 (gateway + merged panel)

## Context
Goal: default to 3 distinct models (one Gemini, one Groq-Llama, one GPT), distinct
**by sequence** unless the user picks, then verify a full run — 5 research + 1 review +
enrich — with models, tool calls, and enrichment all succeeding.

## Decision 1 — Multi-model ON by default, with a working "default trio"
`modelPanel` now defaults **true** and `agents` defaults **3**, so the out-of-box
experience is 3 distinct models. The default sequence is a curated, *runnable* trio:
`gemini-2.5-flash` · `groq:llama-3.3-70b-versatile` · `groq:openai/gpt-oss-120b`.

- **Why gpt-oss (Groq) and not gateway gpt-4o:** the goal's "one gpt" must actually run.
  The Vercel AI Gateway key currently **401s** (no Gateway access) *and* the gateway rejects
  `response_format`, so `gateway:openai/gpt-4o` can't run. `gpt-oss-120b` is a real OpenAI
  model hosted on the (free, working) Groq key. For premium `gpt-4o`, add a direct
  `OPENAI_API_KEY` (accepts `json_schema` natively) or fix the gateway credential.
- The default-assignment effect fills extra agents (4–5) with the next distinct models and
  preserves any manual pick.

## Decision 2 — Fix: Groq was silently failing on object generation
The AI SDK sends `response_format: {type:"json_object"}` for OpenAI-compatible providers,
and **Groq rejects that mode unless the prompt contains the word "json"** — the research
prompt didn't, so every Groq agent failed and the run was carried by Gemini/MiMo alone.
Fix: the prompt now says `Return … as a JSON object {"rows":[…]}`. All Groq-hosted models
(GPT-OSS, Llama-4, Qwen) now produce.

## Decision 3 — Permissive row schema (z.any) + coerce
Some models return non-strings (e.g. `"Citations":[1]`), which a strict `z.string()` schema
rejected with `NoObjectGeneratedError`, dropping that agent. Columns are now `z.any()` and
`normalizeRow` coerces to string — no agent lost to a type mismatch.

## Decision 4 — Surface agent failures
`runMultiAgentResearch` now `console.warn`s each rejected research agent (name + message +
API responseBody). `allSettled` previously hid these, so a run could silently return fewer
rows with no signal.

## Verification (full run, 5 research + 1 review + enrich)
- `rawTotal: 29` (≈6/agent → all 5 agents produced), 5 distinct models incl. a GPT.
- Review dedup 29→8, fact-check kept 7 / dropped 1 → 5 rows.
- **Tool calls:** citations 5/5 (Tavily ran per row). **Enrich:** named PICs + LinkedIn URLs,
  conservative N/A otherwise.
- `tsc` clean · 36 tests · production build green.

## Files
- `app/page.tsx` — `modelPanel` default true; curated default-trio assignment
- `lib/ai-models.ts` — "json" in prompt; `z.any()` schema; registry order (OpenAI 3rd);
  gateway curated gpt-4o first
- `lib/agents.ts` — per-agent rejection logging

## Known caveat
Gemini free-tier quota drains under heavy testing (2.5-pro hit quota this session); Groq is
the reliable workhorse. Environmental, recovers over time.
