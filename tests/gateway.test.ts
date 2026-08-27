import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end HTTP tests against a running gateway.
 *
 * Start the stack first:
 *   npm run db:up && npm run db:reset && npm run dev
 */

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

beforeAll(async () => {
  try {
    const response = await fetch(`${BASE}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
  } catch (err) {
    throw new Error(
      `Gateway is not reachable at ${BASE}. Start it with \`npm run dev\` ` +
        `(and \`npm run db:up\`) before running the suite. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
});

describe("402 quote", () => {
  it("answers an unpaid request with a spec-shaped PaymentRequired", async () => {
    const response = await fetch(`${BASE}/x402/open-exchange-rates`);
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const body = await response.json();
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toContain("/x402/open-exchange-rates");
    expect(body.resource.serviceName).toBe("Open Exchange Rates");
    expect(Array.isArray(body.accepts)).toBe(true);

    const [accept] = body.accepts;
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("hedera:testnet");
    expect(accept.asset).toBe("0.0.0");
    expect(accept.amount).toBe("90000");
    expect(accept.payTo).toMatch(/^\d+\.\d+\.\d+$/);
    expect(accept.maxTimeoutSeconds).toBeGreaterThan(0);
    // Sourced live from the facilitator's /supported, never hardcoded.
    expect(accept.extra.feePayer).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("quotes the seller's own account as payTo, not the marketplace", async () => {
    const [rates, weather] = await Promise.all([
      fetch(`${BASE}/x402/open-exchange-rates`).then((r) => r.json()),
      fetch(`${BASE}/x402/btc-spot-price`).then((r) => r.json()),
    ]);
    // Different sellers own these two listings.
    expect(rates.accepts[0].payTo).not.toBe(weather.accepts[0].payTo);
  });
});

describe("metered pricing", () => {
  it("scales the quote linearly with the declared token budget", async () => {
    const quote = async (units?: number) => {
      const url = new URL(`${BASE}/x402/wikipedia-extract`);
      if (units) url.searchParams.set("units", String(units));
      const body = await fetch(url).then((r) => r.json());
      return BigInt(body.accepts[0].amount);
    };

    const [one, fifty, fiveThousand] = await Promise.all([quote(), quote(50), quote(5000)]);

    expect(fifty).toBe(one * 50n);
    expect(fiveThousand).toBe(one * 5000n);
    // The headline claim: a big response really does cost more than a small one.
    expect(fiveThousand).toBeGreaterThan(fifty);
  });

  it("scales the quote with the declared row budget", async () => {
    const ten = await fetch(`${BASE}/x402/hn-top-stories?units=10`).then((r) => r.json());
    const five = await fetch(`${BASE}/x402/hn-top-stories?units=5`).then((r) => r.json());
    expect(BigInt(ten.accepts[0].amount)).toBe(BigInt(five.accepts[0].amount) * 2n);
  });

  it("bills a per_call service once no matter what budget is requested", async () => {
    const plain = await fetch(`${BASE}/x402/open-exchange-rates`).then((r) => r.json());
    const padded = await fetch(`${BASE}/x402/open-exchange-rates?units=500`).then((r) =>
      r.json(),
    );
    expect(padded.accepts[0].amount).toBe(plain.accepts[0].amount);
  });
});

describe("listing gate", () => {
  it("404s an unknown service", async () => {
    const response = await fetch(`${BASE}/x402/no-such-service`);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown_service");
  });

  it("refuses a seller whose deposit is below the minimum", async () => {
    const response = await fetch(`${BASE}/x402/underfunded-quote`);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("seller_underfunded");
  });
});

describe("payment header validation", () => {
  it.each([
    ["non-base64 junk", "@@@not base64@@@", /malformed_payment/],
    ["base64 of non-JSON", Buffer.from("nope").toString("base64"), /malformed_payment/],
    ["a v1 payload", encode({ x402Version: 1, accepted: {}, payload: {} }), /malformed_payment/],
    ["no accepted block", encode({ x402Version: 2, payload: {} }), /malformed_payment/],
    ["no scheme payload", encode({ x402Version: 2, accepted: {} }), /malformed_payment/],
  ])("rejects %s with 400", async (_label, header, expected) => {
    const response = await fetch(`${BASE}/x402/open-exchange-rates`, {
      headers: { "x-payment": header },
    });
    expect(response.status).toBe(400);
    expect((await response.text())).toMatch(expected);
  });

  it("never delivers a body when payment is invalid", async () => {
    const response = await fetch(`${BASE}/x402/open-exchange-rates`, {
      headers: { "x-payment": encode({ x402Version: 2, accepted: {}, payload: {} }) },
    });
    const text = await response.text();
    // 402, not 200 — and none of the upstream payload markers may appear.
    // ("rates" is not usable here: it occurs in the service description.)
    expect(response.status).toBe(402);
    expect(text).not.toContain("base_code");
    expect(text).not.toContain("time_last_update_unix");
    expect(text).not.toContain('"result":"success"');
  });
});

describe("invalid unit budgets", () => {
  it.each(["abc", "0", "-5", "1.5", "100001"])("rejects units=%s", async (units) => {
    const response = await fetch(`${BASE}/x402/wikipedia-extract?units=${units}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_units");
  });
});
