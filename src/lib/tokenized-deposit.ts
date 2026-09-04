/**
 * Reading a tokenized seller deposit.
 *
 * The deposit bond is an ERC-1400 security token issued through Hedera's
 * Asset Tokenization Studio (issuance lives in ../tollgate-ats, because the
 * ATS SDK is a 1.4GB dependency with no business in a serverless build).
 *
 * Reading it needs none of that. ERC-1400 extends ERC-20, so a balance is one
 * `balanceOf` call, and Hedera's JSON-RPC relay speaks plain `eth_call` over
 * HTTP. That keeps this app's dependency footprint unchanged while still
 * showing a seller's deposit as it exists on chain rather than as this
 * database remembers it.
 */

import { HEDERA_NETWORK } from "@/lib/config";

export const JSON_RPC_URL =
  process.env.HEDERA_JSON_RPC_URL ??
  (HEDERA_NETWORK === "mainnet" ? "https://mainnet.hashio.io/api" : "https://testnet.hashio.io/api");

/** `balanceOf(address)` — the first four bytes of its keccak hash. */
const BALANCE_OF_SELECTOR = "0x70a08231";

const RPC_TIMEOUT_MS = 8_000;

export class TokenizedDepositError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenizedDepositError";
  }
}

/**
 * Hedera contract ids (`0.0.12345`) and EVM addresses are both in play here.
 * A contract id becomes a "long-zero" address: the entity number, big-endian,
 * left-padded to 20 bytes.
 */
export function toEvmAddress(idOrAddress: string): string {
  const value = String(idOrAddress).trim();

  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();

  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new TokenizedDepositError(
      `not a Hedera id or EVM address: ${JSON.stringify(idOrAddress)}`,
    );
  }

  const entity = BigInt(match[3]);
  return `0x${entity.toString(16).padStart(40, "0")}`;
}

/** ABI-encodes one address argument: 32 bytes, right-aligned. */
export function encodeAddressArg(address: string): string {
  const bare = toEvmAddress(address).slice(2);
  return bare.padStart(64, "0");
}

export interface DepositBalance {
  tokenId: string;
  holder: string;
  /** Whole units. The bond is issued with zero decimals. */
  units: bigint;
}

/**
 * Reads a holder's deposit units straight from the token contract.
 *
 * Returns null rather than throwing when the chain cannot be reached: a
 * seller page that cannot show an on-chain balance should say so and keep
 * rendering, not 500.
 */
export async function readDepositUnits(
  tokenId: string,
  holder: string,
  rpcUrl: string = JSON_RPC_URL,
): Promise<DepositBalance | null> {
  let to: string;
  let data: string;
  try {
    to = toEvmAddress(tokenId);
    data = `${BALANCE_OF_SELECTOR}${encodeAddressArg(holder)}`;
  } catch {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: { result?: string; error?: { message?: string } };
  try {
    body = await response.json();
  } catch {
    return null;
  }

  // The relay reports a reverted call as a JSON-RPC error, not an HTTP one.
  if (body.error || typeof body.result !== "string") return null;
  if (!/^0x[0-9a-fA-F]*$/.test(body.result) || body.result === "0x") return null;

  try {
    return { tokenId, holder: toEvmAddress(holder), units: BigInt(body.result) };
  } catch {
    return null;
  }
}

/** HashScan link for a tokenized deposit, for a UI that wants to prove itself. */
export function hashscanToken(tokenId: string): string {
  return `https://hashscan.io/${HEDERA_NETWORK}/contract/${encodeURIComponent(tokenId)}`;
}
