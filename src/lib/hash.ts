import { createHash } from "node:crypto";

/**
 * Receipt hashes.
 *
 * The request and response bodies stay in Postgres; only these digests are
 * written to the Hedera Consensus Service, so a receipt proves what was asked
 * and what came back without publishing either.
 */

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashRequest(method: string, url: string, body: string | null): string {
  return sha256Hex(`${method.toUpperCase()}\n${url}\n${body ?? ""}`);
}

export function hashResponse(status: number, body: string): string {
  return sha256Hex(`${status}\n${body}`);
}

/** Hashes a bearer token for storage. Tokens are never persisted in the clear. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
