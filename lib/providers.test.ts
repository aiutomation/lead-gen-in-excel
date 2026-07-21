import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDERS,
  defaultModel,
  resolveProviderId,
  enabledProviders,
  listModels,
} from "./providers";

// Each test stubs env / fetch; undo it afterwards so tests stay independent.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("defaultModel", () => {
  it("returns the first curated model for each provider", () => {
    expect(defaultModel("gemini")).toBe("gemini-flash-lite-latest");
    expect(defaultModel("groq")).toBe("llama-3.3-70b-versatile");
    expect(defaultModel("mimo")).toBe("mimo-v2.5-pro");
  });
});

// The core of the dual-agent change: the review agent's provider defaults to the
// research agent's provider unless the UI sent a valid, known override.
describe("resolveProviderId (review agent fallback)", () => {
  it("keeps a valid candidate provider", () => {
    expect(resolveProviderId("groq", "gemini")).toBe("groq");
  });
  it("falls back to research provider when the candidate is undefined", () => {
    expect(resolveProviderId(undefined, "gemini")).toBe("gemini");
  });
  it("falls back when the candidate is an empty string", () => {
    expect(resolveProviderId("", "mimo")).toBe("mimo");
  });
  it("falls back when the candidate is an unknown provider", () => {
    expect(resolveProviderId("openai", "gemini")).toBe("gemini");
  });
});

describe("enabledProviders", () => {
  it("returns only providers whose API key env var is set", () => {
    vi.stubEnv("GEMINI_API_KEY", "present");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("MIMO_API_KEY", "");
    expect(enabledProviders()).toEqual(["gemini"]);
  });

  it("includes mimo only when MIMO_API_KEY is present", () => {
    vi.stubEnv("GEMINI_API_KEY", "present");
    vi.stubEnv("GROQ_API_KEY", "present");
    vi.stubEnv("MIMO_API_KEY", "present");
    expect([...enabledProviders()].sort()).toEqual(["gemini", "groq", "mimo"]);
  });
});

describe("listModels", () => {
  it("returns the curated list when no API key is set", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    expect(await listModels("groq")).toEqual(PROVIDERS.groq.models);
  });

  it("puts curated models first, strips the 'models/' prefix, and drops non-text models", async () => {
    vi.stubEnv("GEMINI_API_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { id: "models/text-embedding-004" }, // dropped — embedding
            { id: "models/gemini-flash-latest" }, // curated → preferred (2nd in curated order)
            { id: "models/imagen-3.0" }, // dropped — image model
            { id: "models/gemini-9.9-ultra" }, // extra gemini → appended, sorted
            { id: "models/gemini-flash-lite-latest" }, // curated → preferred (first)
            { id: "models/aqa" }, // dropped — aqa
          ],
        }),
      }))
    );

    const models = await listModels("gemini");

    // Curated-present models come first, in curated order (reliable UI default).
    expect(models[0]).toBe("gemini-flash-lite-latest");
    expect(models[1]).toBe("gemini-flash-latest");
    // Extra live model is retained (prefix stripped).
    expect(models).toContain("gemini-9.9-ultra");
    // Non-text models are filtered out.
    expect(models).not.toContain("text-embedding-004");
    expect(models).not.toContain("imagen-3.0");
    expect(models).not.toContain("aqa");
  });

  it("falls back to the curated list when the fetch throws", async () => {
    vi.stubEnv("GROQ_API_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    expect(await listModels("groq")).toEqual(PROVIDERS.groq.models);
  });

  it("falls back to the curated list on a non-ok response", async () => {
    vi.stubEnv("MIMO_API_KEY", "key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    expect(await listModels("mimo")).toEqual(PROVIDERS.mimo.models);
  });
});
