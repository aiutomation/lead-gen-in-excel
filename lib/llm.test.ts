import { describe, expect, it } from "vitest";
import { parseJsonLoose, asArray } from "./llm";

// Regression tests for the production crash: a reviewer model echoed its own
// prompt template `{"index": <n>, "status": ...}` — invalid JSON — and the raw
// `SyntaxError: Unexpected token '<'` escaped parseJsonLoose and 500'd the request.
describe("parseJsonLoose", () => {
  it("parses clean JSON", () => {
    expect(parseJsonLoose('{"rows":[{"a":"1"}]}')).toEqual({ rows: [{ a: "1" }] });
  });

  it("strips ```json fences", () => {
    expect(parseJsonLoose('```json\n[{"a":"1"}]\n```')).toEqual([{ a: "1" }]);
  });

  it("extracts the widest array span from surrounding prose", () => {
    expect(parseJsonLoose('Here you go: [{"a":"1"}] hope that helps')).toEqual([{ a: "1" }]);
  });

  it("throws the FRIENDLY error (never a raw SyntaxError) when the model echoes the template", () => {
    // The exact shape that crashed prod — `<n>` / bare `n` is not valid JSON.
    const echoed = '{ "index": <n>, "status": "verified", "note": "<short reason>" }';
    expect(() => parseJsonLoose(echoed)).toThrow("Model did not return parseable JSON");
  });

  it("throws the friendly error on total garbage", () => {
    expect(() => parseJsonLoose("not json at all")).toThrow("Model did not return parseable JSON");
  });
});

describe("asArray", () => {
  it("unwraps {rows|buildings|verdicts} and passes arrays through", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ rows: [1] })).toEqual([1]);
    expect(asArray({ verdicts: [{ index: 0 }] })).toEqual([{ index: 0 }]);
    expect(asArray({ nothing: true })).toEqual([]);
  });
});
