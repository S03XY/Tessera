import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_THRESHOLD,
  appraiseAgainstSchema,
  appraiseCandidates,
  conceptsOf,
  schemaVocabulary,
  singularize,
  tokenize,
  unverifiableAppraisal,
} from "@/lib/appraise";
import type { SubgraphSchema } from "@/lib/graph";

/**
 * The refusal is the point. An agent that pays for anything it can afford is
 * not reasoning, and these tests are mostly about the cases where it must
 * decline: an unrelated schema, an unreadable one, and a question that says
 * nothing.
 */

const LENDING_SCHEMA: SubgraphSchema = {
  entities: ["Market", "Account", "Borrow", "Deposit"],
  fields: {
    Market: [
      "id",
      "name",
      "inputToken",
      "totalValueLockedUSD",
      "totalBorrowBalanceUSD",
      "rates",
    ],
    Account: ["id", "borrowCount", "depositCount"],
    Borrow: ["id", "amount", "amountUSD", "asset"],
    Deposit: ["id", "amount", "amountUSD"],
  },
};

const NFT_SCHEMA: SubgraphSchema = {
  entities: ["Collection", "Token", "Sale"],
  fields: {
    Collection: ["id", "name", "symbol", "royaltyFee"],
    Token: ["id", "tokenId", "owner", "uri"],
    Sale: ["id", "price", "buyer", "seller"],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------- tokens */

describe("tokenize", () => {
  it("splits camelCase so schema fields meet plain words", () => {
    expect(tokenize("totalValueLockedUSD")).toEqual(["total", "value", "locked", "usd"]);
  });

  it("splits snake_case and punctuation", () => {
    expect(tokenize("total_borrow_balance")).toEqual(["total", "borrow", "balance"]);
    expect(tokenize("what's the TVL, in USD?")).toEqual(["what", "s", "the", "tvl", "in", "usd"]);
  });

  it("keeps runs of capitals together with the word that follows", () => {
    expect(tokenize("USDPrice")).toEqual(["usd", "price"]);
  });

  it("returns nothing for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! ???")).toEqual([]);
  });
});

describe("singularize", () => {
  it.each([
    ["markets", "market"],
    ["borrows", "borrow"],
    ["accounts", "account"],
    ["utilities", "utility"],
  ])("reduces %s to %s", (input, expected) => {
    expect(singularize(input)).toBe(expected);
  });

  it.each(["gas", "status", "address", "basis", "analysis", "usd", "id"])(
    "leaves %s alone rather than mangling it",
    (word) => {
      expect(singularize(word)).toBe(word);
    },
  );
});

describe("conceptsOf", () => {
  it("keeps the words that say what data is wanted", () => {
    expect(conceptsOf("what is the total borrow balance")).toEqual(["borrow", "balance"]);
  });

  it("drops stopwords and bare numbers", () => {
    expect(conceptsOf("show me the top 10 markets")).toEqual(["market"]);
  });

  it("de-duplicates after singularising", () => {
    expect(conceptsOf("markets and market data")).toEqual(["market"]);
  });

  it("returns nothing for a question made only of stopwords", () => {
    expect(conceptsOf("what is the latest")).toEqual([]);
  });
});

describe("schemaVocabulary", () => {
  it("covers entity names and their field names", () => {
    const vocabulary = schemaVocabulary(LENDING_SCHEMA);
    expect(vocabulary.has("market")).toBe(true);
    expect(vocabulary.has("borrow")).toBe(true);
    // From totalValueLockedUSD, via camelCase splitting.
    expect(vocabulary.has("locked")).toBe(true);
    expect(vocabulary.has("usd")).toBe(true);
  });

  it("is empty for an empty schema", () => {
    expect(schemaVocabulary({ entities: [], fields: {} }).size).toBe(0);
  });

  it("tolerates an entity with no field list", () => {
    const vocabulary = schemaVocabulary({ entities: ["Orphan"], fields: {} });
    expect(vocabulary.has("orphan")).toBe(true);
  });
});

/* ------------------------------------------------------------- appraisal */

const LISTING = { slug: "aave-v3", name: "Aave V3", subgraphId: "x" };

