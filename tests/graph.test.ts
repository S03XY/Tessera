import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearGraphPriceCache,
  assertSubgraphId,
  countGraphRows,
  executeSubgraphQuery,
  floorPriceTinybars,
  getSubgraphSchema,
  GraphNotConfiguredError,
  GraphQueryError,
  GRAPH_NETWORK_SUBGRAPH_ID,
  isSubgraphId,
  MESSARI_LENDING,
  readGraphPrice,
  searchSubgraphs,
  standardDeployment,
  trimGraphResult,
} from "@/lib/graph";

/**
 * The Graph is a paid upstream reached over the network, so the failure modes
 * matter more than the happy path: the gateway answers auth errors with HTTP
 * 200, a subgraph id is interpolated into a URL, and a missing comparison
 * price must never break a call the buyer already paid for.
 *
 * `fetch` is stubbed throughout. The one test that touches the real network is
 * marked and skips itself when offline.
 */

const KEY = "test-key";
const VALID_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  __clearGraphPriceCache();
});

/* ------------------------------------------------------------ subgraph ids */

describe("subgraph id validation", () => {
  it("accepts a real subgraph id", () => {
    expect(isSubgraphId(VALID_ID)).toBe(true);
    expect(isSubgraphId(GRAPH_NETWORK_SUBGRAPH_ID)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "abc"],
    ["path traversal", "../../admin"],
    ["slash injection", "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgV/evil"],
    ["query smuggling", `${VALID_ID}?key=leak`],
    ["base58 excluded chars", "0OIl".repeat(12)],
    ["whitespace", `  ${VALID_ID}  `],
  ])("rejects %s", (_label, value) => {
    expect(isSubgraphId(value)).toBe(false);
    expect(() => assertSubgraphId(value)).toThrow(GraphQueryError);
  });

  it("refuses to execute against a malformed id before making a request", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeSubgraphQuery("../evil", "{ x }", undefined, KEY)).rejects.toThrow(
      GraphQueryError,
    );
    // The guard must run before the network call, not after.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------- execution */

describe("executeSubgraphQuery", () => {
  it("returns data on success and sends the key as a bearer token", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { markets: [{ id: "1" }] } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await executeSubgraphQuery<{ markets: unknown[] }>(
      VALID_ID,
      "{ markets { id } }",
      undefined,
      KEY,
    );

    expect(data.markets).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://gateway.thegraph.com/api/subgraphs/id/${VALID_ID}`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("passes variables through when given", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await executeSubgraphQuery(VALID_ID, "query($n: Int!){ x(n:$n) }", { n: 5 }, KEY);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ n: 5 });
  });

  it("throws GraphNotConfiguredError when no key is set", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeSubgraphQuery(VALID_ID, "{ x }", undefined, "")).rejects.toThrow(
      GraphNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The gateway reports a bad key as HTTP 200 with an `errors` array. A status
   * check alone would treat that as success and hand the caller empty data.
   */
  it("treats a 200 carrying GraphQL errors as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) =>
        jsonResponse({ errors: [{ message: "auth error: malformed API key" }] }),
      ),
    );

    await expect(
      executeSubgraphQuery(VALID_ID, "{ x }", undefined, "bad"),
    ).rejects.toThrow(/malformed API key/);
  });

  it("treats a 200 with neither data nor errors as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({})));

    await expect(executeSubgraphQuery(VALID_ID, "{ x }", undefined, KEY)).rejects.toThrow(
      /no data/,
    );
  });

  it("surfaces a non-JSON body rather than crashing on the parse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    const error = (await executeSubgraphQuery(VALID_ID, "{ x }", undefined, KEY).catch(
      (e) => e,
    )) as GraphQueryError;
    expect(error).toBeInstanceOf(GraphQueryError);
    expect(error.status).toBe(502);
  });

  it("reports an HTTP error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ errors: [] }, 429)));

    const error = (await executeSubgraphQuery(VALID_ID, "{ x }", undefined, KEY).catch(
      (e) => e,
    )) as GraphQueryError;
    expect(error).toBeInstanceOf(GraphQueryError);
    expect(error.status).toBe(429);
  });

  it("turns a network failure into a 503 rather than an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const error = (await executeSubgraphQuery(VALID_ID, "{ x }", undefined, KEY).catch(
      (e) => e,
    )) as GraphQueryError;
    expect(error).toBeInstanceOf(GraphQueryError);
    expect(error.status).toBe(503);
  });
});

