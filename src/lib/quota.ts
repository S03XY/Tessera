import { createHash } from "node:crypto";
import { queryOne } from "@/lib/db";

/**
 * The free-tool allowance.
 *
 * Paid tools are rate limited by the thing that makes them paid: an agent with
 * an empty balance stops calling. Free tools have no such brake, and they need
 * no token and no account either — so the seller, not the caller, absorbs the
 * cost of abuse against their upstream API.
 *
 * What the allowance is really rationing is not money but *how well we know
 * the caller*. An address is free to change and a token is free to mint, so
 * neither tier is a hard bound on one determined person; what they do bound is
 * the cost of casual abuse, which is what actually shows up in practice. The
 * numbers are set so that ordinary evaluation never hits them and a loop does
 * so within seconds.
 */

export type BucketKind = "agent" | "anonymous";

export interface Bucket {
  kind: BucketKind;
  key: string;
  limit: number;
  /** Shown to the caller when they run out, so the remedy is obvious. */
  label: string;
}

/**
 * Daily free calls by how well we know the caller.
 *
 * Registering an agent is free and instant, so the `agent` tier is generous in
 * the sense that it is easy to reach — it caps what any one identity can take
 * rather than what one person can take by registering repeatedly. That is the
 * accepted trade: the downside of a wrongly granted allowance is some upstream
 * API calls, not money, not a payout, and not a dispute.
 */
export const FREE_LIMITS: Record<BucketKind, number> = {
  anonymous: 25,
  agent: 100,
};

/** Overridable so a deployment can tune the allowance without a code change. */
function limitFor(kind: BucketKind): number {
  const raw = process.env[`FREE_LIMIT_${kind.toUpperCase()}`];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : FREE_LIMITS[kind];
}

/**
 * A coarse, non-identifying key for an unauthenticated caller.
 *
 * Hashed because it is derived from an IP address, and a table of plaintext
 * IPs is a liability we have no use for — the counter only ever needs to know
 * whether two calls came from the same place, never where that place is.
 */
export function anonymousKey(forwardedFor: string | null, realIp: string | null): string {
  const source = (forwardedFor?.split(",")[0] ?? realIp ?? "unknown").trim();
  return createHash("sha256").update(`tessera-free-quota:${source}`).digest("hex").slice(0, 32);
}

/**
 * Which allowance a caller draws from.
 *
 * Ordered strongest-identity-first: a presented token is a better key than a
 * network address, so an authenticated agent never falls back to the shared
 * anonymous bucket for the address it happens to be calling from.
 */
export function bucketFor(agent: { id: string } | null, anonKey: string): Bucket {
  if (agent) {
    return { kind: "agent", key: agent.id, limit: limitFor("agent"), label: "registered agent" };
  }
  return { kind: "anonymous", key: anonKey, limit: limitFor("anonymous"), label: "anonymous" };
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
  kind: BucketKind;
  label: string;
}

/**
 * Consumes one free call from a bucket.
 *
 * The limit is enforced inside the UPDATE rather than by reading the count and
 * then writing it back: two concurrent free calls would otherwise both see one
 * remaining and both proceed. `RETURNING` tells us whether the row moved, so
 * "over quota" is the absence of an update, not a second query.
 */
export async function consumeFreeCall(bucket: Bucket): Promise<QuotaResult> {
  if (bucket.limit === 0) {
    return { allowed: false, used: 0, limit: 0, kind: bucket.kind, label: bucket.label };
  }

  const row = await queryOne<{ used: number }>(
    `INSERT INTO free_call_quota (bucket_kind, bucket_key, day, used)
     VALUES ($1, $2, CURRENT_DATE, 1)
     ON CONFLICT (bucket_kind, bucket_key, day) DO UPDATE
       SET used = free_call_quota.used + 1,
           updated_at = now()
       WHERE free_call_quota.used < $3
     RETURNING used`,
    [bucket.kind, bucket.key, bucket.limit],
  );

  if (!row) {
    // The guard refused the update: the bucket is already at its limit.
    return {
      allowed: false,
      used: bucket.limit,
      limit: bucket.limit,
      kind: bucket.kind,
      label: bucket.label,
    };
  }

  return {
    allowed: true,
    used: row.used,
    limit: bucket.limit,
    kind: bucket.kind,
    label: bucket.label,
  };
}

/**
 * Hands an unused free call back.
 *
 * Called when the upstream never delivered, so the allowance matches what the
 * caller actually received. Floored at zero because a release without a prior
 * consume — a bug, or a counter reset by the day rolling over mid-call —
 * should not push a bucket negative and silently hand out an extra call.
 */
export async function releaseFreeCall(bucket: Bucket): Promise<void> {
  try {
    await queryOne(
      `UPDATE free_call_quota
          SET used = GREATEST(used - 1, 0), updated_at = now()
        WHERE bucket_kind = $1 AND bucket_key = $2 AND day = CURRENT_DATE
        RETURNING used`,
      [bucket.kind, bucket.key],
    );
  } catch {
    // Never fail a call over bookkeeping; the counter self-corrects at midnight.
  }
}

/** Reads a bucket without spending from it. */
export async function quotaStatus(bucket: Bucket): Promise<QuotaResult> {
  const row = await queryOne<{ used: number }>(
    `SELECT used FROM free_call_quota
      WHERE bucket_kind = $1 AND bucket_key = $2 AND day = CURRENT_DATE`,
    [bucket.kind, bucket.key],
  );
  const used = row?.used ?? 0;
  return {
    allowed: used < bucket.limit,
    used,
    limit: bucket.limit,
    kind: bucket.kind,
    label: bucket.label,
  };
}

/**
 * What to tell a caller who has run out.
 *
 * The point of the message is the remedy, so the anonymous tier is told the
 * one thing that lifts it and the agent tier is told plainly that there isn't
 * a self-service way up — better than implying one that does not exist.
 */
export function exhaustedMessage(result: QuotaResult): string {
  const base = `Free-call allowance exhausted: ${result.used}/${result.limit} today for this ${result.label}.`;
  if (result.kind === "anonymous") {
    return `${base} Register an agent to raise it, or fund one to call paid tools.`;
  }
  return `${base} It resets at midnight UTC. Fund this agent to call paid tools in the meantime.`;
}
