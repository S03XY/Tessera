import { NextResponse } from "next/server";
import { dbReachable } from "@/lib/db";
import { facilitatorSupportsNetwork } from "@/lib/x402";
import { worldMode } from "@/lib/world";
import {
  chainConfigured,
  DEPOSIT_BOND_TOKEN_ID,
  FACILITATOR_URL,
  graphMode,
  receiptsConfigured,
  X402_NETWORK,
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
      // Each of these degrades explicitly rather than silently: an absent key
      // is reported as absent, never worked around with a fabricated result.
      graph: graphMode(),
      deposit_bond: DEPOSIT_BOND_TOKEN_ID || null,
      // "simulated" means Selfie Check passes are stand-ins, not real proofs.
      world_id: worldMode(),
      network: X402_NETWORK,
      facilitator_url: FACILITATOR_URL,
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
