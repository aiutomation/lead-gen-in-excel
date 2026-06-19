import { NextResponse } from "next/server";
import { enabledProviders, listModels, PROVIDERS } from "@/lib/providers";

export const runtime = "nodejs";

// Tells the UI which providers have a key configured AND which models each key can
// use (fetched live from the provider's /models endpoint, with a curated fallback).
export async function GET() {
  const ids = enabledProviders();
  const providers = await Promise.all(
    ids.map(async (id) => ({
      id,
      label: PROVIDERS[id].label,
      grounded: PROVIDERS[id].grounded,
      models: await listModels(id),
    }))
  );
  return NextResponse.json({ providers });
}
