import { NextResponse } from "next/server";
import { checkPassword } from "@/lib/auth";
import { researchBuildings } from "@/lib/llm";
import { runMultiAgentResearch } from "@/lib/agents";
import { PROVIDERS, defaultModel, resolveProviderId, type ProviderId } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 300; // fan-out + dedup + fact-check + enrich can run a while

export async function POST(req: Request) {
  let body: {
    password?: string;
    provider?: string;
    model?: string;
    reviewProvider?: string;
    reviewModel?: string;
    reviewModelId?: string; // AI-SDK "provider:model" for the review agent (unified registry)
    prompt?: string;
    columns?: string[];
    count?: number;
    verify?: boolean;
    agents?: number; // 1..5 concurrent research agents (verify path)
    enrich?: boolean; // run LinkedIn person-in-charge enrichment
    modelPanel?: boolean; // each agent on a different model (Vercel AI SDK)
    agentModels?: string[]; // explicit per-agent model ids ("provider:model")
    reviewInstructions?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Password gate — guards the LLM keys even if someone bypasses the UI.
  if (!checkPassword(body.password)) {
    return NextResponse.json({ error: "Unauthorized — wrong password" }, { status: 401 });
  }
  if (!body.provider || !(body.provider in PROVIDERS)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return NextResponse.json({ error: "At least one column is required" }, { status: 400 });
  }

  const provider = body.provider as ProviderId;
  const model = body.model?.trim() || defaultModel(provider); // fall back to provider default
  // Review agent gets its OWN provider/model; default to the research pair if the
  // UI didn't send one (or sent an unknown provider).
  const reviewProvider = resolveProviderId(body.reviewProvider, provider);
  const reviewModel = body.reviewModel?.trim() || defaultModel(reviewProvider);
  const count = Math.min(Math.max(Number(body.count) || 15, 1), 50); // clamp 1..50

  try {
    if (body.verify) {
      // Multi-agent path: N concurrent researchers → dedup agent → fact-check agent → enrich.
      const agents = Math.min(Math.max(Number(body.agents) || 1, 1), 5);
      const { rows, before, dropped, merges, overlap, toolLog, trace } = await runMultiAgentResearch({
        provider,
        model,
        reviewProvider,
        reviewModel,
        reviewModelId: body.reviewModelId?.trim() || undefined,
        brief: body.prompt,
        columns: body.columns,
        target: count,
        agents,
        enrich: !!body.enrich,
        modelPanel: !!body.modelPanel,
        agentModels: Array.isArray(body.agentModels) ? body.agentModels : undefined,
        reviewInstructions: body.reviewInstructions,
      });
      // `before` = all raw candidates (pre-dedup); `rows` = final; `dropped` = fact-check rejects;
      // `overlap` = per-agent provenance matrix; `toolLog` = observable web/enrichment calls.
      return NextResponse.json({ rows, before, dropped, merges, overlap, toolLog, trace });
    }
    // Fast path — single research pass, no review loop.
    const { rows } = await researchBuildings(provider, model, body.prompt, body.columns, count);
    return NextResponse.json({ rows });
  } catch (e) {
    let message = e instanceof Error ? e.message : "Generation failed";
    // Provider errors arrive as nested JSON — surface just the human-readable message.
    const m = message.match(/"message"\s*:\s*"([^"]+)"/);
    if (m) message = m[1];
    if (/quota|limit:\s*0/i.test(message)) {
      message = `${model}: free-tier quota exceeded — switch provider (Groq's llama-3.3-70b-versatile is free and works) or add billing to this key.`;
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
