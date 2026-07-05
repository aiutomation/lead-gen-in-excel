import { NextResponse } from "next/server";
import { listAiModels, aiProviderStatus } from "@/lib/ai-models";

export const runtime = "nodejs";

// Powers the per-agent model picker (Multi-model mode).
//   models    — every selectable model across KEYED providers (live-listed)
//   providers — status of EVERY registered provider, so the UI can show
//               "add OPENAI_API_KEY to unlock GPT" for the ones not yet keyed.
export async function GET() {
  const [models, providers] = await Promise.all([
    listAiModels(),
    Promise.resolve(aiProviderStatus()),
  ]);
  return NextResponse.json({ models, providers });
}
