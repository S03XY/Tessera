import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateAgent, verifyAgentHuman } from "@/lib/wallet";
import { parseBearer } from "@/lib/wallet";
import { anonymousKey, bucketFor, quotaStatus } from "@/lib/quota";
import {
  credentialLabel,
  describeWorld,
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
  proof: z.unknown().optional(),
  /** Simulation only, exactly as on the seller route. */
  persona: z.string().min(1).max(80).optional(),
});

/**
 * Proving a human behind a buying agent.
 *
 * This is the second, quite different use of the same credential. A seller's
 * proof is an *exclusivity* claim — one human, one seller account, enforced by
 * a unique constraint. An agent's proof is a *quota* claim: it does not make
 * the agent exclusive or more trusted, it simply says which person's free-call
 * allowance this agent draws from. Running ten agents on one proof is fine and
 * expected; all ten share the one allowance.
 *
 * That difference is the reason a low-assurance credential fits. Nothing here
 * grants money, payout rights or a listing — the worst case for a wrongly
 * granted proof is that someone gets a larger allowance of *free* API calls
 * than they should. Matching the strength of the check to the size of that
 * downside is the entire design.
 */
export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(parseBearer(request.headers.get("authorization")));
  if (!agent) {
    return NextResponse.json(
      {
        error: "unauthenticated",
        message: "Present the agent's bearer token. Register one at POST /api/agents/register.",
      },
      { status: 401 },
    );
  }

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

  const { proof, persona } = parsed.data;
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
              "Simulation requires a persona so the one-allowance-per-human rule is still exercised.",
          },
          { status: 400 },
        );
      }
      verified = simulateProof(persona);
    } else {
      return NextResponse.json(
        {
          error: "not_configured",
          message: `World ID is not configured. ${describeWorld().problem}`,
        },
        { status: 503 },
      );
    }

    const updated = await verifyAgentHuman(agent.id, verified.nullifier, verified.credential);
    if (!updated) {
      return NextResponse.json(
        { error: "agent_revoked", message: "This agent has been revoked." },
        { status: 409 },
      );
    }

    const bucket = bucketFor(updated, anonymousKey(null, null));
    const status = await quotaStatus(bucket);

    return NextResponse.json({
      verified: true,
      simulated: mode === "simulated",
      credential: verified.credential,
      credential_label: credentialLabel(verified.credential),
      agent: { id: updated.id, label: updated.label },
      // The point of verifying, stated as a number.
      free_calls: {
        tier: status.kind,
        used: status.used,
        limit: status.limit,
        shared_with_other_agents_of_this_human: true,
      },
    });
  } catch (err) {
    if (err instanceof WorldError) {
      return NextResponse.json(
        { error: err.code, message: err.message, retryable: err.retryable },
        { status: err.status },
      );
    }
    throw err;
  }
}
