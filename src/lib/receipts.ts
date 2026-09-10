import { query, transaction } from "@/lib/db";
import { operator, receiptsConfigured } from "@/lib/config";
import { submitReceipt } from "@/lib/hedera";

/**
 * HCS receipt outbox.
 *
 * A paid HTTP request cannot wait several seconds for consensus, so the
 * gateway writes the receipt intent here and returns. A cron drain submits to
 * the topic and back-fills the receipt id onto the call or claim. If the
 * marketplace has no operator key the rows simply queue — nothing is faked.
 */

export type ReceiptKind = "call" | "refund";

export interface CallReceipt {
  service_id: string;
  service_slug: string;
  seller_account: string;
  payer_account: string | null;
  amount: string;
  asset: string;
  units: number;
  price_unit: string;
  /** Null for a free tool: there was a delivery, but no payment. */
  payment_tx: string | null;
  request_hash: string;
  response_hash: string;
}

export interface RefundReceipt {
  call_id: string;
  claim_id: string;
  seller_account: string;
  payer_account: string | null;
  amount: string;
  asset: string;
  reason: string;
  payout_tx: string | null;
}

async function enqueue(kind: ReceiptKind, refId: string, payload: unknown) {
  await query(
    `INSERT INTO receipt_outbox (kind, ref_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, ref_id) DO NOTHING`,
    [kind, refId, JSON.stringify({ v: 1, kind, ...(payload as object) })],
  );
}

export async function enqueueCallReceipt(callId: string, payload: CallReceipt) {
  await enqueue("call", callId, { call_id: callId, ...payload });
}

export async function enqueueRefundReceipt(claimId: string, payload: RefundReceipt) {
  await enqueue("refund", claimId, payload);
}

export interface DrainResult {
  configured: boolean;
  pending: number;
  sent: number;
  failed: number;
  errors: string[];
}

const MAX_ATTEMPTS = 5;

/**
 * Submits queued receipts to the topic. Safe to run concurrently: rows are
 * claimed with FOR UPDATE SKIP LOCKED so two cron ticks cannot double-submit.
 */
export async function drainReceipts(limit = 10): Promise<DrainResult> {
  const pendingRow = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM receipt_outbox WHERE status = 'pending'`,
  );
  const pending = Number(pendingRow[0]?.count ?? 0);

  if (!receiptsConfigured) {
    return { configured: false, pending, sent: 0, failed: 0, errors: [] };
  }

  const claimed = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string; payload: unknown }>(
      `SELECT id, payload
         FROM receipt_outbox
        WHERE status = 'pending' AND attempts < $2
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit, MAX_ATTEMPTS],
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE receipt_outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id)],
      );
    }
    return rows;
  });

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of claimed) {
    try {
      const result = await submitReceipt(operator.topicId, row.payload);
      const receiptId = `${result.topicId}@${result.sequenceNumber}`;

      await transaction(async (client) => {
        await client.query(
          `UPDATE receipt_outbox
              SET status = 'sent', sent_at = now(), topic_id = $2,
                  hcs_receipt_id = $3, last_error = NULL
            WHERE id = $1`,
          [row.id, result.topicId, receiptId],
        );

        const payload = row.payload as { kind?: string; call_id?: string; claim_id?: string };
        if (payload.kind === "call" && payload.call_id) {
          await client.query(`UPDATE calls SET hcs_receipt_id = $2 WHERE id = $1`, [
            payload.call_id,
            receiptId,
          ]);
        } else if (payload.kind === "refund" && payload.claim_id) {
          await client.query(`UPDATE claims SET hcs_receipt_id = $2 WHERE id = $1`, [
            payload.claim_id,
            receiptId,
          ]);
        }
      });

      sent++;
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(reason);
      await query(
        `UPDATE receipt_outbox
            SET last_error = $2,
                status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END
          WHERE id = $1`,
        [row.id, reason.slice(0, 500), MAX_ATTEMPTS],
      );
    }
  }

  return { configured: true, pending, sent, failed, errors };
}
