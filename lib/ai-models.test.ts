import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModelPool,
  pickModelForAgent,
  resolveModel,
  aiProviderStatus,
  curateBrandGrouped,
} from "./ai-models";

const ALL_KEYS = [
  "GEMINI_API_KEY", "GROQ_API_KEY", "MIMO_API_KEY",
  "OPENAI_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY", "AI_GATEWAY_API_KEY",
];

// Isolate from the real environment: clear every provider key, each test opts in.
beforeEach(() => {
  for (const k of ALL_KEYS) vi.stubEnv(k, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// The pool/registry is the "different model per agent" source. These pin the
// env-gating, registry order, id parsing, and round-robin — the AI SDK network
// call itself is NOT mocked (that tests the SDK, not our logic).
describe("buildModelPool", () => {
  it("includes only providers whose key is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    const pool = buildModelPool();
    expect(pool.map((m) => m.id)).toEqual(["gemini:gemini-2.5-flash"]);
    expect(pool[0].grounded).toBe(true);
  });

  it("builds keyed providers in registry order with each one's first curated model", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubEnv("MIMO_API_KEY", "k");
    expect(buildModelPool().map((m) => m.id)).toEqual([
      "gemini:gemini-2.5-flash",
      "groq:llama-3.3-70b-versatile",
      "mimo:mimo-v2.5-pro",
    ]);
  });

  it("registers newly-keyed providers too (OpenAI + xAI + DeepSeek → 4 distinct with Gemini)", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("OPENAI_API_KEY", "k");
    vi.stubEnv("XAI_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    expect(buildModelPool().map((m) => m.id)).toEqual([
      "gemini:gemini-2.5-flash",
      "openai:gpt-4o-mini",
      "xai:grok-2-latest",
      "deepseek:deepseek-chat",
    ]);
  });

  it("returns an empty pool when no keys are set", () => {
    expect(buildModelPool()).toEqual([]);
  });
});

describe("pickModelForAgent", () => {
  it("cycles the pool so agents spread across all models, then repeat", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GROQ_API_KEY", "k");
    vi.stubEnv("MIMO_API_KEY", "k");
    const pool = buildModelPool(); // length 3
    expect(pickModelForAgent(pool, 0).id).toBe("gemini:gemini-2.5-flash");
    expect(pickModelForAgent(pool, 2).id).toBe("mimo:mimo-v2.5-pro");
    expect(pickModelForAgent(pool, 3).id).toBe("gemini:gemini-2.5-flash"); // wraps
    expect(pickModelForAgent(pool, 4).id).toBe("groq:llama-3.3-70b-versatile");
  });
});

describe("resolveModel", () => {
  it("resolves a keyed provider's model id with a labelled entry", () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    const e = resolveModel("openai:gpt-4o");
    expect(e).not.toBeNull();
    expect(e!.id).toBe("openai:gpt-4o");
    expect(e!.label).toContain("gpt-4o");
    expect(e!.label).toContain("OpenAI");
  });

  it("returns null when the provider's key is missing", () => {
    expect(resolveModel("openai:gpt-4o")).toBeNull(); // OPENAI_API_KEY is stubbed empty
  });

  it("returns null for an unknown provider or a malformed id", () => {
    vi.stubEnv("GEMINI_API_KEY", "k");
    expect(resolveModel("nope:model")).toBeNull();
    expect(resolveModel("noseparator")).toBeNull();
  });

  it("keeps inner colons in the model id (OpenRouter ':free' suffix)", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    const e = resolveModel("openrouter:google/gemini-2.0-flash-exp:free");
    expect(e).not.toBeNull();
    expect(e!.id).toBe("openrouter:google/gemini-2.0-flash-exp:free");
    expect(e!.label).toContain("google/gemini-2.0-flash-exp:free");
  });

  it("parses Vercel AI Gateway 'creator/model' ids (split on first colon only)", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "k");
    const e = resolveModel("gateway:anthropic/claude-sonnet-4-6");
    expect(e).not.toBeNull();
    expect(e!.id).toBe("gateway:anthropic/claude-sonnet-4-6");
    expect(e!.label).toContain("anthropic/claude-sonnet-4-6");
    expect(e!.label).toContain("Vercel AI Gateway");
  });
});

// The gateway/OpenRouter return hundreds of "creator/model" ids; this keeps the
// picker usable — ≤5 per brand, premium brands first, recent over legacy.
describe("curateBrandGrouped", () => {
  const live = [
    "openai/gpt-4o", "openai/gpt-3.5-turbo", "openai/gpt-4-turbo", "openai/gpt-4.1-mini", "openai/gpt-4.1", "openai/o9-pro",
    "alibaba/qwen-3-14b", "alibaba/qwen-3-30b", "alibaba/qwen-3-32b", "alibaba/qwen-3-235b", "alibaba/qwen-3-72b", "alibaba/qwen-3-1b",
    "anthropic/claude-opus-4-5",
  ];
  const out = curateBrandGrouped(live, ["openai/gpt-4o"], 5);

  it("caps each brand at perBrand", () => {
    const counts = (b: string) => out.filter((id) => id.startsWith(b + "/")).length;
    expect(counts("openai")).toBe(5);
    expect(counts("alibaba")).toBe(5); // 6 Qwen variants → trimmed to 5
    expect(counts("anthropic")).toBe(1);
  });

  it("orders premium brands before others (anthropic before alibaba)", () => {
    expect(out.findIndex((id) => id.startsWith("anthropic/"))).toBeLessThan(
      out.findIndex((id) => id.startsWith("alibaba/"))
    );
  });

  it("ranks the curated flagship first within its brand", () => {
    expect(out.filter((id) => id.startsWith("openai/"))[0]).toBe("openai/gpt-4o");
  });

  it("demotes legacy models out of the kept set", () => {
    expect(out).not.toContain("openai/gpt-3.5-turbo"); // legacy → score 0 → cut from top 5
  });
});

describe("aiProviderStatus", () => {
  it("reports keyed/unkeyed for every registered provider (drives the 'add key' hints)", () => {
    vi.stubEnv("OPENAI_API_KEY", "k");
    const status = aiProviderStatus();
    expect(status.find((s) => s.id === "openai")!.keyed).toBe(true);
    expect(status.find((s) => s.id === "openai")!.envKey).toBe("OPENAI_API_KEY");
    expect(status.find((s) => s.id === "xai")!.keyed).toBe(false);
    expect(status.find((s) => s.id === "gateway")!.envKey).toBe("AI_GATEWAY_API_KEY");
    expect(status.length).toBeGreaterThanOrEqual(9); // every registered provider reported
  });
});
