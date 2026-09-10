#!/usr/bin/env node
/**
 * Publishes the demo MCP servers.
 *
 *   node scripts/seed-mcp.mjs            publish the demo set
 *   node scripts/seed-mcp.mjs --clean    remove them first
 *
 * Runs against a live server so it exercises the real publish path — fetch the
 * seller's specification, shape it, price it, write the listings — rather than
 * writing rows a hand-rolled INSERT thinks are equivalent.
 *
 * Kept out of `db:seed` on purpose: it reaches out to third-party APIs, and a
 * database seed that fails because someone else's documentation host is down
 * is a seed nobody trusts.
 */
import dotenv from "dotenv";
import pg from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const BASE = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

/**
 * Each entry is a real, public, unauthenticated API — so a reviewer can watch
 * an agent buy a call and check the answer against the provider themselves.
 */
const CATALOGUE = [
  {
    slug: "weather-gov",
    seller: "Indexwell Research",
    name: "US National Weather Service",
    description:
      "Official US forecasts, severe-weather alerts, observation stations and " +
      "aviation products, from the National Weather Service.",
    spec_url: "https://api.weather.gov/openapi.json",
    price_amount: "90000",
    category: "weather",
    max_tools: 10,
  },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function sellerAccount(displayName) {
  const row = await client.query(
    `SELECT account_id, verification_status, deposit_amount
       FROM sellers WHERE display_name = $1`,
    [displayName],
  );
  return row.rows[0] ?? null;
}

async function main() {
  await client.connect();

  const health = await fetch(`${BASE}/api/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (!health?.ok) {
    console.error(`No server at ${BASE}. Start it with \`npm run dev\` first.`);
    process.exit(1);
  }

  if (process.argv.includes("--clean")) {
    const slugs = CATALOGUE.map((entry) => entry.slug);
    const removed = await client.query(
      `DELETE FROM mcp_servers WHERE slug = ANY($1::text[]) RETURNING slug`,
      [slugs],
    );
    // services cascade from mcp_servers, so the listings go with them.
    console.log(`removed ${removed.rowCount} server(s): ${removed.rows.map((r) => r.slug).join(", ") || "none"}`);
  }

  let published = 0;

  for (const entry of CATALOGUE) {
    const seller = await sellerAccount(entry.seller);
    if (!seller) {
      console.log(`skip ${entry.slug}: seller "${entry.seller}" not seeded`);
      continue;
    }
    if (seller.verification_status !== "verified") {
      console.log(`skip ${entry.slug}: seller "${entry.seller}" is not verified`);
      continue;
    }

    const existing = await client.query(`SELECT id FROM mcp_servers WHERE slug = $1`, [entry.slug]);
    if (existing.rowCount > 0) {
      console.log(`skip ${entry.slug}: already published`);
      continue;
    }

    const response = await fetch(`${BASE}/api/mcp/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_id: seller.account_id,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        spec_url: entry.spec_url,
        price_amount: entry.price_amount,
        price_unit: "per_call",
        category: entry.category,
        max_tools: entry.max_tools,
      }),
    });

    const body = await response.json();

    if (!response.ok) {
      console.log(`fail ${entry.slug}: ${body.error} — ${body.message}`);
      continue;
    }

    published += 1;
    console.log(
      `published ${entry.slug.padEnd(14)} ${String(body.server.tool_count).padStart(2)} tools  ` +
        `${body.server.url}` +
        (body.dropped.truncated ? `  (${body.dropped.truncated} operations over budget)` : ""),
    );
    for (const tool of body.tools) {
      console.log(`    ${tool.name.padEnd(22)} ${tool.slug}`);
    }
  }

  console.log(`\n${published} server(s) published.`);
  console.log(`Marketplace endpoint: ${BASE}/mcp`);
  await client.end();
}

main().catch(async (err) => {
  console.error(err);
  await client.end().catch(() => {});
  process.exitCode = 1;
});