/* --------------------------------------------------------------- catalogue */

describe("searchSubgraphs", () => {
  const row = {
    id: VALID_ID,
    displayName: "Uniswap V3",
    description: "DEX",
    currentSignalledTokens: "9000",
    currentVersion: {
      subgraphDeployment: {
        ipfsHash: "Qm...",
        queryFeesAmount: "1234",
        network: { id: "mainnet" },
      },
    },
  };

  it("maps catalogue rows into candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { subgraphs: [row] } })));

    const found = await searchSubgraphs("uniswap", 5, KEY);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: VALID_ID,
      displayName: "Uniswap V3",
      signalledTokens: "9000",
      queryFeesAmount: "1234",
      network: "mainnet",
    });
  });

  it("queries the Graph Network subgraph, not the target subgraph", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { subgraphs: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await searchSubgraphs("lending", 5, KEY);

    expect(fetchMock.mock.calls[0][0]).toContain(GRAPH_NETWORK_SUBGRAPH_ID);
  });

  it("returns nothing for blank input without calling the network", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchSubgraphs("   ", 5, KEY)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps the limit into the range the gateway will serve", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { subgraphs: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await searchSubgraphs("x", 9999, KEY);
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.first).toBe(50);

    await searchSubgraphs("x", -3, KEY);
    body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.variables.first).toBe(1);
  });

  it("survives rows with missing nested fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) =>
        jsonResponse({
          data: {
            subgraphs: [
              { id: VALID_ID, displayName: null, description: null, currentVersion: null },
            ],
          },
        }),
      ),
    );

    const [candidate] = await searchSubgraphs("x", 5, KEY);
    expect(candidate.displayName).toBe("(unnamed)");
    expect(candidate.signalledTokens).toBe("0");
    expect(candidate.network).toBeNull();
  });
});

/* ------------------------------------------------------------------ schema */

describe("getSubgraphSchema", () => {
  const introspection = {
    data: {
      __schema: {
        types: [
          { name: "Market", kind: "OBJECT", fields: [{ name: "id" }, { name: "tvl" }] },
          { name: "Account", kind: "OBJECT", fields: [{ name: "id" }] },
          { name: "Query", kind: "OBJECT", fields: [{ name: "markets" }] },
          { name: "__Type", kind: "OBJECT", fields: [] },
          { name: "_Meta_", kind: "OBJECT", fields: [] },
          { name: "BigInt", kind: "SCALAR", fields: null },
        ],
      },
    },
  };

  it("extracts entities and their fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse(introspection)));

    const schema = await getSubgraphSchema(VALID_ID, KEY);

    expect(schema.entities).toEqual(["Account", "Market"]);
    expect(schema.fields.Market).toEqual(["id", "tvl"]);
  });

  it("excludes GraphQL machinery from the data model", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse(introspection)));

    const schema = await getSubgraphSchema(VALID_ID, KEY);

    // Introspection returns internals and scalars alongside the entities; an
    // agent writing a query must not be offered them as things to select.
    for (const excluded of ["Query", "__Type", "_Meta_", "BigInt"]) {
      expect(schema.entities).not.toContain(excluded);
    }
  });

  it("returns an empty model rather than throwing when a subgraph has no types", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: { __schema: {} } })));

    const schema = await getSubgraphSchema(VALID_ID, KEY);
    expect(schema.entities).toEqual([]);
  });
});

/* ----------------------------------------------------------- price oracle */

