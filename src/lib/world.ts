import { signRequest } from "@worldcoin/idkit-core/signing";
import { query, queryOne, transaction } from "@/lib/db";

/**
 * World ID Selfie Check.
 *
 * The abuse this prevents is concrete: without it, one person registers as
 * fifty sellers, lists fifty cheap services, collects payments and walks. The
 * nullifier is stored under a UNIQUE constraint, so a second seller account
 * from the same human is rejected by the database rather than by a heuristic.
 *
 * Selfie Check is the right assurance level here — an Orb is disproportionate
 * for "prove you are a distinct person before you can take payments", while a
 * plain wallet signature proves nothing at all.
 */

export const world = {
  appId: process.env.WORLD_APP_ID ?? "",
  rpId: process.env.WORLD_RP_ID ?? "",
  signingKey: process.env.WORLD_RP_SIGNING_KEY ?? "",
  action: process.env.WORLD_ACTION ?? "become-seller",
  environment: (process.env.WORLD_ENVIRONMENT ?? "sandbox") as
    | "production"
    | "staging"
    | "sandbox",
};

/** True when a real Selfie Check round-trip is possible. */
export const worldConfigured = Boolean(world.appId && world.rpId && world.signingKey);

const VERIFY_BASE = "https://developer.world.org/api/v4/verify";

export class WorldError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorldError";
  }
}

export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

/**
 * Builds the signed RP context IDKit needs to open a request.
 *
 * The signature is produced with the RP signing key, which never leaves the
 * server — a browser cannot mint its own verification challenge.
 */
export function createRpContext(action = world.action): RpContext {
  if (!worldConfigured) {
    throw new WorldError(
      "World ID is not configured. Set WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY.",
      "not_configured",
      503,
    );
  }

  const signed = signRequest({
    signingKeyHex: world.signingKey,
    action,
    ttl: 600,
  });

  return {
    rp_id: world.rpId,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  };
}

interface VerifyApiResult {
  success: boolean;
  code?: string;
  detail?: string;
  action?: string;
  results?: Array<{ identifier: string; success: boolean; nullifier: string }>;
}

/**
 * Verifies an IDKit proof with World's API and returns the nullifier.
 *
 * The proof is forwarded verbatim — the client's own claim about whether it
 * passed is never trusted, only World's answer.
 */
export async function verifyProof(idkitResult: unknown): Promise<{ nullifier: string }> {
  if (!worldConfigured) {
    throw new WorldError("World ID is not configured.", "not_configured", 503);
  }

  let response: Response;
  try {
    response = await fetch(`${VERIFY_BASE}/${world.rpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResult),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new WorldError(
      `World ID verify endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "verifier_unreachable",
      502,
    );
  }

  let body: VerifyApiResult;
  try {
    body = (await response.json()) as VerifyApiResult;
  } catch {
    throw new WorldError("World ID returned a non-JSON response.", "bad_verifier_response", 502);
  }

  if (!response.ok || !body.success) {
    throw new WorldError(
      body.detail ?? `Verification failed (${body.code ?? response.status}).`,
      body.code ?? "verification_failed",
      response.status === 404 ? 404 : 400,
    );
  }

  const passed = body.results?.find((entry) => entry.success && entry.nullifier);
  if (!passed) {
    throw new WorldError("No credential in the proof passed verification.", "no_passing_credential");
  }

  return { nullifier: passed.nullifier };
}

/**
 * Marks a seller verified against a nullifier.
 *
 * The UNIQUE constraint on sellers.world_nullifier is what actually enforces
 * one-human-one-seller; this surfaces the collision as a clear error rather
 * than a 500.
 */
export async function markVerified(
  accountId: string,
  nullifier: string,
  displayName?: string,
): Promise<{ id: string; account_id: string; display_name: string }> {
  const clash = await queryOne<{ account_id: string }>(
    `SELECT account_id FROM sellers WHERE world_nullifier = $1 AND account_id <> $2`,
    [nullifier, accountId],
  );

  if (clash) {
    throw new WorldError(
      `This human is already registered as seller ${clash.account_id}. One person may hold one seller account.`,
      "nullifier_already_used",
      409,
    );
  }

  return transaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      account_id: string;
      display_name: string;
    }>(
      `INSERT INTO sellers (account_id, display_name, verification_status,
                            verified_at, world_nullifier, world_credential)
       VALUES ($1, $2, 'verified', now(), $3, 'selfie_check')
       ON CONFLICT (account_id) DO UPDATE
         SET verification_status = 'verified',
             verified_at         = now(),
             world_nullifier     = EXCLUDED.world_nullifier,
             world_credential    = EXCLUDED.world_credential,
             display_name        = COALESCE(NULLIF($2, ''), sellers.display_name)
       RETURNING id, account_id, display_name`,
      [accountId, displayName ?? `Seller ${accountId}`, nullifier],
    );
    return rows[0];
  });
}

/** Hedera account ids look like `0.0.12345`. */
export function isHederaAccountId(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value.trim());
}

export async function verificationStatus(accountId: string) {
  const rows = await query<{
    account_id: string;
    display_name: string;
    verification_status: string;
    verified_at: string | null;
    deposit_amount: string;
    service_count: string;
  }>(
    `SELECT sel.account_id, sel.display_name, sel.verification_status,
            sel.verified_at, sel.deposit_amount,
            (SELECT count(*)::text FROM services WHERE seller_id = sel.id) AS service_count
       FROM sellers sel WHERE sel.account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}
