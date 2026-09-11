/**
 * Demo fixtures.
 *
 * Upstreams are real, key-free public APIs, so a paid call returns genuine
 * data rather than a canned string. Three sellers publish the same capability
 * (USD reference rates) at three different prices, which is what makes the
 * "agent picks the cheapest without a human" acceptance test meaningful.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/provision.mjs replaces the invented seller account ids with real
 * testnet accounts and records them here. Reuse them so a reseed does not
 * point the marketplace back at accounts that cannot receive a transfer.
 */
const provisioned = (() => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".testnet-accounts.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")).sellers ?? {};
  } catch {
    return {};
  }
})();

export const DEMO_AGENT_TOKEN = "tg_demo_agent_key";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const HBAR = 100_000_000n; // tinybars per HBAR
const tinybars = (hbar) => String(BigInt(Math.round(hbar * 1e8)));

/**
 * Messari's standardized lending schema. One document, every deployment —
 * that is what "standardized" buys, and why these two listings differ only
 * by subgraph id.
 */
const MESSARI_LENDING_QUERY = `
  {
    markets(first: 100, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      name
      inputToken { symbol }
      totalValueLockedUSD
      totalBorrowBalanceUSD
      rates(first: 4) { side type rate }
    }
  }`;

/**
 * What a Graph-backed row is sold for.
 *
 * The Graph charges per QUERY — $0.01, read live from their own 402 challenge
 * — not per row, so pricing each row at the query cost would overcharge a
 * hundredfold. floorPriceTinybars() turns that $0.01 into tinybars with a 30%
 * margin, and it is then spread across the 100-row page the query actually
 * fetches.
 *
 * A buyer taking fewer rows therefore pays pro rata while our cost stays
 * fixed, which means the margin only materialises at full uptake. That is a
 * deliberate wholesale decision rather than an oversight: the alternative is
 * charging a full query fee for a single row, which no agent would ever pay
 * twice.
 */
const GRAPH_ROWS_PER_QUERY = 100n;
const GRAPH_QUERY_COST_CENTS = 1n; // $0.01, read live from The Graph's 402
const GRAPH_MARKUP_BPS = 3_000n; // 30%
const HBAR_CENTS = 5n;

// Mirrors floorPriceTinybars() in src/lib/graph.ts, which is the source of
// truth and is unit-tested. Kept as plain arithmetic because this seed is a
// .mjs script and cannot import the TypeScript path alias.
//   1 cent / 5 cents-per-HBAR = 0.2 HBAR = 20_000_000 tinybars
//   +30% = 26_000_000, spread over 100 rows = 260_000 tinybars/row
const GRAPH_PRICE_PER_ROW = String(
  (GRAPH_QUERY_COST_CENTS * 100_000_000n * (10_000n + GRAPH_MARKUP_BPS)) /
    (HBAR_CENTS * 10_000n * GRAPH_ROWS_PER_QUERY),
);

const UNISWAP_POOLS_QUERY = `
  {
    pools(first: 100, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      feeTier
      totalValueLockedUSD
      volumeUSD
      token0 { symbol }
      token1 { symbol }
    }
  }`;

/*
 * Published free, so the mixed server is real rather than theoretical.
 *
 * Deliberately none of the listings the test suite pins its fixtures to: the
 * FX trio is asserted on for price ordering and the Hacker News feed is the
 * per-row metering fixture, so pricing either at zero would change what those
 * tests measure rather than what the product does.
 */
const FREE_TOOLS = ["weather-now", "lending-markets-base", "dex-pools-uniswap-v3"];

