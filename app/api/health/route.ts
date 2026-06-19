// Liveness probe for Render's health check AND the uptime cron ping.
// Kept deliberately trivial so the keep-alive request is near-free; force-dynamic
// stops Next from serving a cached static response (the ping must hit the server
// to actually prevent the free instance from spinning down).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
