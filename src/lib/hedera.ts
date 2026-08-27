import {
  Client,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_NETWORK, operator, chainConfigured } from "@/lib/config";

/**
 * Hedera client for the marketplace's own transactions (HCS receipts, topic
 * creation). Payments never come through here — those are the facilitator's.
 */

export class ChainNotConfiguredError extends Error {
  constructor() {
    super(
      "Hedera operator credentials are not configured. Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in .env.local.",
    );
    this.name = "ChainNotConfiguredError";
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __tollgateHedera: Client | undefined;
}

/** Accepts DER, ECDSA and ED25519 key encodings without the caller choosing. */
export function parsePrivateKey(raw: string): PrivateKey {
  const value = raw.trim();
  const attempts = [
    () => PrivateKey.fromStringDer(value),
    () => PrivateKey.fromStringECDSA(value),
    () => PrivateKey.fromStringED25519(value),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      continue;
    }
  }
  throw new Error("HEDERA_OPERATOR_KEY is not a recognisable private key encoding");
}

export function hederaClient(): Client {
  if (!chainConfigured) throw new ChainNotConfiguredError();
  if (globalThis.__tollgateHedera) return globalThis.__tollgateHedera;

  const client =
    HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(operator.accountId, parsePrivateKey(operator.privateKey));
  // Serverless invocations are short; do not let a stuck node hang the request.
  client.setRequestTimeout(15_000);

  globalThis.__tollgateHedera = client;
  return client;
}

/** Creates the receipt topic once, for operators bootstrapping a deployment. */
export async function createReceiptTopic(memo = "Tollgate call receipts"): Promise<string> {
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
    .setTransactionMemo("Tollgate dispute refund")
    .execute(client);

  // execute() only pre-checks; consensus failures surface via the receipt.
  await response.getReceipt(client);

  return response.transactionId.toString();
}
