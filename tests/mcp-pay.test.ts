import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import {
  gatewayRequestFor,
  payAndCall,
  quoteListing,
  type PayDeps,
} from "@/lib/mcp-pay";
import {
  creditDeposit,
  getAgentById,
  ledgerFor,
  registerAgent,
  replayBalance,
  revokeAgent,
  type AgentAccount,
} from "@/lib/wallet";

/**
 * The paying path, exercised through injected seams.
 *
 * Every interesting branch here is a failure — a seller that times out, a
 * a signature the facilitator rejects — and all of them are
 * awkward to provoke against a real chain. The seams exist so the refund
 * guarantee can actually be tested rather than asserted in a comment.
 */

const LABEL = "__pay_test__";
const agents: string[] = [];
let sellerId: string;
let serviceSlug: string;
let meteredSlug: string;

async function makeAgent(opts: {
  balance?: bigint;
  perCallCap?: bigint | null;
  perDayCap?: bigint | null;
} = {}): Promise<AgentAccount> {
  const { agent } = await registerAgent({
    label: `${LABEL}${agents.length}`,
    ownerAccount: "0.0.333333",
    agentAccount: "0.0.444444",
    perCallCap: opts.perCallCap ?? null,
    perDayCap: opts.perDayCap ?? null,
  });
  agents.push(agent.id);

  if (opts.balance && opts.balance > 0n) {
    await creditDeposit({ agentId: agent.id, amount: opts.balance, tx: `pay-seed-${agent.id}` });
  }
  return (await getAgentById(agent.id)) as AgentAccount;
}

beforeAll(async () => {
  const seller = await queryOne<{ id: string }>(
    `SELECT id FROM sellers
      WHERE verification_status = 'verified'
      -- Best funded first, with a deterministic tiebreak.
      --
      -- The seed writes every seller in one transaction, so they share a
      -- single created_at and \`ORDER BY created_at LIMIT 1\` picks an
      -- arbitrary one of the five. One of those five is deliberately
      -- underfunded so the gateway can be seen refusing it — and drawing that
      -- seller makes a paid fixture fail with \`quote_failed\` a fifth of the
      -- time, for a reason nowhere near the thing under test.
      ORDER BY deposit_amount DESC, account_id
      LIMIT 1`,
  );
  if (!seller) {
    throw new Error("No verified seller found. Run `npm run db:reset` before the suite.");
  }
  sellerId = seller.id;

  serviceSlug = `pay-test-flat-${Date.now()}`;
  meteredSlug = `pay-test-metered-${Date.now()}`;

  await query(
    `INSERT INTO services (seller_id, slug, name, description, category, endpoint_url,
                           price_amount, price_unit, status)
     VALUES ($1,$2,'Pay Test','A fixture listing.','test','https://example.com/data',
             1000,'per_call','active')`,
    [sellerId, serviceSlug],
  );
  await query(
    `INSERT INTO services (seller_id, slug, name, description, category, endpoint_url,
                           price_amount, price_unit, status)
     VALUES ($1,$2,'Pay Test Metered','A metered fixture.','test','https://example.com/rows',
             100,'per_row','active')`,
    [sellerId, meteredSlug],
  );
});

afterAll(async () => {
  if (agents.length) await query(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [agents]);
  await query(`DELETE FROM services WHERE slug IN ($1,$2)`, [serviceSlug, meteredSlug]);
});

/* ------------------------------------------------------------ fake gateway */

interface FakeOptions {
  quote?: string;
  /** Status and body returned once payment is presented. */
  deliverStatus?: number;
  deliverBody?: string;
  /** Overrides the x-tessera-paid header, to simulate a partial settle. */
  paid?: string;
  quoteStatus?: number;
  throwOnQuote?: boolean;
  throwOnDeliver?: boolean;
}

