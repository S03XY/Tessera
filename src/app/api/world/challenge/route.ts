import { NextResponse } from "next/server";
import { createRpContext, world, worldMode, WorldError } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a signed RP context for an IDKit request. Signing happens here so
 * the RP key stays on the server.
 *
 * In simulation mode there is no challenge to sign; the client is told so
 * explicitly rather than being handed a fabricated one.
 */
export async function GET() {
  const mode = worldMode();

  if (mode === "simulated") {
    return NextResponse.json(
      {
        mode,
        app_id: world.appId,
        action: world.action,
        message:
          "Simulation mode: no RP context is issued. Set WORLD_RP_SIGNING_KEY to run the real Selfie Check flow.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (mode === "unavailable") {
    return NextResponse.json(
      {
        error: "not_configured",
        message:
          "World ID is not configured. Set WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY in .env.local.",
      },
      { status: 503 },
    );
  }

  try {
    return NextResponse.json(
      {
        mode,
        app_id: world.appId,
        action: world.action,
        environment: world.environment,
        rp_context: createRpContext(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof WorldError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}
