/**
 * The Graph — catalogue, schema, price discovery and query execution.
 *
 * Four of The Graph's own surfaces are used, deliberately, because each one
 * answers a question the marketplace actually has to ask:
 *
 *   1. The Graph Network subgraph  — what data exists, and is anyone using it?
 *   2. GraphQL introspection       — can this subgraph answer my question?
 *   3. The Subgraph Gateway        — execute the query and get the data.
 *   4. The Graph's x402 gateway    — what would this have cost paid directly?
 *
 * Everything here is plain HTTP. The Graph also publishes an MCP server for
 * (1) and (2), but it speaks SSE, and holding a streamed session open inside a
 * short-lived serverless invocation trades a real timeout risk for no extra
 * capability — the same facts are queryable over the gateway this module
 * already talks to.
 *
 * Surface (4) is free: reading a 402 challenge costs nothing and needs no key,
 * which is exactly what makes it usable as a price oracle rather than a
 * purchase.
 */

const GRAPH_GATEWAY = "https://gateway.thegraph.com/api";

/**
 * The Graph Network subgraph on Arbitrum — the catalogue of every published
 * subgraph, queried like any other subgraph.
 */
export const GRAPH_NETWORK_SUBGRAPH_ID =
  "DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp";

export const GRAPH_API_KEY = process.env.GRAPH_API_KEY ?? "";

/** Reads and executions need a key; price discovery does not. */
export const graphConfigured = Boolean(GRAPH_API_KEY);

const GRAPH_TIMEOUT_MS = 20_000;

export class GraphNotConfiguredError extends Error {
  constructor() {
    super(
      "GRAPH_API_KEY is not set. Create a free key at https://thegraph.com/studio " +
        "(100,000 queries/month, no card).",
    );
    this.name = "GraphNotConfiguredError";
  }
}

export class GraphQueryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = "GraphQueryError";
  }
}

/* ------------------------------------------------------------------ shared */

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = GRAPH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GraphQueryError(`The Graph is unreachable: ${reason}`, 503);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes a GraphQL document against a subgraph through the gateway.
 *
 * The gateway answers auth failures with HTTP 200 and an `errors` array, so a
 * status check alone would let "malformed API key" through as a successful
 * response carrying no data. Both are treated as failures here.
 */
export async function executeSubgraphQuery<T = unknown>(
  subgraphId: string,
  query: string,
  variables?: Record<string, unknown>,
  apiKey: string = GRAPH_API_KEY,
): Promise<T> {
  if (!apiKey) throw new GraphNotConfiguredError();
  assertSubgraphId(subgraphId);

  const response = await postJson(
    `${GRAPH_GATEWAY}/subgraphs/id/${subgraphId}`,
    variables ? { query, variables } : { query },
    { authorization: `Bearer ${apiKey}` },
  );

  const text = await response.text();
  let parsed: { data?: T; errors?: Array<{ message?: string }> };
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new GraphQueryError(
      `The Graph returned non-JSON (${response.status})`,
      response.status,
      text.slice(0, 400),
    );
  }

  if (!response.ok) {
    throw new GraphQueryError(
      `The Graph returned ${response.status}`,
      response.status,
      parsed.errors,
    );
  }

  if (parsed.errors?.length) {
    const first = parsed.errors[0]?.message ?? "query failed";
    throw new GraphQueryError(`The Graph rejected the query: ${first}`, 200, parsed.errors);
  }

  if (parsed.data === undefined || parsed.data === null) {
    throw new GraphQueryError("The Graph returned no data", 200);
  }

  return parsed.data;
}

/**
 * A subgraph id is a base58 CIDv0-style identifier. Validated before it is
 * interpolated into a URL so a crafted listing cannot reach another path on
 * the gateway host.
 */
const SUBGRAPH_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function isSubgraphId(value: string): boolean {
  return SUBGRAPH_ID_RE.test(value);
}

export function assertSubgraphId(value: string): void {
  if (!isSubgraphId(value)) {
    throw new GraphQueryError(`not a subgraph id: ${JSON.stringify(value)}`, 400);
  }
}

/* --------------------------------------------------------------- catalogue */

export interface SubgraphCandidate {
  id: string;
  displayName: string;
  description: string | null;
  /** Curation signal in GRT — the market's own view of whether this is real. */
  signalledTokens: string;
  /** Lifetime queries served. A dead subgraph has none. */
  queryFeesAmount: string;
  network: string | null;
  schemaFamily: string | null;
}

