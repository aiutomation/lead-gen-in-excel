# 0008 — Free-text JSON over Gemini structured output for wide column sets

- **Date:** 2026-07-05
- **Status:** accepted
- **Repo/area:** Lead Gen in Excel / `lib/ai-models.ts` (`researchWithModel`)

## Context

The multi-model research path (`researchWithModel`) used `generateObject` with a
Zod schema that pinned every column name as an object key (`buildSchema`). For
Gemini, the AI SDK compiles that into a `responseSchema`, and Gemini's
constraint-based decoder rejected the default **24-column** set:
*"The specified schema produces a constraint that has too many states for
serving"* — driven by the many long property names. The whole multi-agent run
500'd. The classic `researchBuildings` path (`callModel` + `parseJsonLoose`)
never hit this because it passes columns in the prompt as free JSON, not a
structured schema.

## Options considered

1. **Unify on text + `parseJsonLoose`** — drop `generateObject` for research; use
   `generateText` + the proven tolerant-parse path. One provider-agnostic path.
2. **Loosen the schema** (`z.record`) — ~2 lines, but re-opens the key-drift bug
   `buildSchema` was created to fix (models invent keys → rows collapse to N/A).
3. **Chunk/cap the schema** — pin only ~8 core columns; heuristic that rots.
4. **Provider-conditional** — strict schema for tolerant providers, text path for
   Gemini; two paths to maintain, "tolerates it" is a moving target.

## Decision

Chose **Option 1 (unify on text + `parseJsonLoose`)**. `researchWithModel` now
calls `generateText` and parses with the exported `parseJsonLoose` + `asArray`
from `lib/llm.ts`; column keys are pinned in the prompt (as they already were).
`buildSchema` and the `generateObject`/`zod` imports are deleted.

## Consequences

- **Easier:** one research code path instead of two; fixes Gemini *and* any future
  provider with structured-output caps; reuses the battle-tested parser.
- **Harder / debt:** lose the AI SDK's schema-validated auto-retry — correctness now
  rests on `parseJsonLoose` tolerance (already relied on in production by the
  classic path) + prompt-pinned keys.
- **Verified:** the exact 24-column, 3-agent run that previously 500'd now returns
  `rawTotal 14 → afterDedup 10 → kept 6`, with the Gemini agent succeeding
  (`found: 6, failed: false`). tsc clean, 45/45 tests pass.
- **Principle learned:** converge divergent paths (DRY) — when two code paths solve
  the same problem and one is proven robust, delete the fragile one rather than
  patching it; prefer tolerant parsing over provider-specific structured output when
  the input shape is user-controlled and unbounded.
