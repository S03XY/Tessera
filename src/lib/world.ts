import { createHash } from "node:crypto";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { query, queryOne, transaction } from "@/lib/db";
import {
  CREDENTIALS,
  DEFAULT_CREDENTIAL,
  SIMULATED_CREDENTIAL,
  type CredentialSpec,
} from "@/lib/world-credentials";

/**
 * World ID — the seller sybil gate.
 *
 * The abuse this prevents is concrete: without it, one person registers as
 * fifty sellers, lists fifty cheap tools, collects payments and walks. The
 * nullifier is stored under a UNIQUE constraint, so a second seller account
 * from the same human is rejected by the database rather than by a heuristic.
 *
 * Which credential does the proving is deliberately configuration, not code.
 * Selfie Check is the assurance level we want — an Orb is disproportionate for
 * "prove you are a distinct person before you can take payments", a wallet
 * signature proves nothing at all — but it is access-gated by World, and an
 * integration that only works once someone answers an email is an integration
 * that cannot be demonstrated. So the credential is chosen by WORLD_CREDENTIAL
 * and every ungated option runs the identical live path: server-signed RP
 * context, real capture in World App, proof verified by World, real nullifier.
 * Switching to Selfie Check the day it is enabled is one environment variable.
 */

/* -------------------------------------------------------------- credentials */

export {
  CREDENTIALS,
  DEFAULT_CREDENTIAL,
  REAL_CREDENTIALS,
  SIMULATED_CREDENTIAL,
  credentialLabel,
  type CredentialSpec,
  type PresetName,
} from "@/lib/world-credentials";

/* ------------------------------------------------------------ configuration */

/**
 * An RP signing key is a 32-byte secp256k1 private key, hex encoded, issued by
 * the Developer Portal when the app is migrated to World ID 4.0. Checking the
 * shape here rather than at first use turns "verification mysteriously fails"
 * into "the key you pasted is not a key", which is a different afternoon.
 */
const SIGNING_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The environments World's verify endpoint accepts.
 *
 * Taken from the API's own validation error rather than from the reference
 * page, which lists only `production` and `staging`. `sandbox` is both valid
 * and required — the Sandbox App guide instructs integrators to set it, and
 * posting `environment: "sandbox"` is accepted while a typo is rejected with
 * "environment must be one of the following values: production, staging,
 * sandbox". Three World sources disagree here; the endpoint is the one that
 * decides, so it is the one encoded.
 */
const ENVIRONMENTS = ["production", "staging", "sandbox"] as const;
export type WorldEnvironment = (typeof ENVIRONMENTS)[number];

function readEnvironment(): WorldEnvironment {
  const raw = (process.env.WORLD_ENVIRONMENT ?? "production").trim();
  return (ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as WorldEnvironment)
    : "production";
}

function readCredential(): string {
  const raw = (process.env.WORLD_CREDENTIAL ?? DEFAULT_CREDENTIAL).trim();
  return raw in CREDENTIALS ? raw : DEFAULT_CREDENTIAL;
}

export const world = {
  appId: process.env.WORLD_APP_ID ?? "",
  rpId: process.env.WORLD_RP_ID ?? "",
  signingKey: (process.env.WORLD_RP_SIGNING_KEY ?? "").trim(),
  action: process.env.WORLD_ACTION ?? "become-seller",
  credential: readCredential(),
  environment: readEnvironment(),
};

/** The credential this deployment asks for. Always a known one. */
export function credentialSpec(): CredentialSpec {
  return CREDENTIALS[world.credential] ?? CREDENTIALS[DEFAULT_CREDENTIAL];
}

/**
 * Why the configuration is not usable, or null when it is.
 *
 * Returned as a sentence rather than a boolean because every caller — the
 * health endpoint, the onboarding screen, the preflight script — wants to tell
 * someone what to go and fix.
 */