interface NetworkSubgraphRow {
  id: string;
  displayName: string | null;
  description: string | null;
  currentSignalledTokens: string | null;
  currentVersion: {
    subgraphDeployment: {
      ipfsHash: string | null;
      queryFeesAmount: string | null;
      network: { id: string } | null;
    } | null;
  } | null;
}

const SEARCH_QUERY = `
  query TollgateSubgraphSearch($text: String!, $first: Int!) {
    subgraphs(
      first: $first
      orderBy: currentSignalledTokens
      orderDirection: desc
      where: { active: true, displayName_contains_nocase: $text }
    ) {
      id
      displayName
      description
      currentSignalledTokens
      currentVersion {
        subgraphDeployment {
          ipfsHash
          queryFeesAmount
          network { id }
        }
      }
    }
  }`;

/**
 * Searches the published catalogue by name, ordered by curation signal.
 *
 * Signal is used as the ranking key rather than recency because it is the one
 * number on the network that costs somebody money to be wrong about — it is
 * the closest thing to "is this subgraph real" the catalogue exposes.
 */
export async function searchSubgraphs(
  text: string,
  limit = 10,
  apiKey: string = GRAPH_API_KEY,
): Promise<SubgraphCandidate[]> {
  const needle = text.trim();
  if (!needle) return [];

  const first = Math.min(Math.max(limit, 1), 50);
  const data = await executeSubgraphQuery<{ subgraphs: NetworkSubgraphRow[] }>(
    GRAPH_NETWORK_SUBGRAPH_ID,
    SEARCH_QUERY,
    { text: needle, first },
    apiKey,
  );

  return (data.subgraphs ?? []).map((row) => ({
    id: row.id,
    displayName: row.displayName ?? "(unnamed)",
    description: row.description,
    signalledTokens: row.currentSignalledTokens ?? "0",
    queryFeesAmount: row.currentVersion?.subgraphDeployment?.queryFeesAmount ?? "0",
    network: row.currentVersion?.subgraphDeployment?.network?.id ?? null,
    schemaFamily: null,
  }));
}

/* ------------------------------------------------------------------ schema */

const INTROSPECTION_QUERY = `
  query TollgateIntrospect {
    __schema {
      queryType { name }
      types {
        name
        kind
        fields { name type { name kind ofType { name kind } } }
      }
    }
  }`;

export interface SubgraphSchema {
  /** Entity type names an agent may query, excluding GraphQL internals. */
  entities: string[];
  /** Field names per entity, so a query can be written against reality. */
  fields: Record<string, string[]>;
}

/**
 * Reads a subgraph's schema by GraphQL introspection.
 *
 * This is what lets the buyer agent write a query it has never seen before
 * instead of replaying a hardcoded one — and, more importantly, lets it decide
 * that a subgraph *cannot* answer the question and refuse to pay.
 */
export async function getSubgraphSchema(
  subgraphId: string,
  apiKey: string = GRAPH_API_KEY,
): Promise<SubgraphSchema> {
  const data = await executeSubgraphQuery<{
    __schema: {
      types: Array<{
        name: string | null;
        kind: string;
        fields: Array<{ name: string }> | null;
      }>;
    };
  }>(subgraphId, INTROSPECTION_QUERY, undefined, apiKey);

  const entities: string[] = [];
  const fields: Record<string, string[]> = {};

  for (const type of data.__schema?.types ?? []) {
    if (!type.name || type.kind !== "OBJECT") continue;
    // Introspection returns the machinery as well as the data model.
    if (type.name.startsWith("__")) continue;
    if (type.name === "Query" || type.name === "Subscription") continue;
    if (type.name === "_Meta_" || type.name === "_Block_") continue;

    entities.push(type.name);
    fields[type.name] = (type.fields ?? []).map((field) => field.name);
  }

  entities.sort();
  return { entities, fields };
}

/* --------------------------------------------------- x402 price discovery */

export interface GraphPrice {
  /** Base units of `asset`. USDC is 6 decimals, so 10000 = $0.01. */
  amountAtomic: string;
  asset: string;
  assetName: string | null;
  network: string;
  payTo: string;
  decimals: number;
}

/** USDC on Base is 6 decimals. The challenge does not state this, so it is pinned. */
const USDC_DECIMALS = 6;

