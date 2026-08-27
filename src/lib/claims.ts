import { query, queryOne, transaction } from "@/lib/db";
import { DISPUTE_WINDOW_HOURS, chainConfigured } from "@/lib/config";
import { enqueueRefundReceipt } from "@/lib/receipts";
import { transferHbar } from "@/lib/hedera";
import { sha256Hex } from "@/lib/hash";

/**
 * Disputes.
 *
 * A buyer who paid for a bad response can claim against the call. An upheld
 * claim refunds the buyer out of the seller's deposit — that is the whole
 * point of requiring the deposit in the first place.
 *
 * Some reasons are objectively checkable from what the gateway already
 * recorded, and those resolve automatically. Anything requiring judgement is
 * left open for a human resolver rather than being rubber-stamped.
 */

export const CLAIM_REASONS = [
  "no_response",
  "malformed",
  "wrong_data",
  "timeout",
  "other",
] as const;

export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** sha256 of an empty 200 body, the fingerprint of "paid for nothing". */
const EMPTY_BODY_HASH = sha256Hex("200\n");

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

export interface FileClaimInput {
  callId: string;
  reason: ClaimReason;
  evidence?: string;
}

export interface ClaimRecord {
  id: string;
  call_id: string;
  reason: string;
  status: string;
  resolution: string | null;
  payout_amount: string | null;
  payout_tx: string | null;
  created_at: string;
  resolved_at: string | null;
}

