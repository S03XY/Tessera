import { Pool, types } from "pg";

/**
 * Postgres access.
 *
 * Serverless invocations are short and numerous, so the pool stays small and
 * is cached on globalThis to survive hot reloads in dev and warm starts in
 * production. Point DATABASE_URL at the Supabase *transaction pooler*
 * (port 6543) rather than 5432, or connections will be exhausted quickly.
 */

// numeric(38,0) columns hold atomic token units that overflow float64.
// Keep them as strings and let the app parse to BigInt deliberately.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);
types.setTypeParser(types.builtins.INT8, (value) => value);

declare global {
  var __tollgatePool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and run `npm run db:up`.",
    );
  }

  const isManaged = /supabase|neon|render|amazonaws|pooler/.test(connectionString);

  return new Pool({
    connectionString,
    ssl: isManaged ? { rejectUnauthorized: false } : undefined,
    max: isManaged ? 3 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    allowExitOnIdle: true,
  });
}

export function pool(): Pool {
  if (!globalThis.__tollgatePool) globalThis.__tollgatePool = createPool();
  return globalThis.__tollgatePool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool().query(text, params as unknown[]);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** True when the database is reachable. Used by the health endpoint. */
export async function dbReachable(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
