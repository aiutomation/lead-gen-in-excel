import { afterEach, describe, expect, it, vi } from "vitest";
import {
  tavilySearch,
  firecrawlScrape,
  hasTavily,
  hasFirecrawl,
  hasWebSearch,
  hitsToContext,
} from "./search";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The contract that keeps the app working without search keys: every search call
// must degrade to an empty result, never throw and never block a generation run.
describe("graceful degradation without keys", () => {
  it("tavilySearch returns [] when TAVILY_API_KEY is unset", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(await tavilySearch("anything")).toEqual([]);
  });

  it("firecrawlScrape returns null when FIRECRAWL_API_KEY is unset", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    expect(await firecrawlScrape("https://example.com")).toBeNull();
  });

  it("tavilySearch returns [] on a non-ok response", async () => {
    vi.stubEnv("TAVILY_API_KEY", "key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await tavilySearch("q")).toEqual([]);
  });

  it("tavilySearch returns [] when fetch throws", async () => {
    vi.stubEnv("TAVILY_API_KEY", "key");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await tavilySearch("q")).toEqual([]);
  });
});

describe("hasTavily / hasFirecrawl / hasWebSearch", () => {
  it("reflect which keys are present", () => {
    vi.stubEnv("TAVILY_API_KEY", "key");
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    expect(hasTavily()).toBe(true);
    expect(hasFirecrawl()).toBe(false);
    expect(hasWebSearch()).toBe(true); // Tavily alone is enough
  });

  it("hasWebSearch is false when neither key is set", () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    expect(hasWebSearch()).toBe(false);
  });
});

describe("tavilySearch parsing", () => {
  it("maps results into {title,url,content} hits", async () => {
    vi.stubEnv("TAVILY_API_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: [{ title: "Tower A", url: "https://a.com", content: "20 storeys" }],
        }),
      }))
    );
    expect(await tavilySearch("towers")).toEqual([
      { title: "Tower A", url: "https://a.com", content: "20 storeys" },
    ]);
  });
});

describe("firecrawlScrape truncation", () => {
  it("truncates returned markdown to maxChars", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { markdown: "x".repeat(5000) } }) }))
    );
    const md = await firecrawlScrape("https://example.com", { maxChars: 100 });
    expect(md).toHaveLength(100);
  });
});

describe("hitsToContext", () => {
  it("returns empty string for no hits", () => {
    expect(hitsToContext([])).toBe("");
  });
  it("renders title, url and content per hit", () => {
    const out = hitsToContext([{ title: "T", url: "https://u", content: "C" }]);
    expect(out).toContain("[1] T");
    expect(out).toContain("https://u");
    expect(out).toContain("C");
  });
});
