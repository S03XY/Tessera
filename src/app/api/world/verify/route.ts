import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isHederaAccountId, markVerified, verifyProof, WorldError } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  account_id: z.string().min(3).max(64),
  display_name: z.string().max(80).optional(),
  proof: z.unknown(),
});

/**
 * Completes seller verification: forwards the IDKit proof to World, then
 * records the nullifier against the seller account.
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

  const { account_id, display_name, proof } = parsed.data;

  if (!isHederaAccountId(account_id)) {
    return NextResponse.json(
      {
        error: "invalid_account",
        message: "account_id must be a Hedera account id such as 0.0.12345.",
      },
      { status: 400 },
    );
  }

  if (!proof || typeof proof !== "object") {
    return NextResponse.json(
      { error: "missing_proof", message: "An IDKit proof result is required." },
      { status: 400 },
    );
  }

  try {
    const { nullifier } = await verifyProof(proof);
    const seller = await markVerified(account_id.trim(), nullifier, display_name);
    return NextResponse.json({ verified: true, seller }, { status: 200 });
  } catch (err) {
    if (err instanceof WorldError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}
