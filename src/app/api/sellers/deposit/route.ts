import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { verifyDepositTransfer } from "@/lib/hedera";
import { chainConfigured, operator, MIN_DEPOSIT_TINYBARS } from "@/lib/config";
import { formatAmount } from "@/lib/money";
import { isHederaAccountId } from "@/lib/hedera";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  account_id: z.string().min(3).max(64),
  transaction_id: z.string().min(5).max(120),
});

/**
 * Credits a seller's dispute deposit against a real on-chain transfer.
 *
 * The seller supplies only a transaction id. Everything used to credit the
 * deposit — that it succeeded, who paid, and how much reached the treasury —
 * is read back from the Hedera mirror node.
 */
export async function POST(request: NextRequest) {
  if (!chainConfigured) {
    return NextResponse.json(
      {
        error: "chain_not_configured",
        message:
          "No marketplace treasury account is configured. Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY.",
      },
      { status: 503 },
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

  const accountId = parsed.data.account_id.trim();
  if (!isHederaAccountId(accountId)) {
    return NextResponse.json(
      { error: "invalid_account", message: "account_id must look like 0.0.12345." },
      { status: 400 },
    );
  }

  const seller = await queryOne<{ id: string; verification_status: string }>(
    `SELECT id, verification_status FROM sellers WHERE account_id = $1`,
    [accountId],
  );

  if (!seller) {
    return NextResponse.json(
      { error: "not_a_seller", message: "Register this account as a seller first." },
      { status: 403 },
    );
  }

  // A deposit tx may only be claimed once, by anyone.
  const reused = await queryOne<{ account_id: string }>(
    `SELECT account_id FROM sellers WHERE deposit_tx = $1`,
    [parsed.data.transaction_id.trim()],
  );
  if (reused) {
    return NextResponse.json(
      {
        error: "transaction_already_claimed",
        message: `That transaction has already been credited to ${reused.account_id}.`,
      },
      { status: 409 },
    );
  }

  let check;
  try {
    check = await verifyDepositTransfer(
      parsed.data.transaction_id,
      accountId,
      operator.accountId,
    );
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_transaction_id", message: (err as Error).message },
      { status: 400 },
    );
  }

  if (!check.ok) {
    return NextResponse.json(
      { error: "deposit_unverified", message: check.reason ?? "Could not verify the transfer." },
      { status: 400 },
    );
  }

  const rows = await query<{ deposit_amount: string }>(
    `UPDATE sellers
        SET deposit_amount = deposit_amount + $2::numeric,
            deposit_tx     = $3
      WHERE id = $1
      RETURNING deposit_amount`,
    [seller.id, check.amount.toString(), parsed.data.transaction_id.trim()],
  );

  const held = BigInt(rows[0].deposit_amount);

  return NextResponse.json({
    credited: check.amount.toString(),
    deposit_amount: rows[0].deposit_amount,
    meets_minimum: held >= MIN_DEPOSIT_TINYBARS,
    minimum: MIN_DEPOSIT_TINYBARS.toString(),
    message:
      held >= MIN_DEPOSIT_TINYBARS
        ? `Deposit of ${formatAmount(held)} ℏ accepted. You can now list services.`
        : `Holding ${formatAmount(held)} ℏ; ${formatAmount(
            MIN_DEPOSIT_TINYBARS - held,
          )} ℏ more is required before listing.`,
  });
}
