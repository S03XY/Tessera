/**
 * HCS-14 agent identity.
 *
 * An agent that pays for things needs a name that is not "whichever wallet
 * signed this". HCS-14 gives it one: a Universal Agent ID derived from what
 * the agent *is* — its registry, name, version, protocol, native address and
 * skills — rather than assigned by whoever happens to run the registry.
 *
 * The derivation is deterministic and needs no registration and no permission,
 * which is the property that matters here. Two parties who have never spoken
 * can compute the same identifier for the same agent from public inputs, so a
 * buyer and a seller can agree on who transacted without a directory in the
 * middle vouching for it.
 *
 * Spec: https://hol.org/docs/standards/hcs-14/
 */

import { createHash } from "node:crypto";
import { HEDERA_NETWORK } from "@/lib/config";

/** The six fields that comprise the hash input. Nothing else may enter it. */
export interface CanonicalAgent {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  /** CAIP-10 style where applicable, e.g. `hedera:testnet:0.0.4759408`. */
  nativeId: string;
  skills: number[];
}

export interface UaidParameters {
  /** Unique id within the registry. "0" when the registry has no such notion. */
  uid?: string;
  registry?: string;
  proto?: string;
  nativeId?: string;
  domain?: string;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58, Bitcoin alphabet. Written out rather than pulled in as a dependency:
 * it is twenty lines, and a payment gateway should not add a package to encode
 * one string.
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Every leading zero byte is one leading '1', by definition of the encoding.
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  /**
   * `digits` is little-endian, so a trailing zero here is a *leading* zero in
   * the output — and those are already accounted for by the '1' prefix above.
   * Only an all-zero input can produce any, but emitting them would double
   * count every zero byte.
   */
  let end = digits.length;
  while (end > 0 && digits[end - 1] === 0) end--;

  return (
    "1".repeat(leadingZeros) +
    digits
      .slice(0, end)
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit])
      .join("")
  );
}

/**
 * Canonical JSON: registry and protocol lowercased, strings trimmed, skills
 * sorted ascending, keys in alphabetical order.
 *
 * The ordering is not cosmetic. Two implementations must produce byte
 * identical input or they produce different identifiers for the same agent,
 * which would defeat the entire point of deriving rather than assigning.
 */
export function canonicalAgentJson(agent: CanonicalAgent): string {
  const canonical = {
    name: agent.name.trim(),
    nativeId: agent.nativeId.trim(),
    protocol: agent.protocol.trim().toLowerCase(),
    registry: agent.registry.trim().toLowerCase(),
    skills: [...agent.skills].sort((a, b) => a - b),
    version: agent.version.trim(),
  };
  return JSON.stringify(canonical);
}

/** The AID: base58 of the SHA-384 of the canonical JSON. */
export function deriveAid(agent: CanonicalAgent): string {
  const digest = createHash("sha384").update(canonicalAgentJson(agent), "utf8").digest();
  return base58Encode(new Uint8Array(digest));
}

/**
 * The full identifier, parameters in the order the standard normalizes them.
 * Empty parameters are omitted rather than emitted blank, so the string stays
 * stable for a given agent.
 */
export function uaid(agent: CanonicalAgent, params: UaidParameters = {}): string {
  const merged: UaidParameters = {
    uid: params.uid ?? "0",
    registry: params.registry ?? agent.registry.toLowerCase(),
    proto: params.proto ?? agent.protocol.toLowerCase(),
    nativeId: params.nativeId ?? agent.nativeId,
    domain: params.domain,
  };

  const order: Array<keyof UaidParameters> = ["uid", "registry", "proto", "nativeId", "domain"];
  const tail = order
    .map((key) => {
      const value = merged[key];
      return value === undefined || value === "" ? null : `${key}=${value}`;
    })
    .filter((part): part is string => part !== null)
    .join(";");

  return `uaid:aid:${deriveAid(agent)};${tail}`;
}

/* ------------------------------------------------------- this marketplace */

/**
 * Skill numbers are the standard's coarse capability tags. 0 is text/data
 * retrieval and 17 is transaction execution, which between them describe an
 * agent that reads data and pays for it.
 */
export const TESSERA_SKILLS = [0, 17];

export const AGENT_VERSION = "0.1.0";

/** CAIP-10 style address for a Hedera account. */
export function hederaNativeId(accountId: string): string {
  return `hedera:${HEDERA_NETWORK}:${accountId}`;
}

/** The buying agent's identity, derived from its own account. */
export function buyerAgentIdentity(accountId: string): {
  uaid: string;
  aid: string;
  canonical: CanonicalAgent;
} {
  const canonical: CanonicalAgent = {
    registry: "tessera",
    name: "Tessera Buyer",
    version: AGENT_VERSION,
    protocol: "x402",
    nativeId: hederaNativeId(accountId),
    skills: TESSERA_SKILLS,
  };
  return { uaid: uaid(canonical), aid: deriveAid(canonical), canonical };
}

/** A seller's identity, so a buyer can name who it bought from. */
export function sellerIdentity(
  accountId: string,
  displayName: string,
): { uaid: string; aid: string; canonical: CanonicalAgent } {
  const canonical: CanonicalAgent = {
    registry: "tessera",
    name: displayName,
    version: AGENT_VERSION,
    protocol: "x402",
    nativeId: hederaNativeId(accountId),
    skills: [0],
  };
  return { uaid: uaid(canonical), aid: deriveAid(canonical), canonical };
}