const SELLERS = [
  {
    key: "meridian",
    account_id: "0.0.7326075",
    display_name: "Meridian Data",
    contact_url: "https://example.com/meridian",
    verified: true,
    deposit: tinybars(25),
    services: [
      {
        slug: "ecb-reference-rates",
        keywords: ["exchange rate", "forex", "fx", "currency conversion", "eur", "usd", "gbp", "jpy", "ecb"],
        name: "ECB Reference Rates",
        description:
          "Daily euro foreign exchange reference rates published by the European Central Bank. Convert USD to any supported currency.",
        category: "fx",
        endpoint_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY",
        price: tinybars(0.0012),
        unit: "per_call",
      },
      {
        slug: "btc-spot-price",
        keywords: ["bitcoin", "btc", "crypto price", "spot price", "coinbase", "digital asset"],
        name: "BTC Spot Price",
        description:
          "Coinbase spot price for BTC quoted in USD. Single authoritative print, refreshed per request.",
        category: "crypto",
        endpoint_url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        price: tinybars(0.001),
        unit: "per_call",
      },
    ],
  },
  {
    key: "northwind",
    account_id: "0.0.7326076",
    display_name: "Northwind APIs",
    contact_url: "https://example.com/northwind",
    verified: true,
    deposit: tinybars(18),
    services: [
      {
        slug: "open-exchange-rates",
        keywords: ["exchange rate", "forex", "fx", "currency conversion", "usd base", "rates"],
        name: "Open Exchange Rates",
        description:
          "USD base exchange rates across 160 currencies, sourced from ExchangeRate-API with hourly refresh.",
        category: "fx",
        endpoint_url: "https://open.er-api.com/v6/latest/USD",
        price: tinybars(0.0009), // cheapest fx provider
        unit: "per_call",
      },
      {
        slug: "weather-now",
        keywords: ["weather", "temperature", "forecast", "wind", "precipitation", "climate"],
        name: "Weather Now",
        description:
          "Current temperature, wind speed and precipitation for a latitude/longitude pair via Open-Meteo.",
        category: "weather",
        endpoint_url:
          "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,wind_speed_10m,precipitation",
        price: tinybars(0.0008),
        unit: "per_call",
      },
    ],
  },
  {
    key: "cobalt",
    account_id: "0.0.7326077",
    display_name: "Cobalt Feeds",
    contact_url: "https://example.com/cobalt",
    verified: true,
    deposit: tinybars(12),
    services: [
      {
        slug: "currency-api-rates",
        keywords: ["exchange rate", "forex", "fx", "crypto rates", "currency", "conversion"],
        name: "Currency API Rates",
        description:
          "USD reference rates covering fiat and crypto pairs, mirrored from the open currency-api dataset.",
        category: "fx",
        endpoint_url:
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
        price: tinybars(0.0015),
        unit: "per_call",
      },
      {
        slug: "wikipedia-extract",
        keywords: ["encyclopedia", "summary", "article", "reference", "wikipedia", "knowledge"],
        name: "Wikipedia Extract",
        description:
          "Plain-text summary extract for an encyclopedia topic. Billed per token returned, not per request.",
        category: "reference",
        endpoint_url: "https://en.wikipedia.org/api/rest_v1/page/summary/Ethereum",
        price: tinybars(0.000004),
        unit: "per_token",
      },
      {
        slug: "hn-top-stories",
        keywords: ["hacker news", "tech news", "stories", "headlines", "social", "ranking"],
        name: "Hacker News Top Stories",
        description:
          "Ranked list of current Hacker News story ids. Billed per row returned.",
        category: "social",
        endpoint_url: "https://hacker-news.firebaseio.com/v0/topstories.json",
        price: tinybars(0.0000006),
        unit: "per_row",
      },
    ],
  },
  {
    key: "lowline",
    account_id: "0.0.7326079",
    display_name: "Lowline Metrics",
    contact_url: null,
    verified: true,
    deposit: tinybars(2), // below the 10 HBAR minimum: listings must be refused
    services: [
      {
        slug: "underfunded-quote",
        keywords: ["ethereum", "eth", "crypto price", "spot price"],
        name: "Lowline Spot Quote",
        description:
          "Listed by a verified seller whose dispute deposit has fallen below the marketplace minimum.",
        category: "crypto",
        endpoint_url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
        price: tinybars(0.0001),
        unit: "per_call",
      },
    ],
  },
  {
    key: "indexwell",
    account_id: "0.0.7399100",
    display_name: "Indexwell Research",
    contact_url: "https://example.com/indexwell",
    verified: true,
    deposit: tinybars(25),
    /**
     * This seller's deposit is not just a number in this database — it is a
     * real ERC-1400 security token on Hedera testnet, issued through the
     * Asset Tokenization Studio. The app reads the balance straight off the
     * bond, so what a visitor sees is the chain's answer, not ours.
     *
     * The holder finished the demonstrated dispute lifecycle with 175 of the
     * 200 units it was issued; the other 25 went to the wronged buyer.
     */
    ats: {
      token_id: "0.0.10367762",
      holder_address: "0x930D0145DC771Acc82c00504260E133e6184eb84",
    },
    /**
     * Graph-backed listings. These are not URLs behind a paywall — they are
     * subgraphs, executed against The Graph's gateway with the marketplace's
     * own key, and resold in HBAR so the buying agent never needs a Base
     * wallet or a dollar balance. Doing that conversion is the job.
     *
     * The first two share one schema across two chains on purpose: a
     * standardized schema means the same query document answers both, which
     * is what makes "lending TVL" a capability rather than a per-chain
     * integration.
     */
    services: [
      {
        slug: "lending-markets-ethereum",
        keywords: ["lending", "borrow", "supply", "tvl", "defi", "aave", "money market", "collateral", "ethereum"],
        name: "Lending Markets — Ethereum",
        description:
          "Live lending market state on Ethereum: total value locked, borrow balances and interest rates per market. Messari standardized lending schema v3.1.0, so the same query shape works across every chain.",
        category: "defi",
        upstream_kind: "graph_subgraph",
        upstream_ref: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
        upstream_schema: "messari/lending@3.1.0",
        upstream_chain: "mainnet",
        upstream_query: MESSARI_LENDING_QUERY,
        endpoint_url: "https://gateway.thegraph.com/api/subgraphs/id/JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
        price: GRAPH_PRICE_PER_ROW,
        unit: "per_row",
      },
      {
        slug: "lending-markets-base",
        keywords: ["lending", "borrow", "supply", "tvl", "defi", "moonwell", "money market", "collateral", "base"],
        name: "Lending Markets — Base",
        description:
          "The same Messari standardized lending schema, indexed on Base — and a different protocol. Aave on Ethereum and Moonwell on Base answer one identical query document, which is the whole point of a standardized schema.",
        category: "defi",
        upstream_kind: "graph_subgraph",
        upstream_ref: "33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
        upstream_schema: "messari/lending@3.1.0",
        upstream_chain: "base",
        upstream_query: MESSARI_LENDING_QUERY,
        endpoint_url: "https://gateway.thegraph.com/api/subgraphs/id/33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg",
        price: GRAPH_PRICE_PER_ROW,
        unit: "per_row",
      },
      {
        slug: "dex-pools-uniswap-v3",
        keywords: ["dex", "swap", "liquidity", "pool", "uniswap", "amm", "trading volume"],
        name: "Uniswap V3 Pools",
        description:
          "Top Uniswap V3 pools on Ethereum by total value locked, with token pairs, fee tier and volume.",
        category: "defi",
        upstream_kind: "graph_subgraph",
        upstream_ref: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
        upstream_schema: "uniswap/v3",
        upstream_chain: "mainnet",
        upstream_query: UNISWAP_POOLS_QUERY,
        endpoint_url: "https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
        price: GRAPH_PRICE_PER_ROW,
        unit: "per_row",
      },
    ],
  },
];

