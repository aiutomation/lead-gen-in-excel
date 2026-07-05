import {
  entrypoint,
  task,
  getPreviousState,
  MemorySaver,
} from "@langchain/langgraph";
import { researchBuildings, reviewBuildings, dedupeBuildings, type Row, type LlmRun } from "./llm";
import { findPersonInCharge } from "./enrich";
import {
  buildModelPool,
  pickModelForAgent,
  researchWithModel,
  resolveModel,
  completeWithModel,
} from "./ai-models";
import type { ProviderId } from "./providers";
import type { ToolEvent } from "./search";

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
// (Legacy loop path — unwraps to just rows; tool events are only surfaced by the
// current multi-agent pipeline in runMultiAgentResearch.)
const researchTask = task(
  "research",
  async (args: LoopInput & { exclude: string[]; count: number }) =>
    (await researchBuildings(args.provider, args.model, args.brief, args.columns, args.count, args.exclude)).rows
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

// ═════════════════════════════════════════════════════════════════════════
// MULTI-AGENT MODE — fan-out → funnel (the client's new requirements).
//
//   N research agents (concurrent, same brief, diversified)
//        └──► merge ──► dedup agent (#1) ──► fact-check agent (#2) ──► enrich
//
// Topology differs from runResearchLoop above (which is ONE researcher looped):
// here the researchers run in PARALLEL and the two review agents are SEQUENTIAL
// gates the combined pile flows through once.
// ═════════════════════════════════════════════════════════════════════════

// Column names the LinkedIn enrichment writes into (only when present in `columns`).
export const PIC_NAME_COL = "Person In Charge";
export const PIC_LINK_COL = "PIC LinkedIn";

// Neutral per-agent angles: tilt each researcher toward a different slice of the
// SAME brief so the union is diverse enough to be worth deduping — WITHOUT changing
// what the brief asks for.
const ANGLES = [
  "",
  "Favour less-obvious / smaller candidates and outer sub-districts others may miss.",
  "Favour the largest, highest-profile candidates first.",
  "Favour newer or recently-renovated candidates.",
  "Favour older, established candidates likely on legacy central plant.",
];

export type MultiAgentInput = {
  provider: ProviderId;
  model: string;
  reviewProvider?: ProviderId; // dedup + fact-check agent (defaults to research)
  reviewModel?: string;
  reviewModelId?: string; // AI-SDK "provider:model" for review (unified registry); wins over reviewProvider/Model
  brief: string;
  columns: string[];
  target: number;
  agents: number; // how many research agents run concurrently (1..5)
  reviewInstructions?: string;
  enrich?: boolean; // run the LinkedIn person-in-charge lookup on kept rows
  modelPanel?: boolean; // run each agent on a DIFFERENT model via the Vercel AI SDK
  agentModels?: string[]; // explicit per-agent model ids ("provider:model"); index = agent
};

export type MultiAgentTrace = {
  agents: number;
  rawTotal: number; // candidates summed across all agents
  afterDedup: number; // unique buildings after the dedup agent
  removedDup: number; // duplicates folded away
  kept: number; // passed fact-check
  dropped: number; // rejected by fact-check
  enriched: number; // rows that got a named person-in-charge
  models: string[]; // distinct models the fan-out ran on (model-panel mode)
};

// ── Overlap matrix ─────────────────────────────────────────────────────────
// Per-run provenance so the UI can show which agent found which building, how
// much the agents overlapped, and each agent's REAL marginal value.
export type AgentOverlapStat = {
  index: number; // 0-based agent number (column order in the matrix)
  label: string; // model label for this agent's column
  found: number; // raw candidates this agent returned (0 if it failed)
  failed: boolean; // agent rejected in the fan-out (quota/timeout/bad model)
  contributed: number; // post-dedup buildings this agent found (alone or shared)
  uniqueVerified: number; // buildings ONLY this agent found that survived fact-check
};
export type OverlapBuilding = {
  building: string; // canonical (post-dedup) building name
  agents: number[]; // agent indices that found it, incl. via folded aliases
  status: "verified" | "flagged" | "dropped"; // fact-check outcome
};
export type AgentOverlap = {
  agents: number;
  stats: AgentOverlapStat[];
  buildings: OverlapBuilding[];
};

export type MultiAgentResult = {
  rows: Row[];
  before: Row[]; // ALL raw candidates (pre-dedup) — the "before" snapshot
  dropped: DroppedRow[];
  merges: { kept: string; dropped: string[] }[];
  overlap: AgentOverlap; // per-agent provenance matrix (see AgentOverlap)
  toolLog: ToolEvent[]; // observable web-search / scrape / enrichment calls this run
  trace: MultiAgentTrace;
};

// Pure roll-up (no LLM/network) so the overlap logic is unit-testable. Maps each
// post-dedup building to the agents that found it — folding alias provenance in
// via `merges` — and tallies per-agent contribution + solo-verified value.
export function computeAgentOverlap(p: {
  keyToAgents: Map<string, Set<number>>; // buildingKey -> agent indices (from RAW rows)
  agentLabels: string[];
  agentFound: number[];
  agentFailed: boolean[];
  deduped: Row[]; // unique buildings after dedup
  merges: { kept: string; dropped: string[] }[]; // kept/dropped by NAME
  statuses: ("verified" | "flagged" | "dropped")[]; // per deduped index
  columns: string[];
}): AgentOverlap {
  const norm = (s: string) => s.trim().toLowerCase(); // same normalization as buildingKey
  // kept-name-key -> its dropped alias name-keys (so we can union their agents in).
  const aliasesByKept = new Map<string, string[]>();
  for (const m of p.merges) {
    aliasesByKept.set(norm(m.kept), m.dropped.map(norm));
  }

  const buildings: OverlapBuilding[] = p.deduped.map((row, i) => {
    const key = buildingKey(row, p.columns);
    const set = new Set<number>(p.keyToAgents.get(key) ?? []);
    for (const alias of aliasesByKept.get(key) ?? []) {
      for (const a of p.keyToAgents.get(alias) ?? []) set.add(a);
    }
    return {
      building: row["Building"] ?? row[p.columns[0]] ?? "—",
      agents: [...set].sort((a, b) => a - b),
      status: p.statuses[i] ?? "verified",
    };
  });

  const stats: AgentOverlapStat[] = p.agentLabels.map((label, i) => ({
    index: i,
    label,
    found: p.agentFound[i] ?? 0,
    failed: p.agentFailed[i] ?? false,
    contributed: buildings.filter((b) => b.agents.includes(i)).length,
    uniqueVerified: buildings.filter(
      (b) => b.status !== "dropped" && b.agents.length === 1 && b.agents[0] === i
    ).length,
  }));

  return { agents: p.agentLabels.length, stats, buildings };
}

// Run async `fn` over `items` with at most `limit` in flight — keeps LinkedIn
// enrichment from firing dozens of search calls at once (quota + politeness).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runMultiAgentResearch(input: MultiAgentInput): Promise<MultiAgentResult> {
  const agents = Math.min(Math.max(input.agents || 1, 1), 5);
  const reviewProvider = input.reviewProvider ?? input.provider;
  const reviewModel = input.reviewModel ?? input.model;

  // Each agent over-fetches a little so the deduped union still clears the target.
  const perAgent = Math.min(Math.max(Math.ceil((input.target * 1.5) / agents), 6), 25);

  // Model-panel mode: each agent runs a DIFFERENT model (Vercel AI SDK) so their
  // strengths complement. Per-agent picks (input.agentModels) win; otherwise we
  // cycle the keyed pool. Falls back to the single-model path if neither resolves.
  const pool = input.modelPanel ? buildModelPool() : [];
  const usePanel =
    input.modelPanel === true && (pool.length > 0 || (input.agentModels?.some(Boolean) ?? false));
  const modelsUsed: string[] = [];
  // Per-agent model label, indexed by agent i. Distinct from `modelsUsed`/`models`
  // (which are de-duped for the summary badge) — the overlap matrix needs a label
  // for EVERY column, so agentLabels[i] must stay aligned to agent i even when two
  // agents share a model.
  const agentLabels: string[] = [];

  // Resolve agent i's model: explicit pick first, then pool round-robin, else null.
  const modelForAgent = (i: number) => {
    const explicit = input.agentModels?.[i];
    return (explicit ? resolveModel(explicit) : null) ?? (pool.length ? pickModelForAgent(pool, i) : null);
  };

  // ── Stage 1: fan out N research agents CONCURRENTLY (same brief, diversified).
  // allSettled so one agent failing (quota/timeout) doesn't sink the whole run.
  const settled = await Promise.allSettled(
    Array.from({ length: agents }, (_, i) => {
      const temperature = 0.3 + i * 0.12; // 0.30, 0.42, 0.54, … → diverse sampling
      const diversify = ANGLES[i % ANGLES.length];
      const entry = usePanel ? modelForAgent(i) : null;
      agentLabels[i] = entry?.label ?? input.model; // column label for the overlap matrix
      if (entry) {
        modelsUsed.push(entry.label);
        return researchWithModel(entry, input.brief, input.columns, perAgent, { temperature, diversify });
      }
      return researchBuildings(input.provider, input.model, input.brief, input.columns, perAgent, [], {
        temperature,
        diversify,
      });
    })
  );
  const models = modelsUsed.length ? [...new Set(modelsUsed)] : [input.model];
  // Surface why any agent dropped (quota, bad model id, schema fail) — otherwise
  // allSettled hides it and the run silently returns fewer/zero rows.
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      const e = s.reason as { message?: string; name?: string; responseBody?: string; cause?: unknown };
      const detail = e?.responseBody ?? (e?.cause as { message?: string })?.message ?? "";
      console.warn(
        `[research agent ${i}] failed: ${e?.name ?? ""} ${e?.message ?? String(s.reason)} ${detail ? "| " + String(detail).slice(0, 400) : ""}`
      );
    }
  });
  // Observable tool calls for the whole run (surfaced to the UI). Research events
  // come back from each agent; enrichment events are added later.
  const toolLog: ToolEvent[] = [];

  // Per-agent provenance for the overlap matrix — MUST be built from the RAW rows
  // here, before the exact-key dedup below drops cross-agent duplicates (which would
  // otherwise erase which agents converged on the same building).
  const keyToAgents = new Map<string, Set<number>>();
  const agentFound: number[] = [];
  const agentFailed: boolean[] = [];
  settled.forEach((s, i) => {
    agentFailed[i] = s.status !== "fulfilled";
    agentFound[i] = s.status === "fulfilled" ? s.value.rows.length : 0;
    if (s.status !== "fulfilled") return;
    // Stamp this agent's index onto its research tool events, then log them.
    for (const e of s.value.events) toolLog.push({ ...e, agent: i });
    for (const row of s.value.rows) {
      const k = buildingKey(row, input.columns);
      if (!k) continue;
      let set = keyToAgents.get(k);
      if (!set) keyToAgents.set(k, (set = new Set<number>()));
      set.add(i);
    }
  });

  const rawCandidates = settled
    .filter((s): s is PromiseFulfilledResult<{ rows: Row[]; events: ToolEvent[] }> => s.status === "fulfilled")
    .flatMap((s) => s.value.rows);

  // Route dedup/review/enrichment through the AI-SDK model the user picked for the
  // review agent (unified registry). Falls back to the legacy callModel path when no
  // AI-SDK id resolves (reviewRun stays undefined → dedupe/reviewBuildings use it).
  const reviewEntry = input.reviewModelId ? resolveModel(input.reviewModelId) : null;
  const reviewRun: LlmRun | undefined = reviewEntry
    ? (system, user) => completeWithModel(reviewEntry, system, user)
    : undefined;

  if (rawCandidates.length === 0) {
    return {
      rows: [],
      before: [],
      dropped: [],
      merges: [],
      // Still report per-agent stats so "all agents failed" is visible in the matrix.
      overlap: computeAgentOverlap({
        keyToAgents,
        agentLabels,
        agentFound,
        agentFailed,
        deduped: [],
        merges: [],
        statuses: [],
        columns: input.columns,
      }),
      toolLog,
      trace: { agents, rawTotal: 0, afterDedup: 0, removedDup: 0, kept: 0, dropped: 0, enriched: 0, models },
    };
  }

  // Cheap exact-key dedup FIRST (free) so the LLM dedup agent only judges what's left.
  const seenKey = new Set<string>();
  const preDeduped = rawCandidates.filter((r) => {
    const k = buildingKey(r, input.columns);
    if (!k || seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });

  // ── Stage 2: dedup agent (#1) — fuzzy/alias dedup the exact-match misses.
  const { rows: deduped, removed, merges } = await dedupeBuildings(
    reviewProvider,
    reviewModel,
    preDeduped,
    input.columns,
    reviewRun
  );

  // ── Stage 3: fact-check agent (#2) — verify/flag/reject each unique building.
  const verdicts = await reviewBuildings(
    reviewProvider,
    reviewModel,
    input.brief,
    deduped,
    input.columns,
    input.reviewInstructions ?? "",
    reviewRun
  );
  const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]));
  const kept: Row[] = [];
  const droppedRows: DroppedRow[] = [];
  // Fact-check outcome per deduped building (index-aligned) — feeds the overlap matrix.
  const statuses: ("verified" | "flagged" | "dropped")[] = [];
  deduped.forEach((row, i) => {
    const v = verdictByIndex.get(i);
    if (v?.status === "reject") {
      statuses[i] = "dropped";
      droppedRows.push({ row, note: v.note || "Could not be verified." });
      return;
    }
    const status = v?.status === "flagged" ? "flagged" : "verified";
    const merged: Row = { ...row, ...(v?.corrections ?? {}) };
    merged.__status = status;
    merged.__note = v?.note ?? "";
    statuses[i] = status;
    kept.push(merged);
  });

  // Trim to target BEFORE the (expensive) enrichment so we only enrich what ships.
  const finalRows = kept.slice(0, input.target);

  // ── Stage 4 (optional): LinkedIn person-in-charge enrichment.
  let enriched = 0;
  const wantsEnrich =
    input.enrich && (input.columns.includes(PIC_NAME_COL) || input.columns.includes(PIC_LINK_COL));
  if (wantsEnrich) {
    await mapLimit(finalRows, 3, async (row) => {
      const { person: pic, events } = await findPersonInCharge(
        reviewProvider,
        reviewModel,
        row["Building"] ?? row[input.columns[0]] ?? "",
        row["Address"] ?? "",
        reviewRun
      );
      for (const e of events) toolLog.push(e); // surface the LinkedIn/web enrichment calls
      if (input.columns.includes(PIC_NAME_COL)) {
        row[PIC_NAME_COL] = pic.name === "N/A" ? "N/A" : `${pic.name}${pic.role !== "N/A" ? ` — ${pic.role}` : ""}`;
      }
      if (input.columns.includes(PIC_LINK_COL)) row[PIC_LINK_COL] = pic.linkedin;
      if (pic.name !== "N/A") enriched++;
    });
  }

  return {
    rows: finalRows,
    before: rawCandidates,
    dropped: droppedRows,
    merges,
    overlap: computeAgentOverlap({
      keyToAgents,
      agentLabels,
      agentFound,
      agentFailed,
      deduped,
      merges,
      statuses,
      columns: input.columns,
    }),
    toolLog,
    trace: {
      agents,
      rawTotal: rawCandidates.length,
      afterDedup: deduped.length,
      removedDup: removed + (rawCandidates.length - preDeduped.length),
      kept: kept.length,
      dropped: droppedRows.length,
      enriched,
      models,
    },
  };
}
