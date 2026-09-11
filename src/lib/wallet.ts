import { randomBytes } from "node:crypto";
import { query, queryOne, transaction } from "@/lib/db";
import { hashToken } from "@/lib/hash";
import { formatAmount } from "@/lib/money";

/**
 * Agent funding and spend authority.
 *
 * An MCP client cannot sign a Hedera transfer. Claude Desktop has no wallet;
 * neither does a cron job calling a tool. The obvious workaround — have the
 * marketplace hold a private key for every buyer — is worse than the problem,
 * because it makes us the custodian of everyone's funds with nothing but our
 * own good behaviour standing between a buyer and their balance.
 *
 * What this module does instead is narrow that custody to something bounded
 * and checkable. An agent funds a balance from its own wallet in a transaction
 * anyone can find on HashScan. Every movement of that balance writes an
 * append-only ledger row carrying the balance *after* the movement, so the
 * ledger can be replayed and reconciled against `agents.balance` rather than
 * trusted. And no spend is authorised without passing four independent gates.
 *
 * The gates are ordered deliberately: cheapest and most specific first, so a
 * refusal names the actual reason rather than the first one that happened to
 * be evaluated.
 */

/* ------------------------------------------------------------------- Types */

export interface AgentAccount {
  id: string;
  label: string;
  owner_account: string;
  agent_account: string;
  per_call_cap: string | null;
  per_day_cap: string | null;
  balance: string;
  asset: string;
  spent_total: string;
  revoked_at: string | null;
  created_at: string;
  /**
   * The human behind this agent, if one has been proven.
   *
   * Not unique across agents, unlike a seller's: one person may run many
   * agents. What it buys is a shared free-call allowance rather than an
   * exclusive identity — see `@/lib/quota`.
   */
  verified_at: string | null;
}

export type LedgerKind = "deposit" | "debit" | "refund" | "withdrawal" | "adjustment";

export interface LedgerEntry {
  id: string;
  agent_id: string;
  kind: LedgerKind;
  amount: string;
  asset: string;
  balance_after: string;
  call_id: string | null;
  tx: string | null;
  memo: string | null;
  created_at: string;
}

/** Why a spend was refused. Each maps to exactly one gate below. */
export type RefusalCode =
  | "agent_revoked"
  | "per_call_cap_exceeded"
  | "insufficient_balance"
  | "daily_cap_exceeded";

export class WalletError extends Error {
  readonly code: RefusalCode | "insufficient_balance" | "duplicate_deposit" | "invalid_amount";

  constructor(
    code: WalletError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export interface SpendDecision {
  allowed: boolean;
  reason: RefusalCode | null;
  message: string;
  /** What the agent could still spend on a single call, right now. */
  headroom: bigint;
  balance: bigint;
  spentToday: bigint;
  perCallCap: bigint | null;
  perDayCap: bigint | null;
}

/* ---------------------------------------------------------------- Tokens */

/** Tokens are prefixed so a leaked one is recognisable in logs and diffs. */
const TOKEN_PREFIX = "tsa_";

export function generateAgentToken(): { token: string; hash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * Deliberately strict about the scheme. Accepting a bare token would mean a
 * client that sends `Authorization: <api-key-for-something-else>` silently
 * authenticates here if the strings ever collide.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolves a bearer token to an agent.
 *
 * Looks up by hash, never by the token itself — the column stores a digest, so
 * a database leak does not hand over working credentials. A revoked agent
 * resolves to null rather than to a row, so no caller can forget to check.
 */
export async function authenticateAgent(token: string | null): Promise<AgentAccount | null> {
  if (!token || typeof token !== "string" || token.length < 8) return null;
  return queryOne<AgentAccount>(
    `SELECT * FROM agents WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

export async function getAgentById(id: string): Promise<AgentAccount | null> {
  return queryOne<AgentAccount>(`SELECT * FROM agents WHERE id = $1`, [id]);
}

/* -------------------------------------------------------------- Registration */

export interface RegisterAgentInput {
  label: string;
  ownerAccount: string;
  agentAccount: string;
  perCallCap?: bigint | null;
  perDayCap?: bigint | null;
}

/**
 * Registers an agent and returns the token *once*.
 *
 * The plaintext token is never stored and cannot be recovered, which is the
 * only property that makes the hash-at-rest design meaningful.
 */
export async function registerAgent(
  input: RegisterAgentInput,
): Promise<{ agent: AgentAccount; token: string }> {
  const { token, hash } = generateAgentToken();

  const agent = await queryOne<AgentAccount>(
    `INSERT INTO agents (label, owner_account, agent_account, token_hash, per_call_cap, per_day_cap)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      input.label,
      input.ownerAccount,
      input.agentAccount,
      hash,
      input.perCallCap?.toString() ?? null,
      input.perDayCap?.toString() ?? null,
    ],
  );

  if (!agent) throw new Error("agent registration returned no row");
  return { agent, token };
}

export async function revokeAgent(agentId: string): Promise<void> {
  await query(`UPDATE agents SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    agentId,
  ]);
}

/* ------------------------------------------------------------------ Reads */

/**
 * Spent in the trailing 24 hours, from the ledger rather than from a counter.
 *
 * Refunds are subtracted, because a call that failed and was refunded did not
 * consume the day's budget — billing an agent's daily cap for a delivery it
 * never received would be the marketplace keeping something it did not earn.
 */
export async function spentToday(agentId: string): Promise<bigint> {
  const row = await queryOne<{ total: string }>(
    `SELECT coalesce(
              sum(CASE WHEN kind = 'debit'  THEN amount
                       WHEN kind = 'refund' THEN -amount
                       ELSE 0 END), 0)::text AS total
       FROM agent_ledger
      WHERE agent_id = $1 AND created_at > now() - interval '24 hours'`,
    [agentId],
  );
  const total = BigInt(row?.total ?? "0");
  return total > 0n ? total : 0n;
}

export async function ledgerFor(agentId: string, limit = 50): Promise<LedgerEntry[]> {
  return query<LedgerEntry>(
    `SELECT * FROM agent_ledger WHERE agent_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 500)],
  );
}

