import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import { adjudicate, ClaimError, fileClaim, resolveClaim } from "@/lib/claims";
import { hashResponse } from "@/lib/hash";

/**
 * The dispute path. Requires a seeded database; every test creates and then
 * removes its own call so the suite can be re-run without drift.
 */

const created: string[] = [];
let baselineDeposit = 0n;

// With operator keys configured, an upheld claim performs a real transfer.
// Point the fixture at the funded agent account so the refund can land;
// otherwise resolveClaim correctly refuses to record a payout it cannot make.
const PAYER = process.env.AGENT_ACCOUNT_ID ?? "0.0.7326078";

interface Fixture {
  callId: string;
  sellerId: string;
  depositBefore: bigint;
}

async function makeDeliveredCall(options: {
  responseBody?: string | null;
  httpStatus?: number | null;
  paid?: string;
  ageHours?: number;
  slug?: string;
} = {}): Promise<Fixture> {
  const slug = options.slug ?? "open-exchange-rates";
  const service = await queryOne<{ id: string; seller_id: string; deposit_amount: string }>(
    `SELECT s.id, s.seller_id, sel.deposit_amount
       FROM services s JOIN sellers sel ON sel.id = s.seller_id
      WHERE s.slug = $1`,
    [slug],
  );
  if (!service) throw new Error(`fixture service ${slug} missing — run npm run db:reset`);

  const responseHash =
    options.responseBody === null
      ? null
      : hashResponse(options.httpStatus ?? 200, options.responseBody ?? '{"rate":1.09}');

  const rows = await query<{ id: string }>(
    `INSERT INTO calls
       (service_id, payer_account, quoted_amount, paid_amount, units, asset,
        payment_tx, request_hash, response_hash, status, http_status,
        latency_ms, created_at, delivered_at)
     VALUES ($1,$7,$2,$2,1,'0.0.0',$3,'reqhash',$4,'delivered',$5,120,
             now() - ($6 || ' hours')::interval, now())
     RETURNING id`,
    [
      service.id,
      options.paid ?? "90000",
      `test-tx-${Math.random().toString(36).slice(2)}-${created.length}`,
      responseHash,
      options.httpStatus === undefined ? 200 : options.httpStatus,
      String(options.ageHours ?? 0),
      PAYER,
    ],
  );

  created.push(rows[0].id);
  return {
    callId: rows[0].id,
    sellerId: service.seller_id,
    depositBefore: BigInt(service.deposit_amount),
  };
}

async function depositOf(sellerId: string): Promise<bigint> {
  const row = await queryOne<{ deposit_amount: string }>(
    `SELECT deposit_amount FROM sellers WHERE id = $1`,
    [sellerId],
  );
  return BigInt(row!.deposit_amount);
}

beforeAll(async () => {
  const row = await queryOne<{ deposit_amount: string }>(
    `SELECT deposit_amount FROM sellers WHERE display_name = 'Northwind APIs'`,
  );
  if (!row) throw new Error("fixture seller missing — run npm run db:reset");
  baselineDeposit = BigInt(row.deposit_amount);
});

beforeEach(() => {
  created.length = 0;
});

afterEach(async () => {
  if (created.length === 0) return;
  // Restore the seeded deposits and counters the tests moved.
  // The outbox is polymorphic (ref_id points at a call or a claim), so it has
  // no cascading FK and must be cleared explicitly or rows outlive the test.
  await query(
    `DELETE FROM receipt_outbox
      WHERE ref_id = ANY($1::uuid[])
         OR ref_id IN (SELECT id FROM claims WHERE call_id = ANY($1::uuid[]))`,
    [created],
  );
  await query(`DELETE FROM claims WHERE call_id = ANY($1::uuid[])`, [created]);
  await query(`DELETE FROM calls WHERE id = ANY($1::uuid[])`, [created]);
  // Restore whatever the fixture seller held before the test moved it.
  await query(
    `UPDATE sellers SET deposit_amount = $1, calls_disputed = 0, calls_refunded = 0
      WHERE display_name = 'Northwind APIs'`,
    [String(baselineDeposit)],
  );
});

describe("adjudicate", () => {
  it("upholds no_response when the body was empty", () => {
    const verdict = adjudicate("no_response", hashResponse(200, ""), 200);
    expect(verdict.uphold).toBe(true);
  });

  it("upholds no_response when nothing was recorded at all", () => {
    expect(adjudicate("no_response", null, 200).uphold).toBe(true);
  });

  it("rejects no_response when a real body was recorded", () => {
    expect(adjudicate("no_response", hashResponse(200, '{"a":1}'), 200).uphold).toBe(false);
  });

  it("upholds timeout on a non-2xx status", () => {
    expect(adjudicate("timeout", "x", 504).uphold).toBe(true);
    expect(adjudicate("timeout", "x", null).uphold).toBe(true);
  });

  it("rejects timeout when upstream returned 200", () => {
    expect(adjudicate("timeout", "x", 200).uphold).toBe(false);
  });

  it.each(["malformed", "wrong_data", "other"] as const)(
    "leaves %s for review rather than auto-refunding",
    (reason) => {
      expect(adjudicate(reason, "x", 200).uphold).toBe(false);
    },
  );
});