export async function fileClaim(input: FileClaimInput): Promise<ClaimRecord> {
  const call = await queryOne<{
    id: string;
    status: string;
    paid_amount: string | null;
    payer_account: string | null;
    response_hash: string | null;
    http_status: number | null;
    created_at: string;
    service_id: string;
    seller_id: string;
    seller_account: string;
    deposit_amount: string;
    asset: string;
  }>(
    `SELECT c.id, c.status, c.paid_amount, c.payer_account, c.response_hash,
            c.http_status, c.created_at, c.service_id, c.asset,
            s.seller_id, sel.account_id AS seller_account, sel.deposit_amount
       FROM calls c
       JOIN services s   ON s.id = c.service_id
       JOIN sellers  sel ON sel.id = s.seller_id
      WHERE c.id = $1`,
    [input.callId],
  );

  if (!call) throw new ClaimError("No such call.", "unknown_call", 404);

  if (call.status !== "delivered") {
    throw new ClaimError(
      `Only a delivered call can be disputed; this one is ${call.status}.`,
      "not_disputable",
      409,
    );
  }

  const ageHours = (Date.now() - new Date(call.created_at).getTime()) / 3_600_000;
  if (ageHours > DISPUTE_WINDOW_HOURS) {
    throw new ClaimError(
      `The ${DISPUTE_WINDOW_HOURS}h dispute window for this call has closed.`,
      "window_closed",
      409,
    );
  }

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM claims WHERE call_id = $1`,
    [call.id],
  );
  if (existing) {
    throw new ClaimError("A claim has already been filed against this call.", "duplicate_claim", 409);
  }

  const claim = await transaction(async (client) => {
    const { rows } = await client.query<ClaimRecord>(
      `INSERT INTO claims (call_id, reason, evidence)
       VALUES ($1, $2, $3)
       RETURNING id, call_id, reason, status, resolution,
                 payout_amount, payout_tx, created_at, resolved_at`,
      [call.id, input.reason, (input.evidence ?? "").slice(0, 2000)],
    );
    await client.query(
      `UPDATE sellers SET calls_disputed = calls_disputed + 1 WHERE id = $1`,
      [call.seller_id],
    );
    return rows[0];
  });

  // Objectively checkable failure: settle it now rather than making the buyer wait.
  const verdict = adjudicate(input.reason, call.response_hash, call.http_status);
  if (verdict.uphold) {
    return resolveClaim(claim.id, "upheld", verdict.rationale);
  }

  return claim;
}

/**
 * Deterministic adjudication.
 *
 * Only claims the gateway's own records can prove are auto-upheld. "The data
 * was wrong" is a judgement call and stays open.
 */
export function adjudicate(
  reason: ClaimReason,
  responseHash: string | null,
  httpStatus: number | null,
): { uphold: boolean; rationale: string } {
  if (reason === "no_response") {
    if (!responseHash || responseHash === EMPTY_BODY_HASH) {
      return {
        uphold: true,
        rationale: "Recorded response body was empty. Refunded automatically.",
      };
    }
    return { uphold: false, rationale: "A non-empty response was recorded." };
  }

  if (reason === "timeout") {
    if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
      return {
        uphold: true,
        rationale: `Upstream status was ${httpStatus ?? "absent"}. Refunded automatically.`,
      };
    }
    return { uphold: false, rationale: "Upstream returned a success status." };
  }

  return { uphold: false, rationale: "Requires review." };
}

/**
 * Resolves a claim. Upholding pays the buyer back out of the seller's deposit
 * and writes a refund receipt, exactly like a payment.
 */
export async function resolveClaim(
  claimId: string,
  decision: "upheld" | "rejected",
  rationale: string,
): Promise<ClaimRecord> {
  const claim = await queryOne<{
    id: string;
    status: string;
    call_id: string;
    reason: string;
    paid_amount: string | null;
    payer_account: string | null;
    asset: string;
    seller_id: string;
    seller_account: string;
    deposit_amount: string;
  }>(
    `SELECT cl.id, cl.status, cl.call_id, cl.reason,
            c.paid_amount, c.payer_account, c.asset,
            s.seller_id, sel.account_id AS seller_account, sel.deposit_amount
       FROM claims cl
       JOIN calls c      ON c.id = cl.call_id
       JOIN services s   ON s.id = c.service_id
       JOIN sellers  sel ON sel.id = s.seller_id
      WHERE cl.id = $1`,
    [claimId],
  );

  if (!claim) throw new ClaimError("No such claim.", "unknown_claim", 404);
  if (claim.status !== "open") {
    throw new ClaimError(`Claim is already ${claim.status}.`, "already_resolved", 409);
  }

  if (decision === "rejected") {
    const rows = await query<ClaimRecord>(
      `UPDATE claims
          SET status = 'rejected', resolution = $2, resolved_at = now()
        WHERE id = $1
        RETURNING id, call_id, reason, status, resolution,
                  payout_amount, payout_tx, created_at, resolved_at`,
      [claimId, rationale],
    );
    return rows[0];
  }

  const refund = BigInt(claim.paid_amount ?? "0");
  const deposit = BigInt(claim.deposit_amount);
  if (refund <= 0n) {
    throw new ClaimError("Nothing was paid for this call.", "nothing_to_refund", 409);
  }

  // A deposit cannot go negative: pay out what is actually there.
  const payout = refund > deposit ? deposit : refund;

  let payoutTx: string | null = null;
  if (chainConfigured && claim.payer_account && payout > 0n) {
    try {
      payoutTx = await transferHbar(claim.payer_account, payout);
    } catch (err) {
      throw new ClaimError(
        `Refund transfer failed: ${err instanceof Error ? err.message : String(err)}`,
        "payout_failed",
        502,
      );
    }
  }

  const resolved = await transaction(async (client) => {
    const { rows } = await client.query<ClaimRecord>(
      `UPDATE claims
          SET status = 'upheld', resolution = $2, payout_amount = $3,
              payout_tx = $4, resolved_at = now()
        WHERE id = $1
        RETURNING id, call_id, reason, status, resolution,
                  payout_amount, payout_tx, created_at, resolved_at`,
      [claimId, rationale, payout.toString(), payoutTx],
    );

    await client.query(
      `UPDATE sellers
          SET deposit_amount = GREATEST(deposit_amount - $2::numeric, 0),
              calls_refunded = calls_refunded + 1
        WHERE id = $1`,
      [claim.seller_id, payout.toString()],
    );

    await client.query(`UPDATE calls SET status = 'refunded' WHERE id = $1`, [claim.call_id]);

    return rows[0];
  });

  await enqueueRefundReceipt(resolved.id, {
    call_id: claim.call_id,
    claim_id: resolved.id,
    seller_account: claim.seller_account,
    payer_account: claim.payer_account,
    amount: payout.toString(),
    asset: claim.asset,
    reason: claim.reason,
    payout_tx: payoutTx,
  });

  return resolved;
}

export async function listClaims(limit = 50) {
  return query<
    ClaimRecord & {
      evidence: string;
      service_name: string;
      service_slug: string;
      seller_name: string;
      payer_account: string | null;
    }
  >(
    `SELECT cl.*, s.name AS service_name, s.slug AS service_slug,
            sel.display_name AS seller_name, c.payer_account
       FROM claims cl
       JOIN calls c      ON c.id = cl.call_id
       JOIN services s   ON s.id = c.service_id
       JOIN sellers  sel ON sel.id = s.seller_id
      ORDER BY cl.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
}

export async function getClaimForCall(callId: string) {
  return queryOne<ClaimRecord & { evidence: string }>(
    `SELECT * FROM claims WHERE call_id = $1`,
    [callId],
  );
}
