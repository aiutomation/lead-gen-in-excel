# 0007 — Agent overlap matrix (per-run provenance)

**Date:** 2026-07-05
**Status:** Accepted

## Context

A multi-agent run (N researchers → dedup → fact-check) reported only aggregate
counts (`rawTotal → afterDedup → kept`). Users couldn't see *which* agent found
*which* building, how much the agents overlapped, or whether an extra agent added
real value — the exact doubt raised in `docs/multi-agent-overlap-and-dedup.md`
("seems like one LLM can do this, not 5"). The pipeline discarded agent
attribution at `rawCandidates = settled.flatMap(...)`, so the matrix couldn't be
built from existing data.

## Decision

Capture per-agent provenance server-side and expose an `overlap` structure on the
multi-agent response, rendered as an in-app matrix.

- **Provenance built from RAW rows** (a `key → Set<agentIndex>` map) *before* the
  exact-key dedup, which would otherwise erase cross-agent duplicates.
- **`computeAgentOverlap` is a pure, unit-tested function** (`lib/agents.ts`) — not
  client-side logic — so the roll-up (alias union via `merges`, per-agent stats) is
  the single source of truth and testable without LLM calls.
- **Headline stat is `uniqueVerified`** (buildings only that agent found that
  survived fact-check) — the number that actually proves/kills the "need N agents"
  case, not raw found-count.
- **Column labels come from a per-agent `agentLabels[]` array**, not `trace.models`
  (which is de-duped and misaligns when two agents share a model).
- **UI is a bespoke matrix** matching the existing hand-rolled results table (no
  chart lib exists; no registry component fits an agent×building grid). Post-hoc
  (after the run), not live-streamed — overlap isn't knowable until all agents
  return and dedup runs.

## Alternatives considered

- **Derive from existing `before` + `merges` (no backend change):** rejected —
  `before` is flatMapped, so agent attribution is already gone; "which agents work
  best" is unanswerable without it.
- **Tag rows and compute overlap client-side:** rejected — duplicates
  `buildingKey`/merge logic in the client and isn't unit-testable.
- **Live SSE streaming of agent progress:** rejected — large architecture change
  (current path is a single blocking POST) for no gain; the matrix is inherently a
  post-run artifact.

## Consequences

- Files: `lib/agents.ts` (provenance + `computeAgentOverlap` + types),
  `app/api/generate/route.ts` (passthrough), `app/page.tsx` (`AgentOverlapMatrix`),
  `lib/agents.test.ts` (5 tests).
- Verified end-to-end on a live 3-agent Subang Jaya run: `18 raw → 15 unique → 12
  verified`, alias roll-up credited SJMC to all 3 agents, dropped rows struck
  through.
- **Known unrelated limitation:** the default 24-column set overflows Gemini's
  structured-output schema ("too many states for serving") and 500s the run —
  pre-existing, in the LLM layer, not addressed here. Small column sets work.