/**
 * Recomputes the balance from the ledger.
 *
 * Exists so that "the ledger is authoritative" is a checkable claim rather
 * than a comment. The reconciliation endpoint and the tests both use it to
 * assert that no code path has moved a balance without recording why.
 */
export async function replayBalance(agentId: string): Promise<bigint> {
  const row = await queryOne<{ total: string }>(
    `SELECT coalesce(
              sum(CASE WHEN kind IN ('deposit','refund')      THEN amount
                       WHEN kind IN ('debit','withdrawal')    THEN -amount
                       ELSE 0 END), 0)::text AS total
       FROM agent_ledger WHERE agent_id = $1`,
    [agentId],
  );
  return BigInt(row?.total ?? "0");
}

/* ---------------------------------------------------------------- Authority */

/**
 * Whether this agent may spend this amount right now.
 *
 * Every gate here is enforced by this marketplace: the balance, the per-call
 * cap and the daily cap. They are checked before a debit rather than after,
 * so a refusal never moves money.
 */
export async function authoriseSpend(
  agent: AgentAccount,
  amount: bigint,
): Promise<SpendDecision> {
  const balance = BigInt(agent.balance);
  const perCallCap = agent.per_call_cap ? BigInt(agent.per_call_cap) : null;
  const perDayCap = agent.per_day_cap ? BigInt(agent.per_day_cap) : null;
  const spent = await spentToday(agent.id);

  const dayHeadroom = perDayCap === null ? null : max0(perDayCap - spent);
  const headroom = [balance, perCallCap, dayHeadroom]
    .filter((value): value is bigint => value !== null)
    .reduce((low, value) => (value < low ? value : low), balance);

  const base = {
    balance,
    spentToday: spent,
    perCallCap,
    perDayCap,
    headroom: max0(headroom),
  };

  if (agent.revoked_at) {
    return {
      ...base,
      allowed: false,
      reason: "agent_revoked",
      message: "This agent's token has been revoked by its owner.",
      headroom: 0n,
    };
  }

  if (amount <= 0n) {
    // Not a refusal code: a non-positive quote is a bug upstream, not a policy
    // decision, and must not be silently allowed through as a free call.
    return {
      ...base,
      allowed: false,
      reason: "per_call_cap_exceeded",
      message: "The quoted amount was not a positive number.",
    };
  }

  if (perCallCap !== null && amount > perCallCap) {
    return {
      ...base,
      allowed: false,
      reason: "per_call_cap_exceeded",
      message:
        `This call quotes ${formatAmount(amount)} ℏ, above the per-call cap of ` +
        `${formatAmount(perCallCap)} ℏ set by the agent's owner.`,
    };
  }

  if (amount > balance) {
    return {
      ...base,
      allowed: false,
      reason: "insufficient_balance",
      message:
        `This call quotes ${formatAmount(amount)} ℏ but the balance is ` +
        `${formatAmount(balance)} ℏ. Fund the agent to continue.`,
    };
  }

  if (perDayCap !== null && spent + amount > perDayCap) {
    return {
      ...base,
      allowed: false,
      reason: "daily_cap_exceeded",
      message:
        `Today's spend of ${formatAmount(spent)} ℏ plus ${formatAmount(amount)} ℏ would ` +
        `exceed the daily cap of ${formatAmount(perDayCap)} ℏ. The window is a rolling 24 hours.`,
    };
  }

  return { ...base, allowed: true, reason: null, message: "Within all limits." };
}

/* ----------------------------------------------------------------- Writes */

