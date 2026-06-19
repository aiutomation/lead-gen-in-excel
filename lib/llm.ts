import { GoogleGenAI } from "@google/genai";
import { PROVIDERS, type ProviderId } from "./providers";

export type Row = Record<string, string>;

// One reviewer verdict per candidate building.
export type Verdict = {
  index: number; // position in the array that was reviewed
  status: "verified" | "flagged" | "reject";
  note: string; // why — shown to the user / appended to the row
  corrections?: Record<string, string>; // column -> corrected value
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (e: unknown) => {
  const s = String(e);
  // Hard caps (free-tier quota / billing) won't recover in seconds — don't retry.
  if (/quota|billing|limit:\s*0/i.test(s)) return false;
  return /\b(429|503|UNAVAILABLE|overloaded|high demand|rate.?limit)\b/i.test(s);
};

// ---------------------------------------------------------------- low-level
// The single primitive every agent calls. Gemini goes through the @google/genai
// SDK with Google-Search grounding (and returns source URLs); Groq/MiMo go
// through the OpenAI-compatible /chat/completions endpoint.
// Retries transient 503/429 errors a few times — LLM endpoints are flaky under load.
export async function callModel(
  provider: ProviderId,
  model: string,
  system: string,
  user: string,
  grounded = true
): Promise<{ text: string; sources: string[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(800 * attempt); // 0ms, 800ms, 1600ms backoff
    try {
      return await callModelOnce(provider, model, system, user, grounded);
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e; // only retry transient failures
    }
  }
  throw lastErr;
}

async function callModelOnce(
  provider: ProviderId,
  model: string,
  system: string,
  user: string,
  grounded: boolean
): Promise<{ text: string; sources: string[] }> {
  const cfg = PROVIDERS[provider];
  if (!process.env[cfg.env]) {
    throw new Error(`${cfg.label} is not configured (missing ${cfg.env})`);
  }

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model,
      contents: `${system}\n\n${user}`,
      // Only attach the Google-Search tool when grounding is wanted. Note: a JSON
      // response suppresses source chunks, so grounded prose is used to fetch URLs.
      config: grounded ? { tools: [{ googleSearch: {} }] } : {},
    });
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = chunks
      .map((c) => c.web?.uri)
      .filter((u): u is string => !!u)
      .slice(0, 8);
    return { text: response.text ?? "", sources };
  }

  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env[cfg.env]}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    throw new Error(`${cfg.label} API error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return { text: data.choices?.[0]?.message?.content ?? "", sources: [] };
}

// ---------------------------------------------------------------- JSON parsing
// Models sometimes wrap JSON in ```fences``` or add stray prose. Pull the
// first array/object out robustly.
function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall back to the widest [ ... ] or { ... } span
    const a = cleaned.indexOf("[");
    const b = cleaned.lastIndexOf("]");
    if (a !== -1 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    const c = cleaned.indexOf("{");
    const d = cleaned.lastIndexOf("}");
    if (c !== -1 && d > c) return JSON.parse(cleaned.slice(c, d + 1));
    throw new Error("Model did not return parseable JSON");
  }
}

function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  return (obj?.rows as unknown[]) ?? (obj?.buildings as unknown[]) ?? (obj?.verdicts as unknown[]) ?? [];
}

// Force every cell to a string keyed by the requested columns; missing -> "N/A".
function normalizeRow(obj: unknown, columns: string[]): Row {
  const rec = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const row: Row = {};
  for (const col of columns) {
    const v = rec[col];
    row[col] = v === undefined || v === null || v === "" ? "N/A" : String(v);
  }
  return row;
}

// ---------------------------------------------------------------- RESEARCHER
// Agent #1 — finds candidate buildings (web-grounded on Gemini). `exclude` lets
// later rounds ask for buildings NOT already found, so the loop makes progress.
export async function researchBuildings(
  provider: ProviderId,
  model: string,
  brief: string,
  columns: string[],
  count: number,
  exclude: string[] = []
): Promise<Row[]> {
  const excludeLine = exclude.length
    ? `Do NOT include any of these already-found buildings: ${JSON.stringify(exclude)}.`
    : "";

  // When the user wants Citations from Gemini, do a grounded PROSE pass first to
  // capture real source URLs (a JSON response would return none), then structure
  // it into rows with a cheap non-grounded pass. Otherwise: one JSON call.
  const wantCitations = provider === "gemini" && columns.includes("Citations");

  if (wantCitations) {
    const research = await callModel(
      provider,
      model,
      "You are a building/facility prospecting researcher for a chilled-water (HVAC) sales team. " +
        "Use web search to find REAL, named buildings — never invent placeholders.",
      [
        `Task: ${brief}`,
        excludeLine,
        `Find up to ${count} buildings. For EACH, write a short paragraph with its name, address, ` +
          "type, storeys, and anything about its air-conditioning / chiller system. Cite as you go.",
      ]
        .filter(Boolean)
        .join("\n"),
      true // grounded prose -> real source URLs in `sources`
    );

    const structured = await callModel(
      provider,
      model,
      "You convert research notes into a strict JSON table. Do not add buildings not in the notes.",
      [
        "Research notes:",
        research.text,
        "",
        `Convert into up to ${count} objects in a JSON array. Each object MUST have EXACTLY these keys:`,
        JSON.stringify(columns),
        '- Every value is a string. Use "N/A" when the notes do not say.',
        '- Output JSON ONLY in the form {"rows": [ ... ]}.',
      ].join("\n"),
      false // structuring only — no search needed, and keeps it fast
    );

    const rows = asArray(parseJsonLoose(structured.text)).map((o) => normalizeRow(o, columns));
    const joined = research.sources.length ? research.sources.join(" | ") : "N/A";
    for (const r of rows) r.Citations = joined; // batch-level real source URLs
    return rows;
  }

  // Lean single-call path (no Citations wanted, or non-Gemini provider).
  const { text } = await callModel(
    provider,
    model,
    "You are a building/facility prospecting researcher for a chilled-water (HVAC) sales team. " +
      "Find REAL, named buildings — never invent placeholders.",
    [
      `Task: ${brief}`,
      "",
      `Return up to ${count} buildings as a JSON array of objects.`,
      "Each object MUST have EXACTLY these keys (verbatim spelling):",
      JSON.stringify(columns),
      excludeLine,
      "Rules:",
      '- Every value is a string. Use "N/A" when a fact is unknown.',
      "- Prefer large buildings/facilities likely to run a central chilled-water system.",
      '- Do not invent precise figures; prefix uncertain numbers with "~".',
      '- Output JSON ONLY in the form {"rows": [ ... ]}. No prose, no markdown fences.',
    ]
      .filter(Boolean)
      .join("\n")
  );
  return asArray(parseJsonLoose(text)).map((o) => normalizeRow(o, columns));
}

// ---------------------------------------------------------------- REVIEWER
// Agent #2 — re-checks each candidate against the web and votes keep/flag/drop.
export async function reviewBuildings(
  provider: ProviderId,
  model: string,
  brief: string,
  rows: Row[],
  columns: string[],
  instructions = "" // optional user-authored rules that steer the reviewer
): Promise<Verdict[]> {
  const system =
    "You are a fact-checking reviewer for a sales-prospecting table. " +
    "Use web search to verify each building actually exists, matches the brief " +
    "(large building / facility on a central chilled-water system), and that its key facts are plausible.";
  const compact = rows.map((r, i) => ({
    index: i,
    Building: r["Building"] ?? r[columns[0]] ?? "",
    Address: r["Address"] ?? "",
  }));
  const user = [
    `Brief: ${brief}`,
    // User-authored reviewer rules take priority when deciding keep/flag/reject.
    instructions.trim()
      ? `\nReviewer instructions (apply these strictly when judging):\n${instructions.trim()}\n`
      : "",
    "Review these candidate buildings:",
    JSON.stringify(compact),
    "",
    "For EACH index return a verdict object:",
    '{ "index": <n>, "status": "verified" | "flagged" | "reject", "note": "<short reason>", "corrections": { "<column>": "<fixed value>" } }',
    "- verified: real and matches the brief (and the reviewer instructions, if any).",
    "- flagged: probably real but a fact looks wrong/uncertain — keep it, explain in note.",
    "- reject: not real, not found, or fails the brief / reviewer instructions — it will be dropped.",
    "- corrections is optional; include only columns you can confidently fix.",
    '- Output JSON ONLY in the form {"verdicts": [ ... ]}. No prose.',
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await callModel(provider, model, system, user);
  return asArray(parseJsonLoose(text))
    .map((v) => v as Record<string, unknown>)
    .filter((v) => typeof v.index === "number")
    .map((v) => ({
      index: v.index as number,
      status:
        v.status === "verified" || v.status === "reject" ? v.status : "flagged",
      note: typeof v.note === "string" ? v.note : "",
      corrections:
        v.corrections && typeof v.corrections === "object"
          ? (v.corrections as Record<string, string>)
          : undefined,
    }));
}
