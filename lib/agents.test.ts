import { describe, expect, it } from "vitest";
import { computeAgentOverlap } from "./agents";
import type { Row } from "./llm";

const COLUMNS = ["Building", "Address"];

// computeAgentOverlap turns raw per-agent provenance + the dedup merges + fact-check
// statuses into the matrix the UI renders. These tests pin the parts that are easy to
// get subtly wrong: alias roll-up, failed-agent columns, and the solo-verified tally
// (the stat that proves or kills the "do we need N agents?" question).
describe("computeAgentOverlap", () => {
  // 3 agents. Agent 2 failed entirely. Agent 0 found KLCC + Pavilion; agent 1 found
  // "Suria KLCC" (an alias of KLCC, folded by dedup) + a Wisma the fact-check rejected.
  const keyToAgents = new Map<string, Set<number>>([
    ["klcc", new Set([0])],
    ["suria klcc", new Set([1])], // alias of KLCC — different key, must roll up via merges
    ["pavilion kl", new Set([0])],
    ["wisma x", new Set([1])],
  ]);

  const deduped: Row[] = [
    { Building: "KLCC", Address: "Jln Ampang" }, // [0] canonical, Suria KLCC folded in
    { Building: "Pavilion KL", Address: "Bukit Bintang" }, // [1] solo agent 0
    { Building: "Wisma X", Address: "N/A" }, // [2] solo agent 1, rejected by fact-check
  ];

  const merges = [{ kept: "KLCC", dropped: ["Suria KLCC"] }];
  const statuses: ("verified" | "flagged" | "dropped")[] = ["verified", "verified", "dropped"];

  const overlap = computeAgentOverlap({
    keyToAgents,
    agentLabels: ["gemini-flash", "llama-70b", "gpt-oss"],
    agentFound: [2, 2, 0],
    agentFailed: [false, false, true],
    deduped,
    merges,
    statuses,
    columns: COLUMNS,
  });

  it("rolls a folded alias's agents up into the canonical building (copies count overlap)", () => {
    const klcc = overlap.buildings.find((b) => b.building === "KLCC")!;
    // agent 0 found "KLCC", agent 1 found the alias "Suria KLCC" → both credited.
    expect(klcc.agents).toEqual([0, 1]);
    expect(klcc.agents.length).toBe(2); // Copies column
  });

  it("keeps one column per agent, including failed agents", () => {
    expect(overlap.agents).toBe(3);
    const dead = overlap.stats[2];
    expect(dead.failed).toBe(true);
    expect(dead.found).toBe(0);
    expect(dead.contributed).toBe(0);
    expect(dead.uniqueVerified).toBe(0);
  });

  it("counts solo-verified as buildings ONLY that agent found that survived fact-check", () => {
    // Agent 0's solo find (Pavilion) is verified → counts. KLCC is shared → doesn't.
    expect(overlap.stats[0].uniqueVerified).toBe(1);
    // Agent 1's only solo find (Wisma X) was dropped by fact-check → does NOT count.
    expect(overlap.stats[1].uniqueVerified).toBe(0);
  });

  it("tallies contribution (shared or solo) per agent", () => {
    expect(overlap.stats[0].contributed).toBe(2); // KLCC + Pavilion
    expect(overlap.stats[1].contributed).toBe(2); // KLCC (via alias) + Wisma
  });

  it("marks a fact-check reject as dropped in the matrix", () => {
    const wisma = overlap.buildings.find((b) => b.building === "Wisma X")!;
    expect(wisma.status).toBe("dropped");
    expect(wisma.agents).toEqual([1]);
  });
});