describe("appraiseAgainstSchema", () => {
  it("accepts a question the schema can express", () => {
    const result = appraiseAgainstSchema(
      "total borrow balance across markets",
      LENDING_SCHEMA,
      LISTING,
    );

    expect(result.canAnswer).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(ANSWER_THRESHOLD);
    expect(result.matched).toContain("borrow");
    expect(result.matched).toContain("market");
  });

  /** The load-bearing case: a real schema that simply is not about this. */
  it("refuses a question the schema cannot express", () => {
    const result = appraiseAgainstSchema(
      "what is the borrow balance for lending markets",
      NFT_SCHEMA,
      LISTING,
    );

    expect(result.canAnswer).toBe(false);
    expect(result.missing).toContain("borrow");
    expect(result.reason).toMatch(/Not paying for this/);
  });

  it("names the missing concepts in the refusal, not just a score", () => {
    const result = appraiseAgainstSchema("royalty fee for collections", LENDING_SCHEMA, LISTING);

    expect(result.canAnswer).toBe(false);
    expect(result.reason).toMatch(/royalty|collection/);
  });

  it("refuses a question with no concepts rather than scoring it as perfect", () => {
    // 0 of 0 concepts matched is arithmetically 100%; it must not read as one.
    const result = appraiseAgainstSchema("what is the latest", LENDING_SCHEMA, LISTING);

    expect(result.canAnswer).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reason).toMatch(/no searchable concepts/);
  });

  it("refuses everything against an empty schema", () => {
    const result = appraiseAgainstSchema(
      "borrow balance",
      { entities: [], fields: {} },
      LISTING,
    );
    expect(result.canAnswer).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("matches a concept that appears only as a stem inside a field name", () => {
    // "borrow" lives in totalBorrowBalanceUSD, not as a field of its own.
    const result = appraiseAgainstSchema("borrow", LENDING_SCHEMA, LISTING);
    expect(result.matched).toContain("borrow");
  });

  it("reports confidence as a share of the question, not of the schema", () => {
    const result = appraiseAgainstSchema("borrow royalty", LENDING_SCHEMA, LISTING);
    expect(result.confidence).toBeCloseTo(0.5, 5);
  });
});

describe("unverifiableAppraisal", () => {
  it("says a plain endpoint could not be checked instead of claiming it was", () => {
    const result = unverifiableAppraisal({ slug: "weather", name: "Weather Now" });

    expect(result.unverified).toBe(true);
    expect(result.subgraphId).toBeNull();
    expect(result.reason).toMatch(/publishes no schema/);
    // It stays buyable — the marketplace predates schemas and still works.
    expect(result.canAnswer).toBe(true);
  });
});

/* --------------------------------------------------------------- verdict */

function schemaResponse(schema: SubgraphSchema) {
  const types = schema.entities.map((entity) => ({
    name: entity,
    kind: "OBJECT",
    fields: (schema.fields[entity] ?? []).map((name) => ({ name })),
  }));
  return new Response(JSON.stringify({ data: { __schema: { types } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const GRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

describe("appraiseCandidates", () => {
  it("chooses the first candidate whose schema can answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => schemaResponse(LENDING_SCHEMA)),
    );

    const verdict = await appraiseCandidates(
      "total borrow balance in markets",
      [{ slug: "aave", name: "Aave", upstreamKind: "graph_subgraph", upstreamRef: GRAPH_ID }],
      "key",
    );

    expect(verdict.refused).toBe(false);
    expect(verdict.chosen?.slug).toBe("aave");
  });

  it("refuses when no candidate can answer, and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => schemaResponse(NFT_SCHEMA)),
    );

    const verdict = await appraiseCandidates(
      "total borrow balance in lending markets",
      [{ slug: "nfts", name: "NFTs", upstreamKind: "graph_subgraph", upstreamRef: GRAPH_ID }],
      "key",
    );

    expect(verdict.refused).toBe(true);
    expect(verdict.chosen).toBeNull();
    expect(verdict.refusalReason).toMatch(/none can answer/);
  });

  it("appraises every candidate so the trace shows what was rejected", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => {
        call += 1;
        return schemaResponse(call === 1 ? NFT_SCHEMA : LENDING_SCHEMA);
      }),
    );

    const verdict = await appraiseCandidates(
      "borrow balance markets",
      [
        { slug: "nfts", name: "NFTs", upstreamKind: "graph_subgraph", upstreamRef: GRAPH_ID },
        { slug: "aave", name: "Aave", upstreamKind: "graph_subgraph", upstreamRef: GRAPH_ID },
      ],
      "key",
    );

    expect(verdict.appraisals).toHaveLength(2);
    expect(verdict.appraisals[0].canAnswer).toBe(false);
    expect(verdict.chosen?.slug).toBe("aave");
  });

  /** An unreadable schema is not a schema that failed to match. */
  it("does not pay blind when a schema cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const verdict = await appraiseCandidates(
      "borrow balance",
      [{ slug: "aave", name: "Aave", upstreamKind: "graph_subgraph", upstreamRef: GRAPH_ID }],
      "key",
    );

    expect(verdict.refused).toBe(true);
    expect(verdict.appraisals[0].unverified).toBe(true);
    expect(verdict.appraisals[0].reason).toMatch(/Not paying blind/);
  });

  it("marks plain HTTP listings unverified without calling The Graph", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await appraiseCandidates(
      "weather in delhi",
      [{ slug: "weather", name: "Weather", upstreamKind: "http", upstreamRef: null }],
      "key",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(verdict.appraisals[0].unverified).toBe(true);
    expect(verdict.refused).toBe(false);
  });

  it("treats a graph listing missing its subgraph id as unverifiable", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await appraiseCandidates(
      "borrow",
      [{ slug: "broken", name: "Broken", upstreamKind: "graph_subgraph", upstreamRef: null }],
      "key",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(verdict.appraisals[0].unverified).toBe(true);
  });

  it("refuses with an explanation when there is nothing to appraise", async () => {
    const verdict = await appraiseCandidates("anything", [], "key");

    expect(verdict.refused).toBe(true);
    expect(verdict.refusalReason).toMatch(/No candidate listings/);
  });
});
