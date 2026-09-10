import { createHash } from "node:crypto";
import { queryOne } from "@/lib/db";
import { CREDENTIALS, SIMULATED_CREDENTIAL } from "@/lib/world-credentials";
import { worldMode } from "@/lib/world";

/**
 * The free-tool allowance.
 *
 * Paid tools are rate limited by the thing that makes them paid: an agent with
 * an empty balance stops calling. Free tools have no such brake, and after the
 * free/paid pivot they need no token and no account either — so the seller,
 * not the caller, absorbs the cost of abuse against their upstream API.
 *
 * What is scarce here is not money but *identity*. Tokens and IP addresses are
 * free to mint in bulk, so an allowance keyed to either is an allowance keyed
 * to nothing. A World ID nullifier is the one identifier in the system that a
 * person cannot cheaply multiply, which is exactly what a quota wants.
 *
 * This is also the case for a *low-assurance* credential specifically. The
 * downside of wrongly granting the larger allowance is some upstream API calls
 * — not money, not a payout, not a dispute. Requiring an Orb to use a free
 * tool would impose friction wildly out of proportion to the risk, and most
 * agent developers would simply not bother. A thirty-second selfie is
 * proportionate; an in-person iris scan is not.
 */

export type BucketKind = "human" | "agent" | "anonymous";

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
 * The gap between `agent` and `human` is the whole argument. Registering a
 * second agent is free and instant, so that tier is generous only in the sense
 * that it is easy to reach — it caps what any one identity can take, but not
 * what one person can take by registering repeatedly. The human tier is the
 * only one where the number actually binds a person.
 */
export const FREE_LIMITS: Record<BucketKind, number> = {
  anonymous: 25,
  agent: 100,
  human: 2_500,
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
 * Is this credential good enough to draw the human allowance?
 *
 * Real credentials always are. The simulated one counts *only* while the
 * deployment is itself in simulation mode — that is what makes the stand-in
 * useful for building and demonstrating the flow, and the restriction is what
 * stops it becoming a back door: the moment World is configured, a leftover
 * simulated row drops back to the agent tier rather than silently keeping an
 * allowance it never proved it deserved.
 */
function grantsHumanTier(credential: string | null | undefined): boolean {
  if (!credential) return false;
  if (credential in CREDENTIALS) return true;
  return credential === SIMULATED_CREDENTIAL && worldMode() === "simulated";
}

/**
 * Which allowance a caller draws from.
 *
 * Ordered strongest-identity-first. A verified agent draws from its owner's
 * human bucket, so a person who runs ten agents still has one allowance
 * between them — otherwise verification would be a way to *multiply* quota
 * rather than to justify a larger one.
 */
export function bucketFor(
  agent: { id: string; world_nullifier?: string | null; world_credential?: string | null } | null,
  anonKey: string,
): Bucket {
  if (agent && agent.world_nullifier && grantsHumanTier(agent.world_credential)) {
    return {
      kind: "human",
      key: agent.world_nullifier,
      limit: limitFor("human"),
      // Named so an operator reading a log or an error can tell at a glance
      // whether the allowance rests on a real proof.
      label:
        agent.world_credential === SIMULATED_CREDENTIAL
          ? "simulated human"
          : "verified human",
    };
  }
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
 * The point of the message is the remedy: every tier below `human` has a way
 * up, and the way up is proportionate to what is being asked for.
 */
export function exhaustedMessage(result: QuotaResult): string {
  const base = `Free-call allowance exhausted: ${result.used}/${result.limit} today for this ${result.label}.`;
  if (result.kind === "anonymous") {
    return `${base} Register an agent to raise it, or verify with World ID for the full allowance.`;
  }
  if (result.kind === "agent") {
    return (
      `${base} Verify this agent's owner with World ID to draw from the human allowance — ` +
      "registering more agents will not help, since the allowance is per person."
    );
  }
  return `${base} It resets at midnight UTC.`;
}