export function configurationProblem(): string | null {
  if (!world.appId) return "WORLD_APP_ID is not set.";
  if (!world.appId.startsWith("app_")) return "WORLD_APP_ID must start with `app_`.";
  if (!world.rpId) return "WORLD_RP_ID is not set.";
  if (!world.rpId.startsWith("rp_")) return "WORLD_RP_ID must start with `rp_`.";
  if (!world.signingKey) return "WORLD_RP_SIGNING_KEY is not set.";
  if (!SIGNING_KEY_RE.test(world.signingKey)) {
    return "WORLD_RP_SIGNING_KEY must be a 32-byte hex private key (64 hex characters).";
  }
  if (!world.action.trim()) return "WORLD_ACTION is not set.";
  const rawEnvironment = (process.env.WORLD_ENVIRONMENT ?? "production").trim();
  if (!(ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    return `WORLD_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}.`;
  }
  return null;
}

/** True when a real World ID round-trip is possible. */
export const worldConfigured = configurationProblem() === null;

/**
 * Development simulation.
 *
 * Kept for the case where no World credentials exist at all — a fresh clone,
 * CI, a contributor who has not registered an app. It is deliberately loud
 * rather than convenient:
 *   - the credential is stored as `selfie_check_simulated`, never as a real one
 *   - the UI labels every simulated seller as simulated
 *   - /api/health reports it
 *
 * A simulated pass is NOT a World ID pass. It loses to a real configuration:
 * once WORLD_RP_SIGNING_KEY is set the live path takes over even if this flag
 * is still on, because a deployment that can prove humans should never quietly
 * keep pretending to.
 */
export const worldSimulation = process.env.WORLD_SIMULATION === "1";

/** World ID can run either for real, or simulated, or not at all. */
export type WorldMode = "live" | "simulated" | "unavailable";

export function worldMode(): WorldMode {
  if (worldConfigured) return "live";
  if (worldSimulation && world.appId) return "simulated";
  return "unavailable";
}

/** Everything a status surface needs, with nothing secret in it. */
export function describeWorld() {
  const spec = credentialSpec();
  return {
    mode: worldMode(),
    app_id: world.appId || null,
    rp_id: world.rpId || null,
    action: world.action,
    environment: world.environment,
    credential: world.credential,
    credential_label: spec.label,
    credential_gated: spec.gated,
    problem: configurationProblem(),
  };
}

const VERIFY_BASE = "https://developer.world.org/api/v4/verify";

export class WorldError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    /** True when trying again could plausibly succeed without a config change. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorldError";
  }
}

/**
 * What World's failure codes mean, and what the person in front of the screen
 * should do about them.
 *
 * World publishes these codes in the SDK's type definitions but documents
 * neither their cause nor their remedy, and for a gate whose entire job is
 * refusing people, "verification failed" is not an answer anyone can act on.
 * Anything unmapped falls through to the raw detail rather than a placeholder.
 */
const FAILURE_GUIDANCE: Record<string, { message: string; retryable?: boolean }> = {
  app_not_migrated: {
    message:
      "This app has not been migrated to World ID 4.0. Open it in the Developer Portal " +
      "and use the “Enable World ID 4.0” banner, which issues the rp_id and signing key.",
  },
  invalid_action: {
    message:
      "World does not know this action. Create it in the Developer Portal under the app, " +
      "with an identifier matching WORLD_ACTION.",
  },
  credential_unavailable: {
    message:
      "This credential is not enabled for the app. Selfie Check in particular is " +
      "access-gated by World; either request access or set WORLD_CREDENTIAL to an " +
      "ungated credential such as orb or proof_of_human.",
  },
  world_id_4_not_available: {
    message: "This World App install does not support World ID 4.0. Update it and try again.",
    retryable: true,
  },
  world_id_3_not_available: {
    message: "This World App install cannot produce the legacy proof this credential needs.",
  },
  invalid_rp_signature: {
    message:
      "World rejected our request signature. WORLD_RP_SIGNING_KEY does not match WORLD_RP_ID — " +
      "they are issued together and must come from the same app.",
  },
  unknown_rp: {
    message: "World does not recognise this rp_id. Check WORLD_RP_ID against the Developer Portal.",
  },
  inactive_rp: { message: "This relying party is disabled in the Developer Portal." },
  rp_signature_expired: {
    message: "The verification window expired before the check finished. Start it again.",
    retryable: true,
  },
  timestamp_too_old: {
    message: "The request expired before World saw it. Start the check again.",
    retryable: true,
  },
  timestamp_too_far_in_future: {
    message: "This server's clock is ahead of World's. Check the system time.",
  },
  duplicate_nonce: {
    message: "That challenge was already spent. Start the check again.",
    retryable: true,
  },
  nullifier_replayed: {
    message: "This proof has already been used. Start a fresh check.",
    retryable: true,
  },
  max_verifications_reached: {
    message: "This human has already verified for this action as many times as it allows.",
  },
  inclusion_proof_pending: {
    message: "This World ID is still being included on-chain. Try again in a few minutes.",
    retryable: true,
  },
  inclusion_proof_failed: { message: "World could not build an inclusion proof for this identity." },
  user_rejected: { message: "The check was declined in World App.", retryable: true },
  verification_rejected: { message: "World App rejected the verification.", retryable: true },
  user_presence_failed: { message: "World App could not confirm a person was present.", retryable: true },
  connection_failed: { message: "World App could not reach World. Check its connection.", retryable: true },
  timeout: { message: "The check timed out before it was completed.", retryable: true },
  cancelled: { message: "The check was cancelled.", retryable: true },
  all_verifications_failed: {
    message:
      "Every proof in the response failed verification. Usual causes: an expired challenge, " +
      "a different action than the one signed, or a proof produced for another app.",
    retryable: true,
  },
};

/** Turns a World failure code into something a human can act on. */
export function explainFailure(code: string, detail?: string): { message: string; retryable: boolean } {
  const known = FAILURE_GUIDANCE[code];
  if (known) return { message: known.message, retryable: known.retryable ?? false };
  return { message: detail?.trim() || `World reported: ${code}.`, retryable: false };
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
 * server — a browser cannot mint its own verification challenge. This is the
 * piece none of the credential documentation mentions, and no request can be
 * opened without it.
 */
export function createRpContext(action = world.action): RpContext {
  const problem = configurationProblem();
  if (problem) throw new WorldError(`World ID is not configured. ${problem}`, "not_configured", 503);

  const signed = signRequest({
    // signRequest wants the bare hex; a pasted `0x` prefix is otherwise
    // signed as part of the key and produces a valid-looking wrong signature.
    signingKeyHex: world.signingKey.replace(/^0x/, ""),
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
  results?: Array<{
    identifier: string;
    success: boolean;
    nullifier: string;
    code?: string;
    detail?: string;
  }>;
}

export interface VerifiedProof {
  nullifier: string;
  /** The credential we recorded — a key of CREDENTIALS, or the simulated one. */
  credential: string;
  /** The identifier World actually reported, kept for the audit trail. */
  identifier: string;
}

/**
 * A simulated pass.
 *
 * The nullifier is derived from a caller-supplied persona so the uniqueness
 * rule is still exercised: verifying twice with the same persona collides
 * exactly as two proofs from one human would.
 */
export function simulateProof(persona: string): VerifiedProof {
  const digest = createHash("sha256")
    .update(`tollgate-simulated-human:${persona.trim().toLowerCase()}`)
    .digest("hex");
  return {
    nullifier: `sim_${digest.slice(0, 40)}`,
    credential: SIMULATED_CREDENTIAL,
    identifier: "simulated",
  };
}

/**
 * Verifies an IDKit proof with World's API and returns the nullifier.
 *
 * The proof is forwarded verbatim — the client's own claim about whether it
 * passed is never trusted, only World's answer — and the credential that
 * satisfied it must be one this deployment actually asked for.
 */
export async function verifyProof(idkitResult: unknown): Promise<VerifiedProof> {
  const problem = configurationProblem();
  if (problem) throw new WorldError(`World ID is not configured. ${problem}`, "not_configured", 503);

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
      true,
    );
  }

  let body: VerifyApiResult;
  try {
    body = (await response.json()) as VerifyApiResult;
  } catch {
    throw new WorldError("World ID returned a non-JSON response.", "bad_verifier_response", 502, true);
  }

  if (!response.ok || !body.success) {
    const code = body.code ?? String(response.status);
    const { message, retryable } = explainFailure(code, body.detail);
    throw new WorldError(message, code, response.status === 404 ? 404 : 400, retryable);
  }

  const spec = credentialSpec();
  const accepted = new Set(spec.identifiers);
  const passes = (body.results ?? []).filter((entry) => entry.success && entry.nullifier);

  if (passes.length === 0) {
    throw new WorldError(
      "No credential in the proof passed verification.",
      "no_passing_credential",
      400,
      true,
    );
  }

  const matched = passes.find((entry) => accepted.has(entry.identifier));
  if (!matched) {
    // World verified something, but not what we asked for. Recording it would
    // put a claim in the database that the proof does not support.
    throw new WorldError(
      `This proof is a ${passes.map((p) => p.identifier).join(", ")} credential, but this ` +
        `marketplace requires ${spec.label}.`,
      "credential_mismatch",
      400,
    );
  }

  return { nullifier: matched.nullifier, credential: world.credential, identifier: matched.identifier };
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
  credential: string,
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
       VALUES ($1, $2, 'verified', now(), $3, $4)
       ON CONFLICT (account_id) DO UPDATE
         SET verification_status = 'verified',
             verified_at         = now(),
             world_nullifier     = EXCLUDED.world_nullifier,
             world_credential    = EXCLUDED.world_credential,
             display_name        = COALESCE(NULLIF($2, ''), sellers.display_name)
       RETURNING id, account_id, display_name`,
      [accountId, displayName ?? `Seller ${accountId}`, nullifier, credential],
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
    world_credential: string | null;
    service_count: string;
  }>(
    `SELECT sel.account_id, sel.display_name, sel.verification_status,
            sel.verified_at, sel.deposit_amount, sel.world_credential,
            (SELECT count(*)::text FROM services WHERE seller_id = sel.id) AS service_count
       FROM sellers sel WHERE sel.account_id = $1`,
    [accountId],
  );
  return rows[0] ?? null;
}
