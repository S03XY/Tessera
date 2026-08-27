#!/usr/bin/env node
/**
 * Database lifecycle helper.
 *
 *   node scripts/db.mjs up       start the local docker postgres
 *   node scripts/db.mjs down     stop and remove it
 *   node scripts/db.mjs migrate  apply pending migrations
 *   node scripts/db.mjs seed     insert demo sellers/services/agent
 *   node scripts/db.mjs reset    drop everything, migrate, seed
 *
 * Everything talks to DATABASE_URL, so pointing this at Supabase later is a
 * one-line env change with no code change.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const CONTAINER = "tollgate-pg";
const MIGRATIONS = join(root, "db", "migrations");

function url() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.local.");
    process.exit(1);
  }
  return value;
}

function connect() {
  const connectionString = url();
  // Supabase and most hosted providers terminate TLS with their own CA.
  const ssl = /supabase|neon|render|amazonaws/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  return new pg.Client({ connectionString, ssl });
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", ...opts });
}

async function up() {
  const running = docker([
    "ps", "-a", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.State}}",
  ]).trim();

  if (running === "running") {
    console.log(`${CONTAINER} already running on :5433`);
  } else if (running) {
    docker(["start", CONTAINER]);
    console.log(`${CONTAINER} restarted on :5433`);
  } else {
    docker([
      "run", "-d", "--name", CONTAINER,
      "-e", "POSTGRES_PASSWORD=tollgate",
      "-e", "POSTGRES_USER=tollgate",
      "-e", "POSTGRES_DB=tollgate",
      "-p", "5433:5432",
      "postgres:16-alpine",
    ]);
    console.log(`${CONTAINER} created on :5433`);
  }

  for (let i = 0; i < 60; i++) {
    try {
      docker(["exec", CONTAINER, "pg_isready", "-U", "tollgate"], { stdio: "ignore" });
      console.log("postgres accepting connections");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready in 30s");
}

function down() {
  try {
    docker(["rm", "-f", CONTAINER], { stdio: "ignore" });
    console.log(`${CONTAINER} removed`);
  } catch {
    console.log(`${CONTAINER} was not running`);
  }
}

async function migrate() {
  const client = connect();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    console.log(count ? `${count} migration(s) applied` : "schema already up to date");
  } finally {
    await client.end();
  }
}

async function drop() {
  const client = connect();
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("schema dropped");
  } finally {
    await client.end();
  }
}

async function seed() {
  const { seedDemo } = await import("./seed-demo.mjs");
  const client = connect();
  await client.connect();
  try {
    const summary = await seedDemo(client);
    console.log(summary);
  } finally {
    await client.end();
  }
}

const command = process.argv[2];
const commands = {
  up,
  down: async () => down(),
  migrate,
  seed,
  drop,
  reset: async () => {
    await drop();
    await migrate();
    await seed();
  },
};

if (!commands[command]) {
  console.error(`usage: node scripts/db.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}

commands[command]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
