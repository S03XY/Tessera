import { beforeAll, afterAll, describe, expect, it } from "vitest";

/**
 * The seller gate. This is the acceptance test for the World ID track:
 * an unverified account cannot list, and neither can an underfunded one.
 */

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// Account ids are resolved from the database rather than hardcoded, because
// scripts/provision.mjs replaces the seeded ids with real testnet accounts.
let VERIFIED_FUNDED = "";
let VERIFIED_SHORT = "";
let UNVERIFIED = "";
const UNKNOWN = "0.0.9999999";

async function accountOf(displayName: string): Promise<string> {
  const { queryOne } = await import("@/lib/db");
  const row = await queryOne<{ account_id: string }>(
    `SELECT account_id FROM sellers WHERE display_name = $1`,
    [displayName],
  );
  if (!row) throw new Error(`fixture seller "${displayName}" missing — run npm run db:reset`);
  return row.account_id;
}

const created: string[] = [];

function listing(accountId: string, name: string, endpoint = "https://api.coinbase.com/v2/prices/BTC-USD/spot") {
  return {
    account_id: accountId,
    name,
    description: "A listing created by the automated gate test suite.",
    category: "test",
    endpoint_url: endpoint,
    price_amount: "100000",
    price_unit: "per_call",
    keywords: ["gate", "test"],
  };
}

async function create(body: object) {
  const response = await fetch(`${BASE}/api/services/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const response = await fetch(`${BASE}/api/health`);
  if (!response.ok) throw new Error(`Gateway not reachable at ${BASE}. Run npm run dev.`);

  [VERIFIED_FUNDED, VERIFIED_SHORT, UNVERIFIED] = await Promise.all([
    accountOf("Northwind APIs"),
    accountOf("Lowline Metrics"),
    accountOf("Unregistered Labs"),
  ]);
});

afterAll(async () => {
  for (const slug of created) {
    await fetch(`${BASE}/api/test/service/${slug}`, { method: "DELETE" }).catch(() => {});
  }
});

describe("listing gate — refuses", () => {
  it("an account that is not a registered seller", async () => {
    const { status, body } = await create(listing(UNKNOWN, "Ghost Feed"));
    expect(status).toBe(403);
    expect(body.error).toBe("not_a_seller");
  });

  it("a registered seller who has not passed Selfie Check", async () => {
    const { status, body } = await create(listing(UNVERIFIED, "Unverified Feed"));
    expect(status).toBe(403);
    expect(body.error).toBe("not_verified");
    expect(body.message).toMatch(/Selfie Check/);
  });

  it("a verified seller whose deposit is below the minimum", async () => {
    const { status, body } = await create(listing(VERIFIED_SHORT, "Lowline Extra"));
    expect(status).toBe(403);
    expect(body.error).toBe("deposit_too_low");
    expect(BigInt(body.held)).toBeLessThan(BigInt(body.required));
  });
});

describe("listing gate — endpoint safety", () => {
  it.each([
    ["loopback", "http://localhost:5433/health"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private range", "http://10.0.0.5/internal"],
    ["file protocol", "file:///etc/passwd"],
  ])("refuses a %s endpoint even from a good seller", async (_label, endpoint) => {
    const { status, body } = await create(
      listing(VERIFIED_FUNDED, `Probe ${Math.random().toString(36).slice(2, 7)}`, endpoint),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("unsafe_endpoint");
  });
});

describe("listing gate — validation", () => {
  // Built inside the test: the account ids are not known at collection time.
  it.each([
    ["missing name", () => ({ account_id: VERIFIED_FUNDED })],
    ["short description", () => ({ ...listing(VERIFIED_FUNDED, "X Feed"), description: "short" })],
    ["bad price", () => ({ ...listing(VERIFIED_FUNDED, "Y Feed"), price_amount: "-5" })],
    ["bad unit", () => ({ ...listing(VERIFIED_FUNDED, "Z Feed"), price_unit: "per_gigabyte" })],
  ])("refuses %s", async (_label, build) => {
    const { status } = await create(build());
    expect(status).toBe(400);
  });
});

describe("listing gate — allows", () => {
  it("a verified, funded seller with a public endpoint", async () => {
    const name = `Gate Suite Feed ${Date.now()}`;
    const { status, body } = await create(listing(VERIFIED_FUNDED, name));
    expect(status).toBe(201);
    expect(body.service.slug).toMatch(/^gate-suite-feed/);
    created.push(body.service.slug);

    // And it is immediately discoverable and payable.
    const discovery = await fetch(
      `${BASE}/api/services?q=${encodeURIComponent("gate")}`,
    ).then((r) => r.json());
    expect(discovery.services.some((s: { slug: string }) => s.slug === body.service.slug)).toBe(
      true,
    );

    const quote = await fetch(`${BASE}/x402/${body.service.slug}`);
    expect(quote.status).toBe(402);
  });
});
