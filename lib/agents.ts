import {
  entrypoint,
  task,
  getPreviousState,
  MemorySaver,
} from "@langchain/langgraph";
import { researchBuildings, reviewBuildings, type Row } from "./llm";
import type { ProviderId } from "./providers";

// ─────────────────────────────────────────────────────────────────────────
// Multi-agent verification loop — TypeScript port of multiagent_langgraph_autogen.py.
//
//   Python reference            →  here
//   ─────────────────────────────────────────────────────────────────────
//   @task call_autogen_agent    →  researchTask / reviewTask
//   @entrypoint(checkpointer=…)  →  workflow (one research+review ROUND)
//   MemorySaver()                →  checkpointer (accumulates verified rows per thread)
//   getPreviousState / previous  →  prior round's verified rows + seen names
//   entrypoint.final(value,save) →  return this round + persist merged state
//   max_consecutive_auto_reply   →  maxRounds cap in runResearchLoop (driver)
//   is_termination_msg TERMINATE →  stop when target met OR a round adds nothing
// ─────────────────────────────────────────────────────────────────────────

// A row the reviewer rejected, with the reason it was cut.
export type DroppedRow = { row: Row; note: string };

// What the loop carries forward between rounds (the "memory").
export type LeadState = {
  verified: Row[]; // kept rows (verified + flagged), with __status/__note attached
  seen: string[]; // building names already found, so research asks for fresh ones
  rounds: RoundLog[]; // per-round trace for the UI
  initial: Row[]; // the RAW first-pass research output (before any review) — the "before"
  dropped: DroppedRow[]; // rows the reviewer rejected, with reasons
};

export type RoundLog = {
  round: number;
  found: number; // candidates researched this round
  kept: number; // passed review (verified or flagged)
  dropped: number; // rejected by reviewer
};

export type LoopInput = {
  provider: ProviderId; // RESEARCH agent's provider
  model: string; // RESEARCH agent's model
  reviewProvider?: ProviderId; // REVIEW agent's provider (falls back to research)
  reviewModel?: string; // REVIEW agent's model (falls back to research)
  brief: string;
  columns: string[];
  target: number; // how many verified rows we want in total
  reviewInstructions?: string; // optional user rules steering the review agent
};

const buildingKey = (r: Row, columns: string[]) =>
  (r["Building"] ?? r[columns[0]] ?? "").trim().toLowerCase();

// @task — Agent #1: research a batch of fresh candidates.
const researchTask = task(
  "research",
  async (args: LoopInput & { exclude: string[]; count: number }) =>
    researchBuildings(args.provider, args.model, args.brief, args.columns, args.count, args.exclude)
);

// @task — Agent #2: fact-check those candidates.
const reviewTask = task(
  "review",
  async (args: {
    provider: ProviderId;
    model: string;
    brief: string;
    rows: Row[];
    columns: string[];
    instructions: string;
  }) =>
    reviewBuildings(args.provider, args.model, args.brief, args.rows, args.columns, args.instructions)
);

const checkpointer = new MemorySaver();

// @entrypoint — ONE round: research the gap, review it, merge into memory.
const workflow = entrypoint(
  { name: "leadResearchLoop", checkpointer },
  async (input: LoopInput) => {
    const previous =
      getPreviousState<LeadState>() ?? { verified: [], seen: [], rounds: [], initial: [], dropped: [] };
    const need = input.target - previous.verified.length;

    // Termination (TERMINATE-equivalent): nothing left to find.
    if (need <= 0) return entrypoint.final({ value: previous, save: previous });

    // Over-fetch a little so rejections still leave us near target.
    const candidates = await researchTask({
      ...input,
      exclude: previous.seen,
      count: Math.min(need + 3, 30),
    });
    const verdicts = await reviewTask({
      // The review agent can run on a DIFFERENT provider/model than research
      // (e.g. research on grounded Gemini, fact-check on a stricter model).
      provider: input.reviewProvider ?? input.provider,
      model: input.reviewModel ?? input.model,
      brief: input.brief,
      rows: candidates,
      columns: input.columns,
      instructions: input.reviewInstructions ?? "",
    });

    const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]));
    const seenSet = new Set(previous.seen);
    const kept: Row[] = [];
    const droppedThisRound: DroppedRow[] = [];

    candidates.forEach((row, i) => {
      const v = verdictByIndex.get(i);
      const key = buildingKey(row, input.columns);
      if (!key || seenSet.has(key)) return; // dedupe across rounds
      if (v?.status === "reject") {
        droppedThisRound.push({ row, note: v.note || "Could not be verified." });
        seenSet.add(key); // remember it so we don't re-fetch the same dud
        return;
      }
      // verified or flagged → keep, applying any reviewer corrections + status tag.
      const merged: Row = { ...row, ...(v?.corrections ?? {}) };
      merged.__status = v?.status === "flagged" ? "flagged" : "verified";
      merged.__note = v?.note ?? "";
      kept.push(merged);
      seenSet.add(key);
    });

    const next: LeadState = {
      verified: [...previous.verified, ...kept],
      seen: [...seenSet],
      rounds: [
        ...previous.rounds,
        { round: previous.rounds.length + 1, found: candidates.length, kept: kept.length, dropped: droppedThisRound.length },
      ],
      // "before" snapshot = the very first round's raw candidates (model output, unreviewed).
      initial: previous.initial.length ? previous.initial : candidates,
      dropped: [...previous.dropped, ...droppedThisRound],
    };
    return entrypoint.final({ value: next, save: next });
  }
);

// Driver — calls the entrypoint repeatedly on ONE thread_id so the checkpointer
// carries verified rows forward, until target met or a round stalls (no progress)
// or we hit the round cap. This is the AutoGen `max_consecutive_auto_reply` guard.
export async function runResearchLoop(
  input: LoopInput,
  maxRounds = 3
): Promise<{ rows: Row[]; rounds: RoundLog[]; initial: Row[]; dropped: DroppedRow[] }> {
  const thread_id = crypto.randomUUID();
  const config = { configurable: { thread_id } };

  let state: LeadState = { verified: [], seen: [], rounds: [], initial: [], dropped: [] };
  for (let i = 0; i < maxRounds; i++) {
    const prevKept = state.verified.length;
    state = await workflow.invoke(input, config);
    if (state.verified.length >= input.target) break; // target reached
    if (state.verified.length === prevKept) break; // round added nothing → stop
  }
  return {
    rows: state.verified.slice(0, input.target),
    rounds: state.rounds,
    initial: state.initial,
    dropped: state.dropped,
  };
}
