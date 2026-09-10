import { NextResponse } from "next/server";
import {
  createRpContext,
  credentialSpec,
  describeWorld,
  world,
  worldMode,
  WorldError,
} from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a signed RP context for an IDKit request. Signing happens here so
 * the RP key stays on the server.
 *
 * The response also carries which credential to request and whether legacy
 * proofs are permitted, because both are deployment configuration and a
 * client that hard-codes them cannot follow WORLD_CREDENTIAL. Getting
 * `allow_legacy_proofs` wrong is not a soft failure — IDKit refuses the
 * request outright — so it is decided in one place, here.
 */
export async function GET() {
  const mode = worldMode();
  const spec = credentialSpec();

  if (mode === "simulated") {
    return NextResponse.json(
      {
        mode,
        app_id: world.appId,
        action: world.action,
        credential: world.credential,
        message:
          "Simulation mode: no RP context is issued. Set WORLD_RP_SIGNING_KEY to run the real flow.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (mode === "unavailable") {
    return NextResponse.json(
      {
        error: "not_configured",
        message: `World ID is not configured. ${describeWorld().problem}`,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    return NextResponse.json(
      {
        mode,
        app_id: world.appId,
        action: world.action,
        environment: world.environment,
        credential: world.credential,
        credential_label: spec.label,
        preset: spec.preset,
        allow_legacy_proofs: spec.legacyProofs,
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