export interface DepositInput {
  agentId: string;
  amount: bigint;
  /** The Hedera transaction that moved the funds. Credited exactly once. */
  tx: string;
  memo?: string;
}

/**
 * Credits a funding transaction.
 *
 * Idempotent on `tx` through a unique index rather than a read-then-write
 * check, because two concurrent submissions of the same transaction would both
 * pass a check and both credit. The database is the only place that
 * serialisation is free.
 */
export async function creditDeposit(
  input: DepositInput,
): Promise<{ balance: bigint; duplicate: boolean }> {
  if (input.amount <= 0n) {
    throw new WalletError("invalid_amount", "A deposit must be a positive amount.");
  }

  try {
    return await transaction(async (client) => {
      const updated = await client.query<{ balance: string }>(
        `UPDATE agents SET balance = balance + $2::numeric
          WHERE id = $1 RETURNING balance`,
        [input.agentId, input.amount.toString()],
      );

      if (updated.rowCount === 0) {
        throw new WalletError("invalid_amount", "No such agent.");
      }

      const balance = updated.rows[0].balance;

      await client.query(
        `INSERT INTO agent_ledger (agent_id, kind, amount, balance_after, tx, memo)
         VALUES ($1,'deposit',$2,$3,$4,$5)`,
        [input.agentId, input.amount.toString(), balance, input.tx, input.memo ?? null],
      );

      return { balance: BigInt(balance), duplicate: false };
    });
  } catch (err) {
    // 23505 is unique_violation: this transaction was already credited, and
    // the rollback has undone the balance increment.
    if (isUniqueViolation(err)) {
      const agent = await getAgentById(input.agentId);
      return { balance: BigInt(agent?.balance ?? "0"), duplicate: true };
    }
    throw err;
  }
}

export interface DebitInput {
  agentId: string;
  amount: bigint;
  callId?: string | null;
  tx?: string | null;
  memo?: string;
}

/**
 * Draws down a balance for a settled call.
 *
 * The guard is in the UPDATE's WHERE clause, not in application code above it.
 * Two tool calls arriving at once against a balance that only covers one must
 * result in exactly one success, and only the row lock the UPDATE takes can
 * promise that — a read, a comparison, and a write cannot.
 */
export async function debit(input: DebitInput): Promise<{ balance: bigint }> {
  if (input.amount <= 0n) {
    throw new WalletError("invalid_amount", "A debit must be a positive amount.");
  }

  return transaction(async (client) => {
    const updated = await client.query<{ balance: string }>(
      `UPDATE agents
          SET balance     = balance - $2::numeric,
              spent_total = spent_total + $2::numeric
        WHERE id = $1
          AND revoked_at IS NULL
          AND balance >= $2::numeric
      RETURNING balance`,
      [input.agentId, input.amount.toString()],
    );

    if (updated.rowCount === 0) {
      throw new WalletError(
        "insufficient_balance",
        "The agent's balance does not cover this call, or the agent is revoked.",
      );
    }

    const balance = updated.rows[0].balance;

    await client.query(
      `INSERT INTO agent_ledger (agent_id, kind, amount, balance_after, call_id, tx, memo)
       VALUES ($1,'debit',$2,$3,$4,$5,$6)`,
      [
        input.agentId,
        input.amount.toString(),
        balance,
        input.callId ?? null,
        input.tx ?? null,
        input.memo ?? null,
      ],
    );

    return { balance: BigInt(balance) };
  });
}

/**
 * Returns funds for a call that was charged and should not have been.
 *
 * Separate from `creditDeposit` because a refund has no funding transaction
 * and must not collide with the deposit uniqueness index — and because the two
 * mean different things in a ledger someone will one day audit.
 */
export async function refund(input: {
  agentId: string;
  amount: bigint;
  callId?: string | null;
  memo?: string;
}): Promise<{ balance: bigint }> {
  if (input.amount <= 0n) {
    throw new WalletError("invalid_amount", "A refund must be a positive amount.");
  }

  return transaction(async (client) => {
    const updated = await client.query<{ balance: string }>(
      `UPDATE agents
          SET balance     = balance + $2::numeric,
              spent_total = GREATEST(spent_total - $2::numeric, 0)
        WHERE id = $1 RETURNING balance`,
      [input.agentId, input.amount.toString()],
    );

    if (updated.rowCount === 0) {
      throw new WalletError("invalid_amount", "No such agent.");
    }

    const balance = updated.rows[0].balance;

    await client.query(
      `INSERT INTO agent_ledger (agent_id, kind, amount, balance_after, call_id, memo)
       VALUES ($1,'refund',$2,$3,$4,$5)`,
      [input.agentId, input.amount.toString(), balance, input.callId ?? null, input.memo ?? null],
    );

    return { balance: BigInt(balance) };
  });
}

/* ------------------------------------------------------------------ Helpers */

function max0(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}
