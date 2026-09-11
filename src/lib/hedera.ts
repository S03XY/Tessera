import {
  Client,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_NETWORK, MIRROR_NODE_URL, operator, chainConfigured } from "@/lib/config";

/**
 * Hedera client for the marketplace's own transactions (HCS receipts, topic
 * creation). Payments never come through here — those are the facilitator's.
 */

/** Hedera account ids look like `0.0.12345`. */
export function isHederaAccountId(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value.trim());
}

export class ChainNotConfiguredError extends Error {
  constructor() {
    super(
      "Hedera operator credentials are not configured. Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env.local.",
    );
    this.name = "ChainNotConfiguredError";
  }
}

declare global {
  var __tesseraHedera: Client | undefined;
}

export type KeyKind = "der" | "ecdsa" | "ed25519";

/**
 * Parses a Hedera private key.
 *
 * Do NOT try the parsers in sequence and take the first that does not throw:
 * `fromStringDer`, `fromStringECDSA` and `fromStringED25519` all accept raw
 * hex and silently derive a key on *their own* curve. Feeding a secp256k1 key
 * to `fromStringDer` yields a valid-looking Ed25519 key whose signatures the
 * network rejects as INVALID_SIGNATURE, which is very hard to diagnose.
 *
 * So: DER strings carry their own algorithm OID and are unambiguous. Raw hex
 * is ambiguous and defaults to ECDSA (what the Hedera portal hands out as
 * "HEX Encoded Private Key"), overridable with an explicit hint.
 */
export function parsePrivateKey(raw: string, hint?: KeyKind): PrivateKey {
  const value = raw.trim();
  const hex = value.replace(/^0x/i, "");

  if (!/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Hedera private key must be hex encoded");
  }

  if (hint === "ecdsa") return PrivateKey.fromStringECDSA(hex);
  if (hint === "ed25519") return PrivateKey.fromStringED25519(hex);
  if (hint === "der") return PrivateKey.fromStringDer(hex);

  // A DER private key begins with a SEQUENCE header and embeds its curve OID.
  if (/^30[0-9a-f]{2}/i.test(hex) && hex.length > 68) {
    return PrivateKey.fromStringDer(hex);
  }

  if (hex.length === 64) return PrivateKey.fromStringECDSA(hex);

  throw new Error(
    "Unrecognised Hedera private key encoding. Provide DER, or 32-byte hex with an explicit key type.",
  );
}

/**
 * Confirms a private key actually controls an account, by comparing the
 * derived public key with the one consensus has on file. Cheap insurance
 * against a silently mis-parsed curve.
 */
export async function assertKeyMatchesAccount(
  accountId: string,
  key: PrivateKey,
): Promise<void> {
  const response = await fetch(`${MIRROR_NODE_URL}/api/v1/accounts/${accountId}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Could not read account ${accountId} from the mirror node.`);
  }

  const body = (await response.json()) as { key?: { key?: string } };
  const onChain = body.key?.key?.toLowerCase();
  if (!onChain) throw new Error(`Account ${accountId} has no public key on file.`);

  const derived = key.publicKey.toStringRaw().toLowerCase();
  if (derived !== onChain) {
    throw new Error(
      `Key mismatch for ${accountId}: derived public key ${derived.slice(0, 16)}… ` +
        `does not match ${onChain.slice(0, 16)}… on chain. Wrong key, or wrong curve.`,
    );
  }
}

export function hederaClient(): Client {
  if (!chainConfigured) throw new ChainNotConfiguredError();
  if (globalThis.__tesseraHedera) return globalThis.__tesseraHedera;

  const client =
    HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    operator.accountId,
    parsePrivateKey(operator.privateKey, operator.keyType),
  );
  // Serverless invocations are short; do not let a stuck node hang the request.
  client.setRequestTimeout(15_000);

  globalThis.__tesseraHedera = client;
  return client;
}

/** Creates the receipt topic once, for operators bootstrapping a deployment. */
export async function createReceiptTopic(memo = "Tessera call receipts"): Promise<string> {
  const client = hederaClient();
  const response = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client);
  const receipt = await response.getReceipt(client);
  const topicId = receipt.topicId;
  if (!topicId) throw new Error("topic creation returned no topic id");
  return topicId.toString();
}

