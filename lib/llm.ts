import { GoogleGenAI } from "@google/genai";
import { PROVIDERS, type ProviderId } from "./providers";
import { tavilySearch, hitsToContext, hasTavily, type ToolEvent } from "./search";
import { FEW_SHOT_EXAMPLES } from "./columns";

// Every cell is a string EXCEPT `Citations`, which is a per-row array of the real
// source URLs that grounded the row. `__status`/`__note` are review metadata.
export type Row = Record<string, string> & {
  Citations?: string[];
  __status?: string;
  __note?: string;
};

// A row rejected by the grounding gate / reviewer, with the reason. (Structurally
// identical to agents.ts DroppedRow — kept local so llm.ts has no cycle back to it.)
type GroundedDrop = { row: Row; note: string };

// The single identity/name column for a lead. The new schema's first column is the
// internal "File No." (a number), so prefer the human name "Job Site" — falling back
// to the legacy "Building" key and then columns[0] for older/custom column sets.
export const nameOf = (r: Row, columns: string[]): string =>
  r["Job Site"] ?? r["Building"] ?? r[columns[0]] ?? "—";

// An injected LLM text-completer. Lets the review/dedup/enrich functions run on a
// DIFFERENT backend (the Vercel AI-SDK model registry) without importing it — the
// orchestrator passes a closure. When omitted, they fall back to the legacy callModel
// path (Gemini/Groq/MiMo). Dependency injection = no llm.ts → ai-models.ts cycle.
export type LlmRun = (system: string, user: string, grounded?: boolean) => Promise<string>;

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
  grounded = true,
  // `temperature` lets the fan-out give each of the N research agents a different
  // sampling temperature, so "same brief" still yields DIFFERENT candidates worth
  // deduping (rather than five near-identical lists).
  temperature?: number
): Promise<{ text: string; sources: string[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(800 * attempt); // 0ms, 800ms, 1600ms backoff
    try {
      return await callModelOnce(provider, model, system, user, grounded, temperature);
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
  grounded: boolean,
  temperature?: number
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
      config: {
        ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      },
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
      temperature: temperature ?? 0.3,
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
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the widest [ ... ] or { ... } span. That slice can ALSO be
    // invalid — e.g. a model that echoed the prompt template `{"index": <n>, ...}` —
    // so guard each attempt. A raw SyntaxError must NEVER escape this function;
    // callers rely on the friendly Error below to degrade instead of 500-ing.
    const tryParse = (s: string): unknown | undefined => {
      try {
        return JSON.parse(s);
      } catch {
        return undefined; // JSON.parse never legitimately returns undefined
      }
    };
    const a = cleaned.indexOf("[");
    const b = cleaned.lastIndexOf("]");
    if (a !== -1 && b > a) {
      const r = tryParse(cleaned.slice(a, b + 1));
      if (r !== undefined) return r;
    }
    const c = cleaned.indexOf("{");
    const d = cleaned.lastIndexOf("}");
    if (c !== -1 && d > c) {
      const r = tryParse(cleaned.slice(c, d + 1));
      if (r !== undefined) return r;
    }
    throw new Error("Model did not return parseable JSON");
  }
}

export function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  return (obj?.rows as unknown[]) ?? (obj?.buildings as unknown[]) ?? (obj?.verdicts as unknown[]) ?? [];
}

// Force every cell to a string keyed by the requested columns; missing -> "N/A".
// `Citations` is the exception: it's an array of source URLs, defaulted to [] and
// filled by the grounding step — never string-coerced here.
export function normalizeRow(obj: unknown, columns: string[]): Row {
  const rec = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  const row: Row = {};
  for (const col of columns) {
    if (col === "Citations") continue; // handled as string[] by applyGrounding
    const v = rec[col];
    row[col] = v === undefined || v === null || v === "" ? "N/A" : String(v);
  }
  // Only carry a Citations array when it's actually a requested column, so the row
  // contract stays "exactly the requested columns" for schemas that don't want it.
  if (columns.includes("Citations")) row.Citations = [];
  return row;
}