describe("fileClaim — rejects", () => {
  it("refuses an unknown call", async () => {
    await expect(
      fileClaim({ callId: "00000000-0000-0000-0000-000000000000", reason: "other" }),
    ).rejects.toThrow(/No such call/);
  });

  it("refuses a call that was never delivered", async () => {
    const service = await queryOne<{ id: string }>(
      `SELECT id FROM services WHERE slug = 'open-exchange-rates'`,
    );
    const rows = await query<{ id: string }>(
      `INSERT INTO calls (service_id, quoted_amount, asset, status, error)
       VALUES ($1, '90000', '0.0.0', 'failed', 'upstream down') RETURNING id`,
      [service!.id],
    );
    created.push(rows[0].id);

    await expect(fileClaim({ callId: rows[0].id, reason: "other" })).rejects.toThrow(
      /Only a delivered call/,
    );
  });

  it("refuses once the dispute window has closed", async () => {
    const fixture = await makeDeliveredCall({ ageHours: 48 });
    await expect(fileClaim({ callId: fixture.callId, reason: "other" })).rejects.toThrow(
      /window .* has closed/,
    );
  });

  it("refuses a second claim against the same call", async () => {
    const fixture = await makeDeliveredCall();
    await fileClaim({ callId: fixture.callId, reason: "wrong_data" });
    await expect(fileClaim({ callId: fixture.callId, reason: "other" })).rejects.toThrow(
      /already been filed/,
    );
  });
});

describe("fileClaim — automatic refund", () => {
  it("refunds the buyer from the seller's deposit when the body was empty", async () => {
    const fixture = await makeDeliveredCall({ responseBody: "" });

    const claim = await fileClaim({
      callId: fixture.callId,
      reason: "no_response",
      evidence: "Empty body returned for a paid call.",
    });

    expect(claim.status).toBe("upheld");
    expect(claim.payout_amount).toBe("90000");

    // The deposit really moved.
    expect(await depositOf(fixture.sellerId)).toBe(fixture.depositBefore - 90000n);

    // And the call is marked refunded.
    const call = await queryOne<{ status: string }>(`SELECT status FROM calls WHERE id = $1`, [
      fixture.callId,
    ]);
    expect(call?.status).toBe("refunded");
  });

  it("queues a refund receipt for consensus", async () => {
    const fixture = await makeDeliveredCall({ responseBody: "" });
    const claim = await fileClaim({ callId: fixture.callId, reason: "no_response" });

    const outbox = await queryOne<{ kind: string; status: string; payload: { amount: string } }>(
      `SELECT kind, status, payload FROM receipt_outbox WHERE kind = 'refund' AND ref_id = $1`,
      [claim.id],
    );
    expect(outbox?.kind).toBe("refund");
    expect(outbox?.payload.amount).toBe("90000");
  });

  it("leaves a judgement call open instead of auto-refunding", async () => {
    const fixture = await makeDeliveredCall();
    const claim = await fileClaim({ callId: fixture.callId, reason: "wrong_data" });

    expect(claim.status).toBe("open");
    expect(await depositOf(fixture.sellerId)).toBe(fixture.depositBefore);
  });
});

describe("resolveClaim", () => {
  it("pays out on a manual uphold and decrements the deposit", async () => {
    const fixture = await makeDeliveredCall();
    const claim = await fileClaim({ callId: fixture.callId, reason: "wrong_data" });

    const resolved = await resolveClaim(claim.id, "upheld", "Reviewed: data did not match.");
    expect(resolved.status).toBe("upheld");
    expect(await depositOf(fixture.sellerId)).toBe(fixture.depositBefore - 90000n);
  });

  it("moves no money on a rejection", async () => {
    const fixture = await makeDeliveredCall();
    const claim = await fileClaim({ callId: fixture.callId, reason: "wrong_data" });

    const resolved = await resolveClaim(claim.id, "rejected", "Response matched the spec.");
    expect(resolved.status).toBe("rejected");
    expect(resolved.payout_amount).toBeNull();
    expect(await depositOf(fixture.sellerId)).toBe(fixture.depositBefore);
  });

  it("refuses to resolve the same claim twice", async () => {
    const fixture = await makeDeliveredCall();
    const claim = await fileClaim({ callId: fixture.callId, reason: "wrong_data" });
    await resolveClaim(claim.id, "rejected", "first");

    await expect(resolveClaim(claim.id, "upheld", "second")).rejects.toThrow(/already rejected/);
  });

  it("never pays out more than the deposit holds", async () => {
    // Shrink the deposit first: the assertion is about the cap, and moving the
    // seller's whole balance on every run would churn real testnet HBAR.
    const fixture = await makeDeliveredCall({ paid: "99999999999" });
    await query(`UPDATE sellers SET deposit_amount = $2 WHERE id = $1`, [
      fixture.sellerId,
      "50000",
    ]);

    const claim = await fileClaim({ callId: fixture.callId, reason: "wrong_data" });
    const resolved = await resolveClaim(claim.id, "upheld", "Refund capped at the deposit.");

    expect(BigInt(resolved.payout_amount!)).toBe(50000n);
    expect(await depositOf(fixture.sellerId)).toBe(0n);
  });

  it("refuses an unknown claim", async () => {
    await expect(
      resolveClaim("00000000-0000-0000-0000-000000000000", "upheld", "x"),
    ).rejects.toThrow(ClaimError);
  });
});
