#!/usr/bin/env node
/**
 * Provisions the demo on Hedera testnet.
 *
 *   node scripts/provision.mjs
 *
 * The seeded sellers ship with invented account ids, which cannot receive a
 * real transfer. This creates genuine testnet accounts for them, funds each
 * one, opens the HCS receipt topic, and repoints the database at the real
 * ids — so a paid call settles to an account that actually exists and shows
 * up on HashScan.
 *
 * Seller private keys are written to .testnet-accounts.json (gitignored) so
 * the deposit step can sign from those accounts.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import {
  AccountCreateTransaction,
  Client,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const ACCOUNTS_FILE = join(root, ".testnet-accounts.json");
const MIRROR = "https://testnet.mirrornode.hedera.com";

/** Seller accounts get enough to post a deposit and cover fees. */
const SELLER_FUNDING_HBAR = 25;
const DEPOSIT_HBAR = 12;

function operatorKey() {
  const raw = process.env.HEDERA_OPERATOR_KEY?.trim();
  if (!raw) throw new Error("HEDERA_OPERATOR_KEY is not set");
  const type = process.env.HEDERA_OPERATOR_KEY_TYPE;
  const hex = raw.replace(/^0x/i, "");
  if (type === "ecdsa") return PrivateKey.fromStringECDSA(hex);
  if (type === "ed25519") return PrivateKey.fromStringED25519(hex);
  return PrivateKey.fromStringDer(hex);
}

/**
 * Guards against a silently mis-parsed curve: all the fromString* helpers
 * accept raw hex and derive a key on their own curve, so a wrong choice
 * produces a valid-looking key whose signatures the network rejects.
 */
async function assertKeyMatches(accountId, key) {
  const response = await fetch(`${MIRROR}/api/v1/accounts/${accountId}`);
  if (!response.ok) throw new Error(`mirror node lookup failed for ${accountId}`);
  const body = await response.json();
  const onChain = body.key?.key?.toLowerCase();
  const derived = key.publicKey.toStringRaw().toLowerCase();
  if (onChain !== derived) {
    throw new Error(
      `key mismatch for ${accountId}: derived ${derived.slice(0, 20)}… but chain has ${String(
        onChain,
      ).slice(0, 20)}…`,
    );
  }
  console.log(`  key verified against chain for ${accountId}`);
}

function db() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const ssl = /supabase|neon|render|amazonaws/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  return new pg.Client({ connectionString, ssl });
}

async function main() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  if (!operatorId) throw new Error("HEDERA_OPERATOR_ID is not set");

  const key = operatorKey();
  console.log(`operator ${operatorId}`);
  await assertKeyMatches(operatorId, key);

  const client = Client.forTestnet();
  client.setOperator(operatorId, key);
  client.setRequestTimeout(30_000);

  const state = existsSync(ACCOUNTS_FILE)
    ? JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"))
    : { sellers: {}, topicId: null };

  const sql = db();
  await sql.connect();

  try {
    /* ------------------------------------------------- 1. receipt topic */

    if (state.topicId) {
      console.log(`\ntopic ${state.topicId} (existing)`);
    } else {
      const response = await new TopicCreateTransaction()
        .setTopicMemo("Tessera call and refund receipts")
        .execute(client);
      const receipt = await response.getReceipt(client);
      state.topicId = receipt.topicId.toString();
      console.log(`\ntopic ${state.topicId} created`);
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(state, null, 2));
    }

    /* ---------------------------------------------- 2. seller accounts */

    const { rows: sellers } = await sql.query(
      `SELECT id, account_id, display_name
         FROM sellers
        WHERE verification_status = 'verified'
        ORDER BY display_name`,
    );

    console.log(`\nprovisioning ${sellers.length} seller account(s)`);

    for (const seller of sellers) {
      const existing = state.sellers[seller.display_name];

      if (existing) {
        console.log(`  ${seller.display_name.padEnd(18)} ${existing.accountId} (existing)`);
      } else {
        const sellerKey = PrivateKey.generateED25519();
        const response = await new AccountCreateTransaction()
          .setKeyWithoutAlias(sellerKey.publicKey)
          .setInitialBalance(new Hbar(SELLER_FUNDING_HBAR))
          .setAccountMemo(`Tessera seller: ${seller.display_name}`)
          .execute(client);
        const receipt = await response.getReceipt(client);
        const accountId = receipt.accountId.toString();

        state.sellers[seller.display_name] = {
          accountId,
          privateKey: sellerKey.toStringDer(),
          fundedHbar: SELLER_FUNDING_HBAR,
        };
        writeFileSync(ACCOUNTS_FILE, JSON.stringify(state, null, 2));
        console.log(
          `  ${seller.display_name.padEnd(18)} ${accountId} created, ${SELLER_FUNDING_HBAR} h`,
        );
      }

      const record = state.sellers[seller.display_name];

      // Repoint the read model at the real account so 402s quote a payable payTo.
      await sql.query(`UPDATE sellers SET account_id = $2 WHERE id = $1`, [
        seller.id,
        record.accountId,
      ]);
    }

    /* ------------------------------------------- 3. real deposits paid */

    console.log(`\nposting deposits to the treasury ${operatorId}`);

    for (const [name, record] of Object.entries(state.sellers)) {
      if (record.depositTx) {
        console.log(`  ${name.padEnd(18)} ${record.depositTx} (existing)`);
        continue;
      }

      const sellerKey = PrivateKey.fromStringDer(record.privateKey);
      const amount = new Hbar(DEPOSIT_HBAR);

      const transaction = await new TransferTransaction()
        .addHbarTransfer(record.accountId, amount.negated())
        .addHbarTransfer(operatorId, amount)
        .setTransactionMemo("Tessera seller deposit")
        .freezeWith(client)
        .sign(sellerKey);

      const response = await transaction.execute(client);
      await response.getReceipt(client);

      record.depositTx = response.transactionId.toString();
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(state, null, 2));
      console.log(`  ${name.padEnd(18)} ${DEPOSIT_HBAR} h  ${record.depositTx}`);

      // Record it the same way the API would, in atomic units.
      await sql.query(
        `UPDATE sellers
            SET deposit_amount = $2::numeric, deposit_tx = $3
          WHERE display_name = $1`,
        [name, String(DEPOSIT_HBAR * 1e8), record.depositTx],
      );
    }

    /* ------------------------------------------------------ 4. summary */

    const { rows: final } = await sql.query(
      `SELECT display_name, account_id, deposit_amount FROM sellers
        WHERE verification_status = 'verified' ORDER BY display_name`,
    );

    console.log("\n--- provisioned ---");
    for (const row of final) {
      console.log(
        `  ${row.display_name.padEnd(18)} ${row.account_id.padEnd(12)} deposit ${
          Number(row.deposit_amount) / 1e8
        } h`,
      );
    }
    console.log(`\n  receipt topic ${state.topicId}`);
    console.log(`\nAdd to .env.local:\n  HEDERA_RECEIPT_TOPIC_ID=${state.topicId}\n`);
  } finally {
    await sql.end();
    client.close();
  }
}

main().catch((err) => {
  console.error(`\nprovision failed: ${err.message}`);
  process.exit(1);
});
