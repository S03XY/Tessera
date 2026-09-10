import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { creditDeposit, getAgentById, WalletError } from "@/lib/wallet";
import { verifyDepositTransfer } from "@/lib/hedera";
import { treasury, treasuryConfigured, hashscanTx } from "@/lib/config";
import { formatAmount } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Funding an agent's balance.
 *
 * The amount is never taken from the request. The caller supplies a
 * transaction id, and every figure used to credit the balance is read back
 * from the mirror node — the same rule the seller deposit path follows, and
 * the reason a caller cannot mint themselves a balance by asking nicely.
 *
 * Idempotent on the transaction id, so a client that retries after a timeout
 * credits once. That guard is a unique index rather than a check-then-write,
 * because two concurrent retries would both pass a check.
 */

const Body = z.object({
  agent_id: z.string().uuid(),
  transaction_id: z.string().min(10).max(120),
  /** The account the funds came from, checked against the transaction. */
  from_account: z.string().min(3).max(64),
});

export async function POST(request: NextRequest) {
  if (!treasuryConfigured) {
    return NextResponse.json(
      {
        error: "treasury_unconfigured",
        message:
          "This deployment has no treasury account, so balances cannot be funded. " +
          "Set MCP_TREASURY_ACCOUNT_ID and MCP_TREASURY_KEY.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const input = parsed.data;

  const agent = await getAgentById(input.agent_id);
  if (!agent) {
    return NextResponse.json(
      { error: "unknown_agent", message: "No agent is registered with that id." },
      { status: 404 },
    );
  }
  if (agent.revoked_at) {
    return NextResponse.json(
      { error: "agent_revoked", message: "This agent has been revoked and cannot be funded." },
      { status: 409 },
    );
  }

  /* ------------------------------------------------------ read the chain */

  let check;
  try {
    check = await verifyDepositTransfer(
      input.transaction_id.trim(),
      input.from_account.trim(),
      treasury.accountId,
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_transaction",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  if (!check.ok) {
    return NextResponse.json(
      {
        error: "transfer_not_confirmed",
        message:
          check.reason ??
          "That transaction does not show a transfer into the marketplace treasury.",
      },
      { status: 402 },
    );
  }

  /* ---------------------------------------------------------- credit it */

  try {
    const result = await creditDeposit({
      agentId: agent.id,
      amount: check.amount,
      tx: input.transaction_id.trim(),
      memo: `funded from ${input.from_account.trim()}`,
    });

    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      credited_atomic: result.duplicate ? "0" : check.amount.toString(),
      credited_display: result.duplicate
        ? "already credited"
        : `${formatAmount(check.amount)} ℏ`,
      balance_atomic: result.balance.toString(),
      balance_display: `${formatAmount(result.balance)} ℏ`,
      transaction: input.transaction_id.trim(),
      explorer: hashscanTx(input.transaction_id.trim()),
      message: result.duplicate
        ? "That transaction was already credited. The balance is unchanged."
        : "Funded. The agent can spend immediately.",
    });
  } catch (err) {
    if (err instanceof WalletError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    throw err;
  }
}
