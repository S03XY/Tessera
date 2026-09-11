import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { isHederaAccountId } from "@/lib/hedera";
import { requiredDeposit } from "@/lib/config";
import { formatAmount } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Registering a seller.
 *
 * Registration on its own buys nothing: it records who a payout would go to
 * and creates the row a deposit can be attached to. The gate that actually
 * decides whether a listing goes live is the deposit, checked at listing time
 * and again on every call, so an account that registers and never funds is
 * indistinguishable from one that never registered.
 *
 * Idempotent on the account id, because a seller re-submitting the form
 * should update their display name rather than collide.
 */

const Body = z.object({
  account_id: z.string().min(3).max(64),
  display_name: z.string().max(80).optional(),
});

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

  const accountId = parsed.data.account_id.trim();
  const displayName = parsed.data.display_name?.trim();

  if (!isHederaAccountId(accountId)) {
    return NextResponse.json(
      {
        error: "invalid_account",
        message: "Account id must look like 0.0.12345.",
      },
      { status: 400 },
    );
  }

  const rows = await query<{ id: string; account_id: string; display_name: string }>(
    `INSERT INTO sellers (account_id, display_name, verification_status, verified_at)
     VALUES ($1, $2, 'verified', now())
     ON CONFLICT (account_id) DO UPDATE
       SET display_name = COALESCE(NULLIF($2, ''), sellers.display_name)
     RETURNING id, account_id, display_name`,
    [accountId, displayName || `Seller ${accountId}`],
  );

  const required = requiredDeposit();

  return NextResponse.json({
    ok: true,
    seller: rows[0],
    required_deposit_atomic: required.toString(),
    required_deposit_display: `${formatAmount(required)} ℏ`,
    message:
      `Registered. Post a ${formatAmount(required)} ℏ refundable dispute deposit ` +
      "to make listings callable.",
  });
}
