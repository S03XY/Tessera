import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  isHederaAccountId,
  markVerified,
  simulateProof,
  verifyProof,
  worldMode,
  WorldError,
  type VerifiedProof,
} from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  account_id: z.string().min(3).max(64),
  display_name: z.string().max(80).optional(),
  proof: z.unknown().optional(),
  /**
   * Simulation only. Two sellers claiming the same persona collide on the
   * nullifier, exactly as two proofs from one human would.
   */
  persona: z.string().min(1).max(80).optional(),
});

/**
 * Completes seller verification.
 *
 * In `live` mode the IDKit proof is forwarded to World and only their answer
 * is trusted. In `simulated` mode no proof exists, and the seller is recorded
 * with the `selfie_check_simulated` credential so nothing downstream can
 * mistake it for a real Selfie Check pass.
 */
export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const { account_id, display_name, proof, persona } = parsed.data;

  if (!isHederaAccountId(account_id)) {
    return NextResponse.json(
      {
        error: "invalid_account",
        message: "account_id must be a Hedera account id such as 0.0.12345.",
      },
      { status: 400 },
    );
  }

  const mode = worldMode();

  try {
    let verified: VerifiedProof;

    if (mode === "live") {
      if (!proof || typeof proof !== "object") {
        return NextResponse.json(
          { error: "missing_proof", message: "An IDKit proof result is required." },
          { status: 400 },
        );
      }
      verified = await verifyProof(proof);
    } else if (mode === "simulated") {
      if (!persona) {
        return NextResponse.json(
          {
            error: "missing_persona",
            message:
              "Simulation requires a persona so the one-human-one-account rule can still be exercised.",
          },
          { status: 400 },
        );
      }
      verified = simulateProof(persona);
    } else {
      return NextResponse.json(
        {
          error: "not_configured",
          message:
            "World ID is not configured. Set WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY, or WORLD_SIMULATION=1 for development.",
        },
        { status: 503 },
      );
    }

    const seller = await markVerified(
      account_id.trim(),
      verified.nullifier,
      verified.credential,
      display_name,
    );

    return NextResponse.json(
      {
        verified: true,
        simulated: mode === "simulated",
        credential: verified.credential,
        seller,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof WorldError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}