/**
 * A subgraph's list price does not move between calls, and this read happens
 * while a buyer is waiting, so it is cached and given a short leash.
 */
const priceCache = new Map<string, { value: GraphPrice | null; fetchedAt: number }>();
const PRICE_TTL_MS = 10 * 60_000;
const PRICE_TIMEOUT_MS = 4_000;

/** Test seam: the cache is module state and would otherwise leak between cases. */
export function __clearGraphPriceCache(): void {
  priceCache.clear();
}

/**
 * Asks The Graph's own x402 gateway what a query costs, without paying it.
 *
 * A 402 challenge is public: no key, no wallet, no settlement. That makes it a
 * free price oracle, and it is the honest way for a marketplace to show a
 * buyer what the same data would have cost bought directly — the number comes
 * from the supplier, not from us.
 *
 * Returns null rather than throwing: a missing comparison price is a cosmetic
 * loss, and must never fail a call the buyer has already paid for.
 */
export async function readGraphPrice(subgraphId: string): Promise<GraphPrice | null> {
  if (!isSubgraphId(subgraphId)) return null;

  const cached = priceCache.get(subgraphId);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.value;

  let response: Response;
  try {
    response = await postJson(
      `${GRAPH_GATEWAY}/x402/subgraphs/id/${subgraphId}`,
      { query: "{ _meta { block { number } } }" },
      {},
      // This sits on the paid request path purely to enrich a receipt, so it
      // gets a fraction of the normal budget: late is the same as absent.
      PRICE_TIMEOUT_MS,
    );
  } catch {
    return null;
  }

  if (response.status !== 402) return null;

  // The challenge travels in the header, not the body: the response is empty.
  const header = response.headers.get("payment-required");
  if (!header) return null;

  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: Array<{
        amount?: string;
        asset?: string;
        network?: string;
        payTo?: string;
        extra?: { name?: string };
      }>;
    };

    const accepted = decoded.accepts?.[0];
    if (!accepted?.amount || !accepted.asset || !accepted.network || !accepted.payTo) {
      return null;
    }

    const price: GraphPrice = {
      amountAtomic: accepted.amount,
      asset: accepted.asset,
      assetName: accepted.extra?.name ?? null,
      network: accepted.network,
      payTo: accepted.payTo,
      decimals: USDC_DECIMALS,
    };

    // Only a real answer is cached. A transient failure must not pin a null
    // for ten minutes.
    priceCache.set(subgraphId, { value: price, fetchedAt: Date.now() });
    return price;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- pricing */

/**
 * HBAR price in US cents, used only to convert an upstream dollar cost into a
 * floor price. Configurable because it is a market rate, and stated rather
 * than silently assumed — nothing here pretends to be an oracle.
 */
export const HBAR_CENTS = Number(process.env.HBAR_PRICE_CENTS ?? "5");

/** Default margin over cost on resold data: 30%. */
export const DEFAULT_MARKUP_BPS = 3_000;

/**
 * The least a Graph-backed listing may be sold for, in tinybars.
 *
 * Reselling below cost is the one pricing mistake a marketplace cannot absorb,
 * because every call loses money and volume makes it worse. So the floor is
 * derived from what the supplier actually charges — read from their own 402 —
 * rather than picked, and seeding refuses to list anything under it.
 *
 * All integer arithmetic: `costAtomic` is USDC base units (6 decimals) and the
 * result is tinybars (8 decimals), so a float here would be a rounding error
 * with money attached.
 */
export function floorPriceTinybars(
  costAtomic: bigint | string,
  hbarCents: number = HBAR_CENTS,
  markupBps: number = DEFAULT_MARKUP_BPS,
): bigint {
  const cost = typeof costAtomic === "bigint" ? costAtomic : BigInt(costAtomic);
  if (cost < 0n) throw new Error("upstream cost cannot be negative");
  if (!Number.isFinite(hbarCents) || hbarCents <= 0) {
    throw new Error("HBAR price must be a positive number of cents");
  }
  if (!Number.isInteger(markupBps) || markupBps < 0) {
    throw new Error("markup must be a non-negative whole number of basis points");
  }

  // cost is USDC base units: 1_000_000 = $1.00 = 100 cents.
  // centsScaled = cost * 100 keeps two more digits of precision before dividing.
  const centsScaled = cost * 100n;

  // tinybars = (cents / hbarCents) * 1e8, with the markup applied.
  // hbarCents may be fractional, so scale it to a whole number first.
  const rateScale = 1_000_000n;
  const hbarCentsScaled = BigInt(Math.round(hbarCents * Number(rateScale)));

  const withMarkup = centsScaled * BigInt(10_000 + markupBps);

  return (withMarkup * rateScale * 100_000_000n) / (hbarCentsScaled * 10_000n * 1_000_000n);
}

