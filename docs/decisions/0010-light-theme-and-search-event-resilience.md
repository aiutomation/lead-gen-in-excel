# 0010 — Light theme toggle + resilient search-event logging

- **Date:** 2026-07-05
- **Status:** accepted
- **Repo/area:** Lead Gen in Excel / `app/*` + `lib/ai-models.ts`

## Context

Two asks: (1) add a light-background theme with clearer separation between the
numbered sections (01/02/03) — the app was dark-only (`.dark` hardcoded on `<html>`,
`next-themes` installed but unused, light `:root` was stock shadcn gray); (2) produce
a clean run screenshot with **5 non-Gemini agents** — Gemini kept hitting the free
rate limit, and Groq `gpt-oss` models intermittently return unparseable JSON, which
made a research agent throw and vanish (losing the proof it had searched the web).

## Decisions

- **Theme:** wired `next-themes` (`attribute="class"`, `defaultTheme="dark"`) via a
  small `ThemeProvider`, removed the hardcoded `dark`, added a header toggle. Designed
  a proper LIGHT "ice paper" palette in `:root` (cool white bg, deeper cyan primary
  readable on white, slate text), a theme-aware body background (soft grid on light,
  the existing blueprint glow on dark), and stronger separation: `.panel` gains a
  `shadow-sm` in light, and `01/02/03` became boxed `.section-kicker` chips.
- **Search resilience (`researchWithModel`):** the Tavily search is logged first;
  the model call + JSON parse are now wrapped so any model error / unparseable JSON
  keeps the recorded search event, notes *"search ok — model yielded no usable rows"*,
  and yields 0 rows — instead of throwing away the agent. A flaky model no longer
  erases its proof-of-search.

## Alternatives considered

- Hand-rolled theme toggle (localStorage + class) — rejected: flashes wrong theme on
  first paint; `next-themes` ships the no-flash inline script.
- Just improve dark-mode separation — rejected: the ask was explicitly a light bg.
- Leave `researchWithModel` throwing on bad JSON — rejected: it discarded the agent's
  successful web search, defeating the "prove 5 agents searched" goal.

## Consequences

- Users can switch light/dark; sections read as distinct cards in both.
- Every fan-out agent now contributes a visible search event even if its model output
  is unusable (honest: search succeeded, rows didn't).
- **Verified:** live 5-agent Groq run (no Gemini) — all 5 logged successful Tavily
  searches (6 results each), 2 gpt-oss agents noted "no usable rows", enrichment found
  a real PIC, review ran on Groq. Light theme + separation captured in
  `docs/screenshots/five-agents-light-theme.png`. tsc clean, 45/45 tests pass.
- **Principle learned:** log a side effect at the moment it succeeds, not after the
  whole operation returns — so a later failure can't erase proof the earlier step ran.