describe("readGraphPrice", () => {
  const challenge = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: { name: "USD Coin" },
      },
    ],
  };

  function challengeResponse(body: unknown) {
    return new Response(null, {
      status: 402,
      headers: {
        "payment-required": Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
      },
    });
  }

  it("decodes the challenge from the header, not the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => challengeResponse(challenge)));

    const price = await readGraphPrice(VALID_ID);

    expect(price).toEqual({
      amountAtomic: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetName: "USD Coin",
      network: "eip155:8453",
      payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
      decimals: 6,
    });
  });

  it("sends no authorization header — price discovery is free", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => challengeResponse(challenge));
    vi.stubGlobal("fetch", fetchMock);

    await readGraphPrice(VALID_ID);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBeUndefined();
  });

  /**
   * Every failure below must return null. A comparison price is decoration;
   * throwing here would fail a call the buyer has already paid for.
   */
  it("returns null for a malformed subgraph id without calling the network", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    expect(await readGraphPrice("nope")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the gateway does not answer 402", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => jsonResponse({ data: {} }, 200)));
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("returns null when the header is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => new Response(null, { status: 402 })));
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("returns null when the header is not valid base64 JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 402,
            headers: { "payment-required": "!!!not base64!!!" },
          }),
      ),
    );
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("returns null when the challenge omits a required field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => challengeResponse({ accepts: [{ amount: "10000" }] })),
    );
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("returns null when the challenge offers nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => challengeResponse({ accepts: [] })));
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("returns null when the network is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => {
        throw new Error("ENOTFOUND");
      }),
    );
    expect(await readGraphPrice(VALID_ID)).toBeNull();
  });

  it("caches a real answer so the paid path pays for one round trip", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => challengeResponse(challenge));
    vi.stubGlobal("fetch", fetchMock);

    const first = await readGraphPrice(VALID_ID);
    const second = await readGraphPrice(VALID_ID);

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A transient outage must not pin a null for the whole TTL — the next call
   * has to be free to succeed.
   */
  it("does not cache a failure", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => {
      throw new Error("ENOTFOUND");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await readGraphPrice(VALID_ID)).toBeNull();
    expect(await readGraphPrice(VALID_ID)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per subgraph", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => challengeResponse(challenge));
    vi.stubGlobal("fetch", fetchMock);

    await readGraphPrice(VALID_ID);
    await readGraphPrice(GRAPH_NETWORK_SUBGRAPH_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* --------------------------------------------------------------- pricing */

describe("floorPriceTinybars", () => {
  /**
   * $0.01 of upstream cost, HBAR at 5c, 30% markup.
   *   $0.01 = 1 cent = 0.2 ℏ at 5c        = 20,000,000 tinybars
   *   +30%                                = 26,000,000 tinybars
   */
  it("converts a real upstream cost into a floor price", () => {
    expect(floorPriceTinybars(10_000n, 5, 3_000)).toBe(26_000_000n);
  });

  it("charges cost exactly at a zero markup", () => {
    expect(floorPriceTinybars(10_000n, 5, 0)).toBe(20_000_000n);
  });

  it("scales linearly with upstream cost", () => {
    const one = floorPriceTinybars(10_000n, 5, 0);
    const ten = floorPriceTinybars(100_000n, 5, 0);
    expect(ten).toBe(one * 10n);
  });

  it("falls as HBAR gets more valuable", () => {
    const cheapHbar = floorPriceTinybars(10_000n, 5, 0);
    const dearHbar = floorPriceTinybars(10_000n, 20, 0);
    expect(dearHbar).toBe(cheapHbar / 4n);
  });

  it("handles a fractional HBAR price without floating point drift", () => {
    // 2.5 cents per HBAR: $0.01 buys 0.4 ℏ.
    expect(floorPriceTinybars(10_000n, 2.5, 0)).toBe(40_000_000n);
  });

  it("costs nothing when the upstream is free", () => {
    expect(floorPriceTinybars(0n, 5, 3_000)).toBe(0n);
  });

  it("accepts the amount as a string, as it arrives from a 402", () => {
    expect(floorPriceTinybars("10000", 5, 3_000)).toBe(26_000_000n);
  });

  it("returns a bigint, never a float", () => {
    expect(typeof floorPriceTinybars(12_345n, 7.3, 1_234)).toBe("bigint");
  });

  it.each([
    ["negative cost", () => floorPriceTinybars(-1n, 5, 0)],
    ["zero HBAR price", () => floorPriceTinybars(10_000n, 0, 0)],
    ["negative HBAR price", () => floorPriceTinybars(10_000n, -5, 0)],
    ["NaN HBAR price", () => floorPriceTinybars(10_000n, Number.NaN, 0)],
    ["negative markup", () => floorPriceTinybars(10_000n, 5, -1)],
    ["fractional markup", () => floorPriceTinybars(10_000n, 5, 1.5)],
  ])("rejects %s", (_label, call) => {
    expect(call).toThrow();
  });
});

/* ------------------------------------------------- standardized schemas ---- */

describe("standardized deployments", () => {
  it("resolves a deployment by slug", () => {
    const found = standardDeployment("aave-v3-base");
    expect(found?.subgraphId).toBe("D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9");
    expect(found?.schemaFamily).toBe("messari/lending");
  });

  it("returns null for an unknown slug", () => {
    expect(standardDeployment("does-not-exist")).toBeNull();
  });

  it("registers only well-formed subgraph ids", () => {
    for (const entry of MESSARI_LENDING) {
      expect(isSubgraphId(entry.subgraphId), entry.slug).toBe(true);
    }
  });

  it("spans more than one chain under one schema family", () => {
    // The composability claim is that one query shape crosses chains. If the
    // registry ever collapses to a single chain, that claim is no longer true.
    const chains = new Set(MESSARI_LENDING.map((entry) => entry.chain));
    expect(chains.size).toBeGreaterThan(1);
    expect(new Set(MESSARI_LENDING.map((e) => e.schemaFamily)).size).toBe(1);
  });

  it("has no duplicate slugs", () => {
    const slugs = MESSARI_LENDING.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

/* -------------------------------------------------------------- row counts */

describe("countGraphRows", () => {
  it("counts a single list", () => {
    expect(countGraphRows({ markets: [1, 2, 3] })).toBe(3);
  });

  it("sums across several lists", () => {
    expect(countGraphRows({ markets: [1, 2], accounts: [1] })).toBe(3);
  });

  it("counts an empty list as no rows", () => {
    expect(countGraphRows({ markets: [] })).toBe(0);
  });

  it("counts a scalar-only response as one row", () => {
    // `{ _meta { block { number } } }` returns no list but is still a result
    // the buyer paid for, so it must not meter as zero.
    expect(countGraphRows({ _meta: { block: { number: 123 } } })).toBe(1);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["a number", 7],
  ])("counts %s as no rows", (_label, value) => {
    expect(countGraphRows(value)).toBe(0);
  });
});

describe("trimGraphResult", () => {
  it("trims a named list to the budget and reports truncation", () => {
    const result = trimGraphResult({ markets: [1, 2, 3, 4, 5] }, 3);
    expect(result.data).toEqual({ markets: [1, 2, 3] });
    expect(result.rows).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("leaves a list already within budget untouched", () => {
    const result = trimGraphResult({ markets: [1, 2] }, 10);
    expect(result.data).toEqual({ markets: [1, 2] });
    expect(result.rows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("spends one budget across several lists rather than per list", () => {
    // The buyer paid for 4 rows total. Two lists of 3 must not yield 6.
    const result = trimGraphResult({ a: [1, 2, 3], b: [4, 5, 6] }, 4);
    expect(result.data).toEqual({ a: [1, 2, 3], b: [4] });
    expect(result.rows).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("keeps scalar fields alongside trimmed lists", () => {
    const result = trimGraphResult({ _meta: { block: 9 }, markets: [1, 2, 3] }, 2);
    expect(result.data).toEqual({ _meta: { block: 9 }, markets: [1, 2] });
  });

  it("empties every list at a zero budget", () => {
    const result = trimGraphResult({ markets: [1, 2] }, 0);
    expect(result.data).toEqual({ markets: [] });
    expect(result.rows).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("treats a negative budget as zero rather than slicing from the end", () => {
    // Array.slice(0, -1) would silently return all but the last element.
    const result = trimGraphResult({ markets: [1, 2, 3] }, -5);
    expect(result.data).toEqual({ markets: [] });
    expect(result.rows).toBe(0);
  });

  it("counts a scalar-only response as one row and does not trim it", () => {
    const data = { _meta: { block: { number: 123 } } };
    const result = trimGraphResult(data, 0);
    expect(result.data).toEqual(data);
    expect(result.rows).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a bare array", [1, 2, 3]],
  ])("passes %s through unchanged", (_label, value) => {
    expect(trimGraphResult(value, 2).data).toBe(value);
  });
});

/* ---------------------------------------------------------- live network -- */

describe("live: The Graph x402 gateway", () => {
  /**
   * The one test here that leaves the machine. It proves the price oracle is
   * real rather than a shape agreed with a mock — and it needs no API key,
   * which is the whole point. Skips itself when offline.
   */
  it("reads a real price from The Graph without paying or authenticating", async () => {
    let price;
    try {
      price = await readGraphPrice(VALID_ID);
    } catch {
      return; // offline
    }
    if (!price) return; // offline, or The Graph changed the rail

    expect(price.network).toBe("eip155:8453");
    expect(BigInt(price.amountAtomic)).toBeGreaterThan(0n);
    expect(price.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
