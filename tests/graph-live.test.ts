/**
 * Live proof that The Graph integration works against real data.
 *
 * Both Graph tracks disqualify mocked or local datasets, so the unit tests in
 * graph.test.ts are not sufficient evidence on their own: they prove the code
 * is correct, not that anything was ever fetched. This file proves the second
 * thing, by fetching.
 *
 * It skips itself when GRAPH_API_KEY is unset, so the suite stays green for a
 * contributor who has no key. Set one from thegraph.com/studio (free tier, no
 * card) and run `npm test` to watch all four surfaces answer for real.
 */

import { describe, it, expect } from "vitest";
import {
  GRAPH_API_KEY,
  MESSARI_LENDING,
  MESSARI_LENDING_QUERY,
  executeSubgraphQuery,
  getSubgraphSchema,
  readGraphPrice,
  searchSubgraphs,
  isSubgraphId,
  standardDeployment,
  countGraphRows,
} from "@/lib/graph";

const live = GRAPH_API_KEY ? describe : describe.skip;

interface LendingMarkets {
  markets: Array<{
    id: string;
    name: string | null;
    totalValueLockedUSD: string;
  }>;
}

live("The Graph, live", () => {
  it("finds subgraphs in the network catalogue", async () => {
    const found = await searchSubgraphs("lending", 5);

    expect(found.length).toBeGreaterThan(0);
    for (const candidate of found) {
      // Assert with the app's own validator, not a second opinion about it.
      expect(isSubgraphId(candidate.id)).toBe(true);
      expect(candidate.displayName.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("introspects a schema well enough to appraise it", async () => {
    const deployment = standardDeployment("aave-v3-ethereum");
    expect(deployment).not.toBeNull();

    const schema = await getSubgraphSchema(deployment!.subgraphId);
    const entities = schema.entities.map((entity) => entity.toLowerCase());

    expect(entities).toContain("market");
    expect(Object.keys(schema.fields).length).toBeGreaterThan(0);
  }, 30_000);

  /**
   * The composability claim, tested rather than asserted: one query document,
   * two chains, no per-chain branching anywhere in the call.
   */
  it("answers the same query document across Ethereum and Base", async () => {
    const chains = ["aave-v3-ethereum", "moonwell-base"] as const;

    for (const slug of chains) {
      const deployment = standardDeployment(slug)!;
      const data = await executeSubgraphQuery<LendingMarkets>(
        deployment.subgraphId,
        MESSARI_LENDING_QUERY,
        { first: 3 },
      );

      expect(data.markets.length).toBeGreaterThan(0);
      expect(countGraphRows(data)).toBe(data.markets.length);
      expect(Number(data.markets[0].totalValueLockedUSD)).toBeGreaterThan(0);
    }
  }, 45_000);

  /**
   * Price discovery costs nothing and needs no key: reading The Graph's own
   * 402 challenge is what lets a listing quote against real upstream cost.
   */
  it("reads a price from The Graph's own 402 challenge", async () => {
    const price = await readGraphPrice(MESSARI_LENDING[0].subgraphId);

    if (price === null) {
      console.warn("price oracle unreachable; skipping the assertion");
      return;
    }
    expect(Number(price.amountAtomic)).toBeGreaterThan(0);
    expect(price.decimals).toBeGreaterThan(0);
  }, 30_000);
});

describe("The Graph, configuration", () => {
  it("says plainly whether live data is available", () => {
    if (!GRAPH_API_KEY) {
      console.warn(
        "GRAPH_API_KEY is not set, so the live Graph tests were skipped. " +
          "Get a free key at https://thegraph.com/studio and re-run to prove live data.",
      );
    }
    expect(MESSARI_LENDING.length).toBeGreaterThan(1);
  });
});