// Present but unverified and undeposited: proves the listing gate rejects it.
const UNVERIFIED_SELLER = {
  account_id: "0.0.7399001",
  display_name: "Unregistered Labs",
  contact_url: null,
};

export async function seedDemo(client) {
  await client.query("BEGIN");
  try {
    const counts = { sellers: 0, services: 0, agents: 0, servers: 0 };

    for (const seller of SELLERS) {
      const { rows } = await client.query(
        `INSERT INTO sellers
           (account_id, display_name, contact_url, verification_status,
            verified_at,
            deposit_amount, deposit_asset, deposit_tx,
            ats_token_id, ats_holder_address)
         VALUES ($1,$2,$3,$4,$5,$6,'0.0.0',$7,$8,$9)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name        = EXCLUDED.display_name,
               ats_token_id        = EXCLUDED.ats_token_id,
               ats_holder_address  = EXCLUDED.ats_holder_address
         RETURNING id`,
        [
          provisioned[seller.display_name]?.accountId ?? seller.account_id,
          seller.display_name,
          seller.contact_url,
          seller.verified ? "verified" : "unverified",
          seller.verified ? new Date() : null,
          seller.deposit,
          `seed-deposit-${seller.key}`,
          seller.ats?.token_id ?? null,
          seller.ats?.holder_address ?? null,
        ],
      );
      const sellerId = rows[0].id;
      counts.sellers++;

      for (const service of seller.services) {
        await client.query(
          `INSERT INTO services
             (seller_id, slug, name, description, category, endpoint_url,
              price_amount, price_unit, keywords, asset, asset_decimals, status,
              upstream_kind, upstream_ref, upstream_query, upstream_schema,
              upstream_chain)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0.0.0',8,'active',
                   $10,$11,$12,$13,$14)
           ON CONFLICT (slug) DO UPDATE
             SET price_amount    = EXCLUDED.price_amount,
                 endpoint_url    = EXCLUDED.endpoint_url,
                 keywords        = EXCLUDED.keywords,
                 description     = EXCLUDED.description,
                 upstream_kind   = EXCLUDED.upstream_kind,
                 upstream_ref    = EXCLUDED.upstream_ref,
                 upstream_query  = EXCLUDED.upstream_query,
                 upstream_schema = EXCLUDED.upstream_schema,
                 upstream_chain  = EXCLUDED.upstream_chain`,
          [
            sellerId,
            service.slug,
            service.name,
            service.description,
            service.category,
            service.endpoint_url,
            service.price,
            service.unit,
            service.keywords ?? [],
            service.upstream_kind ?? "http",
            service.upstream_ref ?? null,
            service.upstream_query ?? null,
            service.upstream_schema ?? null,
            service.upstream_chain ?? null,
          ],
        );
        counts.services++;
      }
    }

    await client.query(
      `INSERT INTO sellers (account_id, display_name, contact_url)
       VALUES ($1,$2,$3)
       ON CONFLICT (account_id) DO NOTHING`,
      [UNVERIFIED_SELLER.account_id, UNVERIFIED_SELLER.display_name, UNVERIFIED_SELLER.contact_url],
    );
    counts.sellers++;

    await client.query(
      `INSERT INTO agents
         (label, owner_account, agent_account, per_call_cap, per_day_cap, token_hash, balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (token_hash) DO UPDATE
         SET label = EXCLUDED.label, balance = EXCLUDED.balance`,
      [
        "Demo Buyer Agent",
        "0.0.7326075",
        "0.0.7326078",
        tinybars(1),
        tinybars(10),
        sha256(DEMO_AGENT_TOKEN),
        tinybars(2),
      ],
    );
    counts.agents++;

    // The demo agent arrives funded, so the ledger has to say where from.
    await client.query(
      `INSERT INTO agent_ledger (agent_id, kind, amount, balance_after, tx, memo)
       SELECT id, 'deposit', $2::numeric, $2::numeric, 'seed-demo-funding',
              'seeded demo balance'
         FROM agents WHERE token_hash = $1
       ON CONFLICT (tx) WHERE tx IS NOT NULL AND kind = 'deposit' DO NOTHING`,
      [sha256(DEMO_AGENT_TOKEN), tinybars(2)],
    );

    /* ------------------------------------------------- group into servers */

    /*
     * Every listing belongs to an MCP server.
     *
     * The product is a marketplace of MCP servers, not of loose endpoints, so a
     * catalogue containing both would be telling two stories at once. Grouping
     * each seller's listings under one server keeps the slugs — and therefore
     * the direct /x402/<slug> URL a wallet-carrying agent uses — exactly as
     * they were, while everything an agent or a visitor browses is uniformly
     * "a server, and the tools on it".
     */
    const sellersWithTools = await client.query(
      `SELECT sel.id, sel.display_name
         FROM sellers sel
        WHERE sel.verification_status = 'verified'
          AND EXISTS (SELECT 1 FROM services s WHERE s.seller_id = sel.id)`,
    );

    for (const seller of sellersWithTools.rows) {
      const slug = seller.display_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const server = await client.query(
        `INSERT INTO mcp_servers (seller_id, slug, name, description, base_url, status)
         VALUES ($1,$2,$3,$4,$5,'active')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          seller.id,
          slug,
          seller.display_name,
          `Tools published by ${seller.display_name}. Some are free; the rest settle per call on Hedera.`,
          process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000",
        ],
      );

      await client.query(
        `UPDATE services
            SET mcp_server_id = $2,
                tool_name = replace(slug, '-', '_')
          WHERE seller_id = $1 AND mcp_server_id IS NULL`,
        [seller.id, server.rows[0].id],
      );

      await client.query(
        `UPDATE mcp_servers SET tool_count =
           (SELECT count(*) FROM services WHERE mcp_server_id = $1 AND status = 'active')
         WHERE id = $1`,
        [server.rows[0].id],
      );
      counts.servers++;
    }

    /*
     * A free tier, so the mixed server is real rather than theoretical: an
     * agent can look around at no cost and pay only for the tools that do the
     * expensive work.
     */
    await client.query(
      `UPDATE services SET price_amount = 0 WHERE slug = ANY($1::text[])`,
      [FREE_TOOLS],
    );

    await client.query("COMMIT");
    return (
      `seeded ${counts.sellers} sellers, ${counts.servers} MCP servers, ` +
      `${counts.services} tools (${FREE_TOOLS.length} free), ` +
      `${counts.agents} agent (token: ${DEMO_AGENT_TOKEN})`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export { HBAR, tinybars, sha256 };
