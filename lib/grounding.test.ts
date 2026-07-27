import { describe, expect, it } from "vitest";
import { applyGrounding, applyDedupGroups, type Row } from "./llm";

// Build a Row with a string[] Citations. The Row type is an intersection, so Citations
// must be set by assignment (not an inline literal) — same as normalizeRow does.
function mkRow(fields: Record<string, string>, citations: string[]): Row {
  const r: Row = { ...fields };
  r.Citations = citations;
  return r;
}

// The grounding gate is the execution-phase rule: a value survives only if it traces
// to a source URL the search actually returned. These tests pin the three ways it can
// act — reject, blank-a-field, and union-on-merge — so a regression can't quietly let
// ungrounded data through.
describe("applyGrounding", () => {
  const COLUMNS = ["Job Site", "Founded", "Area (ft2)", "Citations"];

  it("drops a row whose citations are all hallucinated (not in the returned URL set)", () => {
    const items = [{ row: mkRow({ "Job Site": "Ghost Mall" }, ["https://made-up.example/x"]), ungrounded: [] }];
    const { kept, dropped } = applyGrounding(items, ["https://real.example/1"], COLUMNS);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].note).toMatch(/rejected/i);
  });

  it("keeps a partly-grounded row: blanks the _ungrounded field, drops invented URLs", () => {
    const items = [
      {
        row: mkRow(
          { "Job Site": "Real Mall", Founded: "1990", "Area (ft2)": "500000" },
          ["https://real.example/1", "https://made-up.example/x"]
        ),
        ungrounded: ["Area (ft2)"], // model admitted it couldn't source the size
      },
    ];
    const { kept } = applyGrounding(items, ["https://real.example/1"], COLUMNS);
    expect(kept).toHaveLength(1);
    expect(kept[0].Founded).toBe("1990"); // grounded fact survives
    expect(kept[0]["Area (ft2)"]).toBe("N/A"); // ungrounded field blanked
    expect(kept[0].Citations).toEqual(["https://real.example/1"]); // fake URL stripped
  });
});

describe("applyDedupGroups citations union", () => {
  it("unions every duplicate's citation URLs into the merged row", () => {
    const COLUMNS = ["Job Site", "Address", "Citations"];
    const rows: Row[] = [
      mkRow({ "Job Site": "KLCC", Address: "N/A" }, ["https://a.example"]),
      mkRow({ "Job Site": "Suria KLCC", Address: "Jln Ampang" }, ["https://b.example"]),
    ];
    const { rows: out } = applyDedupGroups(rows, [[0, 1]], COLUMNS);
    expect(out).toHaveLength(1);
    expect(new Set(out[0].Citations)).toEqual(new Set(["https://a.example", "https://b.example"]));
  });
});