// Pull the model's per-row citation URLs (structuring pass emits "Citations": [...]).
export function rawCitations(obj: unknown): string[] {
  const rec = (obj ?? {}) as Record<string, unknown>;
  return Array.isArray(rec.Citations) ? rec.Citations.map(String).filter(Boolean) : [];
}
// Pull the columns the model admitted it could not tie to a source ("_ungrounded").
export function rawUngrounded(obj: unknown): string[] {
  const rec = (obj ?? {}) as Record<string, unknown>;
  return Array.isArray(rec._ungrounded) ? rec._ungrounded.map(String) : [];
}

// ---------------------------------------------------------------- GROUNDING GATE
// The execution-phase rule: every extracted value must trace to a source URL that
// the grounded search ACTUALLY returned, or it's rejected. Pure (no I/O) so it's
// unit-testable.
//   - Blank the columns the model flagged `_ungrounded` to "N/A".
//   - Keep only citation URLs present in `validUrls` (drops any URL the model invented).
//   - A row left with zero citations has no grounded fact → dropped.
export function applyGrounding(
  items: { row: Row; ungrounded: string[] }[],
  validUrls: string[],
  columns: string[]
): { kept: Row[]; dropped: GroundedDrop[] } {
  const valid = new Set(validUrls);
  const kept: Row[] = [];
  const dropped: GroundedDrop[] = [];
  for (const { row, ungrounded } of items) {
    for (const col of ungrounded) {
      if (col !== "Citations" && columns.includes(col)) row[col] = "N/A";
    }
    const cites = (Array.isArray(row.Citations) ? row.Citations : []).filter((u) => valid.has(u));
    row.Citations = cites;
    if (cites.length === 0) dropped.push({ row, note: "No source URL returned — rejected." });
    else kept.push(row);
  }
  return { kept, dropped };
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
  exclude: string[] = [],
  // Fan-out knobs: `temperature` varies sampling per agent, `diversify` is a one-line
  // nudge so each of the N agents explores a different slant of the same brief.
  opts: { temperature?: number; diversify?: string } = {}
): Promise<{ rows: Row[]; events: ToolEvent[] }> {
  const { temperature, diversify } = opts;
  const events: ToolEvent[] = [];
  const excludeLine = exclude.length
    ? `Do NOT include any of these already-found buildings: ${JSON.stringify(exclude)}.`
    : "";
  const diversifyLine = diversify ? `Angle for THIS agent: ${diversify}` : "";

  // Give NON-grounded providers (Groq/MiMo) live web access via Tavily, so "every
  // agent has web search" — not just Gemini. Gemini keeps its native Google-Search
  // grounding below, so we skip the extra Tavily call for it.
  let webContext = "";
  if (!PROVIDERS[provider].grounded && hasTavily()) {
    const hits = await tavilySearch(brief, { maxResults: 6 });
    if (hits.length) {
      webContext =
        "Live web results (use these as grounding — prefer buildings that appear here):\n" +
        hitsToContext(hits);
    }
    events.push({
      stage: "research", tool: "tavily", label: `Web search · ${PROVIDERS[provider].label}`,
      query: brief.slice(0, 120), resultCount: hits.length,
      urls: hits.map((h) => h.url).filter(Boolean).slice(0, 5), ok: hits.length > 0,
    });
  }

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
        diversifyLine,
        excludeLine,
        `Find up to ${count} buildings. For EACH, write a short paragraph with its name, address, ` +
          "type, storeys, and anything about its air-conditioning / chiller system. " +
          "Put the source URL in parentheses right after each fact you state — do not write any " +
          "fact you cannot cite.",
      ]
        .filter(Boolean)
        .join("\n"),
      true, // grounded prose -> real source URLs in `sources`
      temperature
    );

    const structured = await callModel(
      provider,
      model,
      "You convert research notes into a strict JSON table. Do not add buildings not in the notes.",
      [
        "Research notes:",
        research.text,
        "",
        "Match this format (values only — omit fields the notes don't cover):",
        JSON.stringify(FEW_SHOT_EXAMPLES[0]),
        "",
        `Convert into up to ${count} objects in a JSON array. Each object MUST have EXACTLY these keys:`,
        JSON.stringify(columns),
        '- Every value is a string. Use "N/A" when the notes do not say.',
        '- "Citations": an array of the source URLs from the notes that support THIS building.',
        '- "_ungrounded": an array listing any of the above columns whose value has NO supporting',
        "  source in the notes (so it can be rejected). Leave [] if every value is cited.",
        '- Output JSON ONLY in the form {"rows": [ ... ]}.',
      ].join("\n"),
      false // structuring only — no search needed, and keeps it fast
    );

    const parsed = asArray(parseJsonLoose(structured.text));
    const items = parsed.map((o) => {
      const row = normalizeRow(o, columns);
      row.Citations = rawCitations(o); // model's claimed URLs; gated below
      return { row, ungrounded: rawUngrounded(o) };
    });
    // Grounding gate: keep only URLs the search actually returned; drop ungrounded rows.
    const { kept, dropped } = applyGrounding(items, research.sources, columns);
    events.push({
      stage: "research", tool: "gemini", label: `Google-Search grounding · ${model}`,
      query: brief.slice(0, 120), resultCount: research.sources.length,
      urls: research.sources.slice(0, 5), ok: research.sources.length > 0,
      detail: dropped.length ? `${dropped.length} row(s) rejected — no grounded source` : undefined,
    });
    return { rows: kept, events };
  }

  // Lean single-call path (no Citations wanted, or non-Gemini provider).
  const { text, sources } = await callModel(
    provider,
    model,
    "You are a building/facility prospecting researcher for a chilled-water (HVAC) sales team. " +
      "Find REAL, named buildings — never invent placeholders.",
    [
      `Task: ${brief}`,
      diversifyLine,
      webContext,
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
      .join("\n"),
    true,
    temperature
  );
  // Gemini's native grounding returns source URLs even without the Citations pass —
  // record them so the UI shows this agent used web grounding.
  if (PROVIDERS[provider].grounded && sources.length) {
    events.push({
      stage: "research", tool: "gemini", label: `Google-Search grounding · ${model}`,
      query: brief.slice(0, 120), resultCount: sources.length, urls: sources.slice(0, 5), ok: true,
    });
  }
  const rows = asArray(parseJsonLoose(text)).map((o) => normalizeRow(o, columns));
  return { rows, events };
}