export interface SubmittedMessage {
  topicId: string;
  sequenceNumber: string;
  transactionId: string;
}

export async function submitReceipt(
  topicId: string,
  message: unknown,
): Promise<SubmittedMessage> {
  const client = hederaClient();
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(message))
    .execute(client);

  const receipt = await response.getReceipt(client);

  return {
    topicId,
    sequenceNumber: receipt.topicSequenceNumber?.toString() ?? "0",
    transactionId: response.transactionId.toString(),
  };
}

/**
 * Pays HBAR from the marketplace operator to `toAccountId`.
 *
 * Used for dispute refunds, which come out of the seller's deposit held by
 * the marketplace. Returns the transaction id so the refund is auditable on
 * HashScan next to the original payment.
 */
export async function transferHbar(
  toAccountId: string,
  tinybars: bigint,
): Promise<string> {
  if (tinybars <= 0n) throw new Error("refund amount must be positive");

  const client = hederaClient();
  const amount = Hbar.fromTinybars(tinybars.toString());

  const response = await new TransferTransaction()
    .addHbarTransfer(operator.accountId, amount.negated())
    .addHbarTransfer(toAccountId, amount)
    .setTransactionMemo("Tessera dispute refund")
    .execute(client);

  // execute() only pre-checks; consensus failures surface via the receipt.
  await response.getReceipt(client);

  return response.transactionId.toString();
}

/* ---------------------------------------------------------- Mirror Node ---- */

/**
 * Converts a user-facing transaction id (`0.0.123@1756290000.000000000`) to the
 * dashed form the Mirror Node REST API expects (`0.0.123-1756290000-000000000`).
 */
export function toMirrorTransactionId(transactionId: string): string {
  const trimmed = transactionId.trim();
  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      "transaction id must look like 0.0.12345@1756290000.000000000",
    );
  }
  return `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`;
}

export interface DepositCheck {
  ok: boolean;
  amount: bigint;
  reason?: string;
}

/**
 * Confirms on-chain that `fromAccount` really sent HBAR to the marketplace
 * treasury in the given transaction.
 *
 * The Mirror Node is the source of truth here: the seller supplies only a
 * transaction id, and every figure used to credit the deposit is read back
 * from consensus rather than taken from the request body.
 */
export async function verifyDepositTransfer(
  transactionId: string,
  fromAccount: string,
  toAccount: string,
): Promise<DepositCheck> {
  const mirrorId = toMirrorTransactionId(transactionId);

  const response = await fetch(
    `${MIRROR_NODE_URL}/api/v1/transactions/${encodeURIComponent(mirrorId)}`,
    { cache: "no-store", signal: AbortSignal.timeout(15_000) },
  );

  if (response.status === 404) {
    return { ok: false, amount: 0n, reason: "Transaction not found on the mirror node yet." };
  }
  if (!response.ok) {
    return { ok: false, amount: 0n, reason: `Mirror node returned ${response.status}.` };
  }

  const body = (await response.json()) as {
    transactions?: Array<{
      result?: string;
      transfers?: Array<{ account: string; amount: number }>;
    }>;
  };

  const transaction = body.transactions?.[0];
  if (!transaction) {
    return { ok: false, amount: 0n, reason: "Transaction not found." };
  }
  if (transaction.result !== "SUCCESS") {
    return { ok: false, amount: 0n, reason: `Transaction result was ${transaction.result}.` };
  }

  const transfers = transaction.transfers ?? [];
  const credited = transfers
    .filter((entry) => entry.account === toAccount && entry.amount > 0)
    .reduce((total, entry) => total + BigInt(entry.amount), 0n);
  const debited = transfers
    .filter((entry) => entry.account === fromAccount && entry.amount < 0)
    .reduce((total, entry) => total + BigInt(-entry.amount), 0n);

  if (credited <= 0n) {
    return { ok: false, amount: 0n, reason: `Transaction did not credit ${toAccount}.` };
  }
  if (debited <= 0n) {
    return { ok: false, amount: 0n, reason: `Transaction was not paid by ${fromAccount}.` };
  }

  return { ok: true, amount: credited };
}
