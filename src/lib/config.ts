/**
 * Runtime configuration.
 *
 * Chain-facing features degrade explicitly rather than silently: if the
 * operator keys are absent the UI says so instead of pretending a payment
 * settled. Nothing here fabricates a transaction hash.
 */

export const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL?.replace(/\/+$/, "") ??
  "https://api.testnet.blocky402.com";

export const X402_NETWORK = process.env.X402_NETWORK ?? "hedera:testnet";

export const HEDERA_NETWORK = process.env.HEDERA_NETWORK ?? "testnet";

export const MIRROR_NODE_URL =
  HEDERA_NETWORK === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";

export const HASHSCAN_BASE = `https://hashscan.io/${HEDERA_NETWORK}`;

export function hashscanTx(txId: string): string {
  return `${HASHSCAN_BASE}/transaction/${encodeURIComponent(txId)}`;
}

export function hashscanAccount(accountId: string): string {
  return `${HASHSCAN_BASE}/account/${encodeURIComponent(accountId)}`;
}

export function hashscanTopic(topicId: string): string {
  return `${HASHSCAN_BASE}/topic/${encodeURIComponent(topicId)}`;
}

export const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

/** Marketplace treasury — the account every buyer pays. */
export const operator = {
  accountId: process.env.HEDERA_OPERATOR_ID ?? "",
  privateKey: process.env.HEDERA_OPERATOR_KEY ?? "",
  /** "der" | "ecdsa" | "ed25519". Raw hex is ambiguous; DER is self-describing. */
  keyType: process.env.HEDERA_OPERATOR_KEY_TYPE as
    | "der"
    | "ecdsa"
    | "ed25519"
    | undefined,
  topicId: process.env.HEDERA_RECEIPT_TOPIC_ID ?? "",
};

export const chainConfigured = Boolean(operator.accountId && operator.privateKey);
export const receiptsConfigured = chainConfigured && Boolean(operator.topicId);

/** Minimum deposit a seller must hold to keep listings active (10 ℏ). */
export const MIN_DEPOSIT_TINYBARS = 1_000_000_000n;

/** Window during which a buyer may dispute a delivered call. */
export const DISPUTE_WINDOW_HOURS = 24;

/**
 * The ERC-1400 security token backing seller dispute deposits, issued through
 * Hedera's Asset Tokenization Studio. Issuance lives in ../tollgate-ats; this
 * app only records the id and reads balances over the JSON-RPC relay.
 */
export const DEPOSIT_BOND_TOKEN_ID = process.env.DEPOSIT_BOND_TOKEN_ID ?? "";

/** What the discovery and delivery paths can actually reach on The Graph. */
export function graphMode(): "live" | "unconfigured" {
  return process.env.GRAPH_API_KEY ? "live" : "unconfigured";
}


/**
 * The agent's spending mandate on 1inch Aqua.
 *
 * Aqua exists on Base and Arbitrum mainnet only, with no testnet deployment,
 * so this points wherever the modified SwapVM router was deployed. Left blank,
 * the agent falls back to the per-call cap it enforces itself, and every
 * surface says which of the two is in force.
 */
/**
 * Environment parsing must never throw at module load. A malformed value here
 * would take down every route in the application, not just the feature it
 * configures — so a bad value degrades to the default and the feature reports
 * itself unconfigured instead.
 */
function envBigInt(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    return BigInt(raw.trim());
  } catch {
    return fallback;
  }
}

function envInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export const MANDATE = {
  router: process.env.MANDATE_ROUTER ?? "",
  owner: process.env.MANDATE_OWNER ?? "",
  /** The order hash the daily budget is counted against. */
  orderHash: process.env.MANDATE_ORDER_HASH ?? "",
  mandateId: envInt(process.env.MANDATE_ID, 7),
  dailyCap: envBigInt(process.env.MANDATE_DAILY_CAP, 0n),
  chain: process.env.MANDATE_CHAIN ?? "base",
  rpcUrl: process.env.MANDATE_RPC_URL ?? "https://mainnet.base.org",
  explorerBase: process.env.MANDATE_EXPLORER ?? "https://basescan.org",
  /** Decimals of the token the mandate is denominated in. */
  decimals: envInt(process.env.MANDATE_DECIMALS, 18),
};