function fakeGateway(options: FakeOptions = {}) {
  const calls: Array<{ url: string; paid: boolean }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    const presented = headers.has("x-payment");
    calls.push({ url, paid: presented });

    if (!presented) {
      if (options.throwOnQuote) throw new Error("connection refused");
      const status = options.quoteStatus ?? 402;
      if (status !== 402) {
        return new Response("gateway is down", { status });
      }
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "hedera:testnet",
              asset: "0.0.0",
              amount: options.quote ?? "1000",
              payTo: "0.0.999",
              maxTimeoutSeconds: 300,
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }

    if (options.throwOnDeliver) throw new Error("socket hang up");

    const status = options.deliverStatus ?? 200;
    if (status !== 200) {
      return new Response(
        JSON.stringify({ error: "upstream_error", message: "Upstream returned 500." }),
        { status, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(options.deliverBody ?? '{"ok":true}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-tessera-call-id": "",
        "x-tessera-tx": "0.0.1@1700000000.000000000",
        "x-tessera-paid": options.paid ?? options.quote ?? "1000",
        "x-tessera-units": "1",
        "x-tessera-truncated": "false",
      },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function deps(over: Partial<PayDeps> = {}): Partial<PayDeps> {
  return {
    signPayment: async () => "ZmFrZS1wYXltZW50",
    treasuryIsConfigured: true,
    baseUrl: "http://gateway.test",
    ...over,
  };
}

/* -------------------------------------------------------- pure helpers */

describe("quoteListing", () => {
  it("multiplies price by units for a metered listing", () => {
    expect(quoteListing({ price_amount: "100", price_unit: "per_row" }, 25)).toEqual({
      units: 25,
      quote: 2500n,
    });
  });

  it("bills a per-call listing once whatever units are asked for", () => {
    expect(quoteListing({ price_amount: "100", price_unit: "per_call" }, 25)).toEqual({
      units: 1,
      quote: 100n,
    });
  });
});

describe("gatewayRequestFor", () => {
  const flat = { slug: "s", upstream_kind: "http" as const, endpoint_method: "GET" as const, price_unit: "per_call" as const };

  it("GETs a plain per-call listing with no body", () => {
    expect(gatewayRequestFor(flat, "http://base.test", {}, 1)).toEqual({
      url: "http://base.test/x402/s",
      method: "GET",
      body: null,
    });
  });

  it("adds a units parameter only for metered listings", () => {
    const metered = { ...flat, price_unit: "per_row" as const };
    expect(gatewayRequestFor(metered, "http://base.test", {}, 20).url).toBe(
      "http://base.test/x402/s?units=20",
    );
  });

  it("POSTs the arguments as a body for an openapi listing", () => {
    const tool = { ...flat, upstream_kind: "openapi" as const };
    const request = gatewayRequestFor(tool, "http://base.test", { q: "gold" }, 1);
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toEqual({ q: "gold" });
  });

  it("forwards only the body argument for a plain POST listing", () => {
    const post = { ...flat, endpoint_method: "POST" as const };
    const request = gatewayRequestFor(post, "http://base.test", { body: { a: 1 } }, 1);
    expect(JSON.parse(request.body as string)).toEqual({ a: 1 });
  });
});

/* -------------------------------------------------------- the happy path */

describe("payAndCall — delivery", () => {
  it("quotes, reserves, delivers and returns the response", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000", deliverBody: '{"gold":2400}' });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.body).toBe('{"gold":2400}');
    expect(result.quote).toBe(1000n);
    expect(result.balance).toBe(9_000n);
    expect(result.transaction).toBe("0.0.1@1700000000.000000000");
    expect(result.explorerUrl).toContain("hashscan.io");

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("9000");
  });

  it("takes the gateway's price, not the listing's stored one", async () => {
    // The fixture is priced at 1000; the gateway quotes 1500.
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1500" });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.quote).toBe(1500n);
    expect(result.balance).toBe(8_500n);
  });

  it("asks for a quote before presenting any payment", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway();
    await payAndCall({ agent, slug: serviceSlug }, deps({ fetchImpl: gateway.fetchImpl }));

    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[0].paid).toBe(false);
    expect(gateway.calls[1].paid).toBe(true);
  });

  it("returns the unused budget when a metered call settles for less", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    // Reserved 2000, settled 600: the difference is the buyer's.
    const gateway = fakeGateway({ quote: "2000", paid: "600" });

    const result = await payAndCall(
      { agent, slug: meteredSlug, units: 20 },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.ok).toBe(true);
    expect(result.balance).toBe(9_400n);

    const kinds = (await ledgerFor(agent.id)).map((e) => e.kind);
    expect(kinds).toContain("refund");
    expect(await replayBalance(agent.id)).toBe(9_400n);
  });

  it("leaves a ledger that replays to the stored balance", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000" });
    await payAndCall({ agent, slug: serviceSlug }, deps({ fetchImpl: gateway.fetchImpl }));

    const fresh = await getAgentById(agent.id);
    expect((await replayBalance(agent.id)).toString()).toBe(fresh?.balance);
  });
});

/* ------------------------------------------------- refused before spending */

