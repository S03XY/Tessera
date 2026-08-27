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
    const counts = { sellers: 0, services: 0, agents: 0 };

    for (const seller of SELLERS) {
      const { rows } = await client.query(
        `INSERT INTO sellers
           (account_id, display_name, contact_url, verification_status,
            verified_at, world_nullifier, world_credential,
            deposit_amount, deposit_asset, deposit_tx)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0.0.0',$9)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [
          provisioned[seller.display_name]?.accountId ?? seller.account_id,
          seller.display_name,
          seller.contact_url,
          seller.verified ? "verified" : "unverified",
          seller.verified ? new Date() : null,
          seller.verified ? `seed-nullifier-${seller.key}` : null,
          seller.verified ? "selfie-check-seed" : null,
          seller.deposit,
          `seed-deposit-${seller.key}`,
        ],
      );
      const sellerId = rows[0].id;
      counts.sellers++;

      for (const service of seller.services) {
        await client.query(
          `INSERT INTO services
             (seller_id, slug, name, description, category, endpoint_url,
              price_amount, price_unit, keywords, asset, asset_decimals, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'0.0.0',8,'active')
           ON CONFLICT (slug) DO UPDATE
             SET price_amount = EXCLUDED.price_amount,
                 endpoint_url = EXCLUDED.endpoint_url,
                 keywords     = EXCLUDED.keywords,
                 description  = EXCLUDED.description`,
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
         (label, owner_account, agent_account, per_call_cap, per_day_cap, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (token_hash) DO UPDATE SET label = EXCLUDED.label`,
      [
        "Demo Buyer Agent",
        "0.0.7326075",
        "0.0.7326078",
        tinybars(0.05),
        tinybars(2),
        sha256(DEMO_AGENT_TOKEN),
      ],
    );
    counts.agents++;

    await client.query("COMMIT");
    return `seeded ${counts.sellers} sellers, ${counts.services} services, ${counts.agents} agent (token: ${DEMO_AGENT_TOKEN})`;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export { HBAR, tinybars, sha256 };
