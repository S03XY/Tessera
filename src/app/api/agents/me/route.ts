import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgent,
  ledgerFor,
  parseBearer,
  replayBalance,
  spentToday,
} from "@/lib/wallet";
import { formatAmount } from "@/lib/money";
import { anonymousKey, bucketFor, quotaStatus } from "@/lib/quota";
import { credentialLabel } from "@/lib/world-credentials";
import { hashscanTx } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What an agent can see about itself.
 *
 * Includes a reconciliation: the balance recomputed from the ledger, next to
 * the stored one. They are always equal, and publishing both is what turns
 * that from a claim into something the holder of the token can check
 * themselves without asking us.
 */

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(parseBearer(request.headers.get("authorization")));

  if (!agent) {
    return NextResponse.json(
      {
        error: "unauthorized",
        message: "Present a valid agent token as `Authorization: Bearer <token>`.",
      },
      { status: 401, headers: { "www-authenticate": 'Bearer realm="tessera"' } },
    );
  }

  const bucket = bucketFor(agent, anonymousKey(null, null));

  const [spent, replayed, ledger, freeQuota] = await Promise.all([
    spentToday(agent.id),
    replayBalance(agent.id),
    ledgerFor(agent.id, 50),
    quotaStatus(bucket),
  ]);

  const stored = BigInt(agent.balance);

  return NextResponse.json({
    agent: {
      id: agent.id,
      label: agent.label,
      owner_account: agent.owner_account,
      created_at: agent.created_at,
      // Which human, if any, stands behind this agent. Not an identity — the
      // nullifier is not returned — only what it earns.
      human_verified: Boolean(agent.world_nullifier),
      credential: agent.world_credential,
      credential_label: agent.world_credential
        ? credentialLabel(agent.world_credential)
        : null,
    },
    /**
     * The free-tool allowance, so an agent can plan rather than discover its
     * ceiling by being refused. `tier` is the lever: verifying the human
     * behind the agent is what moves it, and running more agents does not.
     */
    free_calls: {
      tier: freeQuota.kind,
      used: freeQuota.used,
      limit: freeQuota.limit,
      remaining: Math.max(freeQuota.limit - freeQuota.used, 0),
      raise_it:
        freeQuota.kind === "human"
          ? null
          : "POST /api/agents/verify with a World ID proof to draw from the human allowance.",
    },
    balance: {
      atomic: agent.balance,
      display: `${formatAmount(agent.balance)} ℏ`,
      spent_today_atomic: spent.toString(),
      spent_total_atomic: agent.spent_total,
    },
    caps: {
      per_call_atomic: agent.per_call_cap,
      per_call_display: agent.per_call_cap ? `${formatAmount(agent.per_call_cap)} ℏ` : null,
      per_day_atomic: agent.per_day_cap,
      per_day_display: agent.per_day_cap ? `${formatAmount(agent.per_day_cap)} ℏ` : null,
    },
    reconciliation: {
      stored_atomic: agent.balance,
      replayed_atomic: replayed.toString(),
      // Always true. Published so it can be checked rather than believed.
      balanced: replayed === stored,
    },
    ledger: ledger.map((entry) => ({
      kind: entry.kind,
      amount_atomic: entry.amount,
      amount_display: `${formatAmount(entry.amount)} ℏ`,
      balance_after_atomic: entry.balance_after,
      call_id: entry.call_id,
      transaction: entry.tx,
      explorer: entry.tx ? hashscanTx(entry.tx) : null,
      memo: entry.memo,
      at: entry.created_at,
    })),
  });
}