describe("payAndCall — refusals that spend nothing", () => {
  async function expectUnspent(agentId: string, expected: string) {
    const fresh = await getAgentById(agentId);
    expect(fresh?.balance).toBe(expected);
    const debits = (await ledgerFor(agentId)).filter((e) => e.kind === "debit");
    expect(debits).toHaveLength(0);
  }

  it("refuses an unknown listing", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const result = await payAndCall({ agent, slug: "no-such-listing" }, deps());
    expect(result.error?.code).toBe("unknown_service");
    await expectUnspent(agent.id, "10000");
  });

  it("refuses a suspended listing", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    await query(`UPDATE services SET status = 'suspended' WHERE slug = $1`, [serviceSlug]);

    const result = await payAndCall({ agent, slug: serviceSlug }, deps());
    expect(result.error?.code).toBe("service_unavailable");
    await expectUnspent(agent.id, "10000");

    await query(`UPDATE services SET status = 'active' WHERE slug = $1`, [serviceSlug]);
  });

  it("refuses when the quote exceeds the caller's ceiling", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "5000" });

    const result = await payAndCall(
      { agent, slug: serviceSlug, maxPrice: 1_000n },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("price_above_max");
    expect(result.error?.message).toMatch(/Nothing was spent/);
    await expectUnspent(agent.id, "10000");
    // It never presented a payment.
    expect(gateway.calls.filter((c) => c.paid)).toHaveLength(0);
  });

  it("refuses when the balance cannot cover the quote", async () => {
    const agent = await makeAgent({ balance: 500n });
    const gateway = fakeGateway({ quote: "1000" });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("insufficient_balance");
    await expectUnspent(agent.id, "500");
  });

  it("refuses a quote above the per-call cap", async () => {
    const agent = await makeAgent({ balance: 10_000n, perCallCap: 500n });
    const gateway = fakeGateway({ quote: "1000" });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("per_call_cap_exceeded");
    await expectUnspent(agent.id, "10000");
  });

  it("refuses a revoked agent", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    await revokeAgent(agent.id);
    const revoked = (await getAgentById(agent.id)) as AgentAccount;
    const gateway = fakeGateway();

    const result = await payAndCall(
      { agent: revoked, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("agent_revoked");
    await expectUnspent(agent.id, "10000");
  });

  it("refuses when the marketplace has no treasury to pay from", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway();

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl, treasuryIsConfigured: false }),
    );

    expect(result.error?.code).toBe("treasury_unconfigured");
    await expectUnspent(agent.id, "10000");
  });

  it("refuses when the gateway will not quote", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quoteStatus: 503 });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("quote_failed");
    await expectUnspent(agent.id, "10000");
  });

  it("refuses when the gateway is unreachable for a quote", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ throwOnQuote: true });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("quote_failed");
    await expectUnspent(agent.id, "10000");
  });
});

/* ------------------------------------------------- refunded after charging */

describe("payAndCall — money is returned when delivery fails", () => {
  it("refunds when the seller returns an error", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000", deliverStatus: 502 });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("upstream_failed");
    expect(result.refunded).toBe(true);
    expect(result.error?.message).toMatch(/refunded in full/);

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("10000");
    expect(await replayBalance(agent.id)).toBe(10_000n);
  });

  it("refunds when the gateway disappears mid-call", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000", throwOnDeliver: true });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({ fetchImpl: gateway.fetchImpl }),
    );

    expect(result.error?.code).toBe("upstream_failed");
    expect(result.refunded).toBe(true);
    expect((await getAgentById(agent.id))?.balance).toBe("10000");
  });

  it("refunds when the payment cannot be signed", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000" });

    const result = await payAndCall(
      { agent, slug: serviceSlug },
      deps({
        fetchImpl: gateway.fetchImpl,
        signPayment: async () => {
          throw new Error("key rejected");
        },
      }),
    );

    expect(result.error?.code).toBe("signing_failed");
    expect(result.refunded).toBe(true);
    expect((await getAgentById(agent.id))?.balance).toBe("10000");
    // Nothing was ever presented to the gateway.
    expect(gateway.calls.filter((c) => c.paid)).toHaveLength(0);
  });

  it("leaves a balanced ledger after a refund", async () => {
    const agent = await makeAgent({ balance: 10_000n });
    const gateway = fakeGateway({ quote: "1000", deliverStatus: 502 });
    await payAndCall({ agent, slug: serviceSlug }, deps({ fetchImpl: gateway.fetchImpl }));

    const entries = await ledgerFor(agent.id);
    expect(entries.map((e) => e.kind)).toEqual(["refund", "debit", "deposit"]);
    expect(await replayBalance(agent.id)).toBe(10_000n);
  });
});

/* ------------------------------------------------------------ concurrency */

describe("payAndCall — under contention", () => {
  it("never pays out more than the agent funded", async () => {
    // A balance covering exactly three calls, five attempted at once.
    const agent = await makeAgent({ balance: 3_000n });
    const gateway = fakeGateway({ quote: "1000" });
    const d = deps({ fetchImpl: gateway.fetchImpl });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => payAndCall({ agent, slug: serviceSlug }, d)),
    );

    const delivered = results.filter((r) => r.ok);
    const refused = results.filter((r) => r.error?.code === "insufficient_balance");

    expect(delivered).toHaveLength(3);
    expect(refused).toHaveLength(2);

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("0");
    expect(await replayBalance(agent.id)).toBe(0n);
  });
});
