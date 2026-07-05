import { describe, expect, it } from "vitest";
import { applyDedupGroups, type Row } from "./llm";

const COLUMNS = ["Building", "Address", "Storeys"];

// The dedup AGENT decides the grouping (semantic, LLM); applyDedupGroups does the
// mechanical merge. These tests pin the merge so a grouping bug can't silently
// drop or mangle data.
describe("applyDedupGroups", () => {
  const rows: Row[] = [
    { Building: "KLCC", Address: "N/A", Storeys: "88" }, // [0]
    { Building: "Suria KLCC", Address: "Jln Ampang", Storeys: "N/A" }, // [1] — same building, complementary facts
    { Building: "Menara Maxis", Address: "KLCC", Storeys: "49" }, // [2] — unique
  ];

  it("merges a group, keeping the most-complete row and back-filling N/A cells", () => {
    const { rows: out, removed, merges } = applyDedupGroups(rows, [[0, 1], [2]], COLUMNS);
    expect(out).toHaveLength(2);
    expect(removed).toBe(1);
    // Row 0 ("KLCC") and row 1 have the same completeness (2 real cells each); the
    // reduce keeps the first as canonical, then back-fills its N/A Address from row 1.
    const klcc = out.find((r) => r.Building === "KLCC")!;
    expect(klcc.Address).toBe("Jln Ampang"); // back-filled from the duplicate
    expect(klcc.Storeys).toBe("88"); // kept from canonical
    expect(merges).toEqual([{ kept: "KLCC", dropped: ["Suria KLCC"] }]);
  });

  it("treats indices the agent forgot as their own singleton building", () => {
    // Only mention index 0; 1 and 2 are forgotten → each becomes its own group.
    const { rows: out, removed } = applyDedupGroups(rows, [[0]], COLUMNS);
    expect(out).toHaveLength(3);
    expect(removed).toBe(0);
  });

  it("ignores out-of-range and repeated indices", () => {
    const { rows: out } = applyDedupGroups(rows, [[0, 1, 99], [1, 2]], COLUMNS);
    // 99 ignored; index 1 already assigned in the first group, so the second group
    // collapses to just [2]. Result: {0,1} merged + {2} = 2 rows.
    expect(out).toHaveLength(2);
  });

  it("is a no-op shape for all-unique groups", () => {
    const { rows: out, removed, merges } = applyDedupGroups(rows, [[0], [1], [2]], COLUMNS);
    expect(out).toHaveLength(3);
    expect(removed).toBe(0);
    expect(merges).toEqual([]);
  });
});
