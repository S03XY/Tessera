import { NextResponse } from "next/server";
import { dbReachable } from "@/lib/db";
import { facilitatorSupportsNetwork } from "@/lib/x402";
import { worldMode } from "@/lib/world";
import {
  chainConfigured,
  receiptsConfigured,
  X402_NETWORK,
  FACILITATOR_URL,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment readiness. Reports what is genuinely wired up rather than a flat
 * "ok", so a missing operator key shows as a missing operator key.
 */
export async function GET() {
  const [database, facilitator] = await Promise.all([
    dbReachable(),
    facilitatorSupportsNetwork(),
  ]);

  const ok = database && facilitator;

  return NextResponse.json(
    {
      ok,
      checks: {
        database,
        facilitator,
        chain_operator: chainConfigured,
        hcs_receipts: receiptsConfigured,
      },
      // "simulated" means Selfie Check passes are stand-ins, not real proofs.
      world_id: worldMode(),
      network: X402_NETWORK,
      facilitator_url: FACILITATOR_URL,
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