/* ------------------------------------------------- standardized schemas ---- */

export interface StandardDeployment {
  slug: string;
  protocol: string;
  chain: string;
  subgraphId: string;
  schemaFamily: string;
  schemaVersion: string;
}

/**
 * Messari's standardized lending schema, across chains.
 *
 * These are the "standardized schemas" the composability story rests on: one
 * query document answers all of them, because the schema is a contract the
 * deployments agree to rather than something each publisher invents. That is
 * what makes a marketplace listing meaningful — a buyer asking for "lending
 * TVL" does not care which chain answers.
 */
export const MESSARI_LENDING: StandardDeployment[] = [
  {
    slug: "aave-v3-ethereum",
    protocol: "Aave V3",
    chain: "mainnet",
    subgraphId: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
    schemaFamily: "messari/lending",
    schemaVersion: "3.1.0",
  },
  {
    slug: "aave-v3-base",
    protocol: "Aave V3",
    chain: "base",
    subgraphId: "D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9",
    schemaFamily: "messari/lending",
    schemaVersion: "3.1.0",
  },
  {
    slug: "aave-v3-arbitrum",
    protocol: "Aave V3",
    chain: "arbitrum-one",
    subgraphId: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
    schemaFamily: "messari/lending",
    schemaVersion: "3.1.0",
  },
  {
    slug: "aave-v2-ethereum",
    protocol: "Aave V2",
    chain: "mainnet",
    subgraphId: "C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j",
    schemaFamily: "messari/lending",
    schemaVersion: "2.0.1",
  },
];

export function standardDeployment(slug: string): StandardDeployment | null {
  return MESSARI_LENDING.find((entry) => entry.slug === slug) ?? null;
}

/**
 * One document, every Messari lending deployment. The point of a standardized
 * schema is that this string does not change per chain.
 */
export const MESSARI_LENDING_QUERY = `
  query TollgateLendingMarkets($first: Int!) {
    markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      name
      inputToken { symbol }
      totalValueLockedUSD
      totalBorrowBalanceUSD
      rates(first: 4) { side type rate }
    }
  }`;

/* -------------------------------------------------------------- row counts */

/**
 * Counts result rows so a Graph-backed listing can be metered per_row like any
 * other. A GraphQL response is a map of named lists; the row count is the
 * total across them, and a scalar-only response counts as one row.
 */
export function countGraphRows(data: unknown): number {
  if (data === null || typeof data !== "object") return 0;

  let rows = 0;
  let sawList = false;

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      sawList = true;
      rows += value.length;
    }
  }

  return sawList ? rows : 1;
}

export interface TrimmedGraphResult {
  data: unknown;
  rows: number;
  truncated: boolean;
}

/**
 * Holds a GraphQL result to the buyer's row budget.
 *
 * The generic per_row metering cannot do this: it looks for a bare JSON array
 * and a GraphQL response is a map of *named* lists, so `{ markets: [...] }`
 * would meter as a single row and a buyer paying for 50 would be handed
 * however many the subgraph felt like returning.
 *
 * Lists are trimmed in key order, each one taking from what the previous left,
 * so the budget is a total across the response rather than per-list.
 */
export function trimGraphResult(data: unknown, maxRows: number): TrimmedGraphResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { data, rows: countGraphRows(data), truncated: false };
  }

  const budget = Math.max(maxRows, 0);
  const entries = Object.entries(data as Record<string, unknown>);

  let remaining = budget;
  let rows = 0;
  let truncated = false;
  let sawList = false;
  const trimmed: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    if (!Array.isArray(value)) {
      trimmed[key] = value;
      continue;
    }

    sawList = true;
    if (value.length > remaining) truncated = true;

    const kept = value.slice(0, remaining);
    trimmed[key] = kept;
    remaining -= kept.length;
    rows += kept.length;
  }

  // A response with no lists is one row and cannot be trimmed.
  if (!sawList) return { data, rows: 1, truncated: false };

  return { data: trimmed, rows, truncated };
}
