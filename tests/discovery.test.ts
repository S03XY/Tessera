import { beforeAll, describe, expect, it } from "vitest";
import { discoverServices, getServiceBySlug, listCategories, listSellers } from "@/lib/repo";

/**
 * Discovery is the piece an autonomous buyer depends on: if ranking or search
 * is wrong, the agent buys the wrong thing. Requires a seeded database.
 */

beforeAll(async () => {
  const services = await discoverServices({ limit: 1 });
  if (services.length === 0) {
    throw new Error(
      "No active services found. Run `npm run db:up && npm run db:reset` before the suite.",
    );
  }
});

describe("ranking", () => {
  it("returns matches cheapest first", async () => {
    const results = await discoverServices({ q: "forex" });
    expect(results.length).toBeGreaterThanOrEqual(3);

    const prices = results.map((service) => BigInt(service.price_amount));
    const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(prices).toEqual(sorted);
  });

  it("puts three competing FX sellers in price order", async () => {
    const results = await discoverServices({ category: "fx" });
    const sellers = results.map((service) => service.seller_name);
    expect(new Set(sellers).size).toBe(3);
    expect(results[0].seller_name).toBe("Northwind APIs"); // cheapest at 90000
  });
});

describe("search", () => {
  it.each([
    ["bitcoin price", "BTC Spot Price"],
    ["forex", "Open Exchange Rates"],
    ["tech news", "Hacker News Top Stories"],
    ["encyclopedia", "Wikipedia Extract"],
    ["temperature", "Weather Now"],
  ])("resolves the agent phrasing %o to %o", async (q, expected) => {
    const results = await discoverServices({ q });
    expect(results.map((service) => service.name)).toContain(expected);
  });

  it("returns nothing for a capability nobody sells", async () => {
    const results = await discoverServices({ q: "quantum teleportation scheduling" });
    expect(results).toEqual([]);
  });

  it("is not injectable through the query string", async () => {
    for (const q of ["'; DROP TABLE services; --", "%", "_", "\\", "' OR 1=1 --"]) {
      await expect(discoverServices({ q })).resolves.toBeInstanceOf(Array);
    }
    // The table survived.
    expect((await discoverServices({ limit: 1 })).length).toBe(1);
  });
});

describe("filters", () => {
  it("filters by metering unit", async () => {
    const perToken = await discoverServices({ unit: "per_token" });
    expect(perToken.length).toBeGreaterThan(0);
    expect(perToken.every((service) => service.price_unit === "per_token")).toBe(true);
  });

  it("filters by maximum price", async () => {
    const cheap = await discoverServices({ maxPrice: "1000" });
    expect(cheap.every((service) => BigInt(service.price_amount) <= 1000n)).toBe(true);
  });

  it("ignores a non-numeric max price rather than failing", async () => {
    await expect(discoverServices({ maxPrice: "abc" })).resolves.toBeInstanceOf(Array);
  });

  it("clamps an absurd limit", async () => {
    const results = await discoverServices({ limit: 100_000 });
    expect(results.length).toBeLessThanOrEqual(200);
  });

  it("excludes draft and suspended listings by default", async () => {
    const results = await discoverServices({ limit: 200 });
    expect(results.every((service) => service.status === "active")).toBe(true);
  });
});

describe("lookups", () => {
  it("finds a service by slug", async () => {
    const service = await getServiceBySlug("open-exchange-rates");
    expect(service?.name).toBe("Open Exchange Rates");
    expect(service?.seller_name).toBe("Northwind APIs");
  });

  it("returns null for an unknown slug", async () => {
    await expect(getServiceBySlug("nope-not-here")).resolves.toBeNull();
  });

  it("lists categories with counts", async () => {
    const categories = await listCategories();
    expect(categories.find((c) => c.category === "fx")?.count).toBe(3);
  });

  it("lists sellers with verified ones first", async () => {
    const sellers = await listSellers();
    const firstUnverified = sellers.findIndex((s) => s.verification_status !== "verified");
    const lastVerified = sellers.map((s) => s.verification_status).lastIndexOf("verified");
    if (firstUnverified !== -1) expect(lastVerified).toBeLessThan(firstUnverified);
  });
});
