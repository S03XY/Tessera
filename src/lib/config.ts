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

/**
 * The account that signs the x402 leg for MCP calls.
 *
 * An MCP client has no wallet, so it cannot sign a transfer to a seller. The
 * marketplace signs on its behalf out of prepaid balances agents have funded,
 * which makes this account custodial for exactly that float and nothing else —
 * see `lib/wallet.ts` for the ledger that keeps the custody checkable.
 *
 * Defaults to the demo buyer account so a fresh checkout works without a
 * second funded account, and can be split off in production by setting the
 * MCP_TREASURY_* variables.
 */
export const treasury = {
  accountId: process.env.MCP_TREASURY_ACCOUNT_ID ?? process.env.AGENT_ACCOUNT_ID ?? "",
  privateKey: process.env.MCP_TREASURY_KEY ?? process.env.AGENT_PRIVATE_KEY ?? "",
  keyType: (process.env.MCP_TREASURY_KEY_TYPE ?? process.env.AGENT_KEY_TYPE) as
    | "der"
    | "ecdsa"
    | "ed25519"
    | undefined,
};

export const treasuryConfigured = Boolean(treasury.accountId && treasury.privateKey);

/** Tools one MCP server may publish before the catalogue is truncated. */
export const MCP_MAX_TOOLS = envInt(process.env.MCP_MAX_TOOLS, 40);

/**
 * Baseline deposit a seller must hold to keep listings active (10 ℏ).
 *
 * Also the fallback for any credential we do not recognise, so an unfamiliar
 * value never lowers the bar by accident.
 */
export const MIN_DEPOSIT_TINYBARS = 1_000_000_000n;

/**
 * The deposit, priced by how strongly the seller proved they are a person.
 *
 * The deposit exists to make a bad listing cost the seller something, so what
 * it really prices is how cheaply this seller could be replaced by a fresh
 * one. That is exactly what a personhood credential measures: an Orb-verified
 * seller cannot mint a second identity at all, so less collateral is needed;
 * a device-level "proof" is one app install, so more is.
 *
 * Read the other way round, this is what a thirty-second face check is worth
 * to a seller in working capital — 15 ℏ they do not have to lock up. That is a
 * concrete answer to where a low-friction, low-assurance credential earns its
 * place: not as a gate that decides *whether* you may trade, but as a price
 * that decides *on what terms*.
 */
export const DEPOSIT_BY_CREDENTIAL: Record<string, bigint> = {
  orb: 500_000_000n,
  passport: 500_000_000n,
  secure_document: 500_000_000n,

  selfie_check: 1_000_000_000n,
  proof_of_human: 1_000_000_000n,
  document: 1_000_000_000n,

  // One human can hold several devices, so this proves the least and costs
  // the most. It is still allowed — the point is that it is priced, not banned.
  device: 2_500_000_000n,
};

/** What this seller must hold, given the credential they actually proved. */
export function requiredDeposit(credential: string | null | undefined): bigint {
  if (!credential) return MIN_DEPOSIT_TINYBARS;
  return DEPOSIT_BY_CREDENTIAL[credential] ?? MIN_DEPOSIT_TINYBARS;
}

/**
 * The same rule as SQL, for queries that filter the catalogue.
 *
 * Generated from the map above so the two cannot drift apart. Every value is
 * one of our own constants and every key one of our own identifiers, so there
 * is nothing here a caller could influence.
 */
export function requiredDepositSql(column = "sel.world_credential"): string {
  const arms = Object.entries(DEPOSIT_BY_CREDENTIAL)
    .map(([credential, amount]) => `WHEN '${credential}' THEN ${amount}`)
    .join(" ");
  return `CASE ${column} ${arms} ELSE ${MIN_DEPOSIT_TINYBARS} END`;
}

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
 * Environment parsing must never throw at module load. A malformed value here
 * would take down every route in the application, not just the feature it
 * configures — so a bad value degrades to the default and the feature reports
 * itself unconfigured instead.
 */
function envInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