// ---------------------------------------------------------------- REVIEWER
// Agent #2 — re-checks each candidate against the web and votes keep/flag/drop.
export async function reviewBuildings(
  provider: ProviderId,
  model: string,
  brief: string,
  rows: Row[],
  columns: string[],
  instructions = "", // optional user-authored rules that steer the reviewer
  run?: LlmRun // AI-SDK completer (unified registry); falls back to legacy callModel
): Promise<Verdict[]> {
  const system =
    "You are a fact-checking reviewer for a sales-prospecting table. " +
    "Use web search to verify each building actually exists, matches the brief " +
    "(large building / facility on a central chilled-water system), and that its key facts are plausible.";
  const compact = rows.map((r, i) => ({
    index: i,
    Building: nameOf(r, columns),
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

  const text = run ? await run(system, user, true) : (await callModel(provider, model, system, user)).text;
  // A reviewer that returns unparseable JSON (e.g. echoes the `{"index": <n>, ...}`
  // template above) must NOT crash the request. Like dedupeBuildings, degrade to
  // "no verdicts" — nothing gets rejected, so every candidate row passes through.
  let parsed: unknown[];
  try {
    parsed = asArray(parseJsonLoose(text));
  } catch {
    return [];
  }
  return parsed
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

// ---------------------------------------------------------------- DEDUP AGENT
// Review agent #1 — when N research agents run the SAME brief, the same building
// shows up under different names ("KLCC" / "Suria KLCC" / "Petronas Twin Towers").
// An exact-string key can't catch those aliases, so an LLM decides the *grouping*
// (the fuzzy, semantic part) and code does the *merge* (the mechanical part).

export type DedupResult = {
  rows: Row[]; // one row per unique building, with N/A cells back-filled from its dupes
  removed: number; // how many duplicate rows were folded away
  merges: { kept: string; dropped: string[] }[]; // for the UI trace — what merged into what
};

// How "complete" a row is = how many cells carry a real value (not N/A / empty).
// Used to pick the best row in a duplicate group as the one to keep. Citations is an
// array (evidence, not a fact cell) so it's excluded from the count.
const completeness = (r: Row, columns: string[]) =>
  columns.reduce((n, c) => n + (c !== "Citations" && r[c] && r[c] !== "N/A" ? 1 : 0), 0);

export async function dedupeBuildings(
  provider: ProviderId,
  model: string,
  rows: Row[],
  columns: string[],
  run?: LlmRun // AI-SDK completer (unified registry); falls back to legacy callModel
): Promise<DedupResult> {
  // Nothing to compare → no-op (cheap guard; also avoids a pointless LLM call).
  if (rows.length < 2) return { rows, removed: 0, merges: [] };

  const compact = rows.map((r, i) => ({
    index: i,
    Building: nameOf(r, columns),
    Address: r["Address"] ?? "",
  }));
  const system =
    "You group duplicate building listings. Two entries are the SAME building if they " +
    "are the same physical structure — even when names differ (abbreviation, alias, " +
    "brand vs legal name, language) or one address is partial. Different towers of the " +
    "same complex are SEPARATE buildings.";
  const user = [
    "Partition EVERY index below into groups; each group is one real-world building.",
    "A unique building is a group of one. Duplicates share a group.",
    JSON.stringify(compact),
    "",
    'Output JSON ONLY: {"groups": [[0,3],[1],[2,4]]} covering every index exactly once.',
  ].join("\n");

  let groups: number[][];
  try {
    const text = run ? await run(system, user, false) : (await callModel(provider, model, system, user)).text;
    const parsed = parseJsonLoose(text) as { groups?: unknown };
    const raw = Array.isArray(parsed) ? parsed : (parsed?.groups ?? []);
    groups = (raw as unknown[])
      .filter(Array.isArray)
      .map((g) =>
        (g as unknown[]).filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < rows.length
        )
      );
  } catch {
    // If the dedup agent fails, don't drop data — treat every row as unique.
    return { rows, removed: 0, merges: [] };
  }

  return applyDedupGroups(rows, groups, columns);
}

// Pure merge step (no LLM, no I/O) — given the agent's grouping, normalise coverage
// and fold each group into one row. Exported so it can be unit-tested directly.
export function applyDedupGroups(rows: Row[], groups: number[][], columns: string[]): DedupResult {
  // Defensive: ensure every index appears exactly once. Indices the model forgot
  // become their own singleton group; duplicates-within-output are ignored.
  const assigned = new Set<number>();
  const clean: number[][] = [];
  for (const g of groups) {
    const fresh = g.filter((i) => i >= 0 && i < rows.length && !assigned.has(i));
    if (fresh.length) {
      fresh.forEach((i) => assigned.add(i));
      clean.push(fresh);
    }
  }
  rows.forEach((_, i) => {
    if (!assigned.has(i)) clean.push([i]); // forgotten index → its own building
  });

  // Merge each group: keep the most-complete row, back-fill its N/A cells from mates.
  const merges: { kept: string; dropped: string[] }[] = [];
  const out: Row[] = clean.map((group) => {
    const members = group.map((i) => rows[i]);
    const canonical = members.reduce((best, r) =>
      completeness(r, columns) > completeness(best, columns) ? r : best
    );
    const merged: Row = { ...canonical };
    for (const col of columns) {
      if (col === "Citations") continue; // array — unioned below, not string-backfilled
      if (!merged[col] || merged[col] === "N/A") {
        const fill = members.find((m) => m[col] && m[col] !== "N/A");
        if (fill) merged[col] = fill[col];
      }
    }
    // Citations is evidence — union every duplicate's URLs so no source is lost on merge.
    if (columns.includes("Citations"))
      merged.Citations = [...new Set(members.flatMap((m) => m.Citations ?? []))];
    if (group.length > 1) {
      merges.push({
        kept: nameOf(canonical, columns),
        dropped: members.filter((m) => m !== canonical).map((m) => nameOf(m, columns)),
      });
    }
    return merged;
  });

  return { rows: out, removed: rows.length - out.length, merges };
}
