import { describe, it, expect } from "vitest";

// End-to-end: hits a RUNNING server's /api/generate and asserts real, normalized
// rows come back — exercising the whole stack (route → auth gate → provider
// registry → live LLM → Tavily web search → parseJsonLoose → normalizeRow).
//
// Deliberately EXCLUDED from the default unit suite and the prebuild gate: it needs
// a live server, a real API key, and free-tier quota, so it must never block a build.
// Run explicitly:
//   npm run test:e2e                                  # targets the deployed app
//   E2E_BASE_URL=http://localhost:3000 npm run test:e2e
//   E2E_PROVIDER=gemini E2E_MODEL=gemini-flash-lite-latest npm run test:e2e
const BASE = process.env.E2E_BASE_URL ?? "https://lead-gen-in-excel.onrender.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "Sales123@";
// Groq is the free provider that actually works end-to-end (Gemini's free tier is
// quota-capped for grounded generation on new accounts). Override to test others.
const PROVIDER = process.env.E2E_PROVIDER ?? "groq";
const MODEL = process.env.E2E_MODEL ?? "llama-3.3-70b-versatile";
const COLUMNS = ["Building", "Address"];

const post = (body: unknown) =>
  fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe(`rows generation E2E → ${BASE} (${PROVIDER})`, () => {
  // The research + parse round-trip against a real LLM can take a while — plus the
  // free Render instance may cold-start. 120s ceiling (also set in the e2e config).
  it(
    "generates normalized rows for a real prompt",
    async () => {
      const res = await post({
        password: PASSWORD,
        provider: PROVIDER,
        model: MODEL,
        prompt: "large shopping malls in Kuala Lumpur",
        columns: COLUMNS,
        count: 3,
      });
      const data = (await res.json()) as { rows?: Record<string, string>[]; error?: string };
      // Surface the server's error message in the assertion if it failed.
      expect(data.error ?? null, `server error: ${data.error}`).toBeNull();
      expect(res.status).toBe(200);
      expect(Array.isArray(data.rows)).toBe(true);
      expect(data.rows!.length).toBeGreaterThan(0);
      // normalizeRow guarantees EXACTLY the requested columns, every value a string
      // ("N/A" when unknown — never undefined/null). This is the core row contract.
      for (const row of data.rows!) {
        expect(Object.keys(row).sort()).toEqual([...COLUMNS].sort());
        for (const col of COLUMNS) expect(typeof row[col]).toBe("string");
      }
    },
    120_000
  );

  // Guard cases — deterministic, no LLM call (rejected before generation), so they
  // prove the API contract without burning quota.
  it("rejects a wrong password with 401", async () => {
    const res = await post({ password: "wrong", provider: PROVIDER, prompt: "x", columns: COLUMNS });
    expect(res.status).toBe(401);
  });

  it("rejects an empty prompt with 400", async () => {
    const res = await post({ password: PASSWORD, provider: PROVIDER, prompt: "  ", columns: COLUMNS });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown provider with 400", async () => {
    const res = await post({ password: PASSWORD, provider: "bogus", prompt: "x", columns: COLUMNS });
    expect(res.status).toBe(400);
  });
});
