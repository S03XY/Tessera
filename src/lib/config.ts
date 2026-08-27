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
  topicId: process.env.HEDERA_RECEIPT_TOPIC_ID ?? "",
};

export const chainConfigured = Boolean(operator.accountId && operator.privateKey);
export const receiptsConfigured = chainConfigured && Boolean(operator.topicId);

/** Minimum deposit a seller must hold to keep listings active (10 ℏ). */
export const MIN_DEPOSIT_TINYBARS = 1_000_000_000n;

/** Window during which a buyer may dispute a delivered call. */
export const DISPUTE_WINDOW_HOURS = 24;
