import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { hashToken } from "@/lib/hash";
import {
  authenticateAgent,
  authoriseSpend,
  creditDeposit,
  debit,
  generateAgentToken,
  getAgentById,
  ledgerFor,
  parseBearer,
  refund,
  registerAgent,
  replayBalance,
  revokeAgent,
  spentToday,
  WalletError,
  type AgentAccount,
} from "@/lib/wallet";

/**
 * These tests create their own agents and delete them afterwards, so they can
 * run against the seeded development database without disturbing it. Every
 * fixture is tagged with the same label prefix and cleaned up in afterAll.
 */

const LABEL = "__wallet_test__";
const created: string[] = [];

async function makeAgent(
  overrides: { perCallCap?: bigint | null; perDayCap?: bigint | null; balance?: bigint } = {},
): Promise<{ agent: AgentAccount; token: string }> {
  const { agent, token } = await registerAgent({
    label: `${LABEL}${created.length}`,
    ownerAccount: "0.0.111111",
    agentAccount: "0.0.222222",
    perCallCap: overrides.perCallCap ?? null,
    perDayCap: overrides.perDayCap ?? null,
  });
  created.push(agent.id);

  if (overrides.balance && overrides.balance > 0n) {
    await creditDeposit({
      agentId: agent.id,
      amount: overrides.balance,
      tx: `seed-${agent.id}`,
    });
  }

  const funded = (await getAgentById(agent.id)) as AgentAccount;
  return { agent: funded, token };
}

afterAll(async () => {
  if (created.length) {
    await query(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [created]);
  }
});

beforeEach(() => {
  // Nothing shared between cases; each builds its own agent.
});

/* ------------------------------------------------------------------ tokens */

describe("generateAgentToken", () => {
  it("issues a prefixed token whose stored form is a hash", () => {
    const { token, hash } = generateAgentToken();
    expect(token.startsWith("tsa_")).toBe(true);
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateAgentToken().token));
    expect(tokens.size).toBe(200);
  });
});

describe("parseBearer", () => {
  it("accepts a well-formed header in any case", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
    expect(parseBearer("  Bearer   abc123  ")).toBe("abc123");
  });

  it("refuses anything that is not a bearer scheme", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("abc123")).toBeNull();
    expect(parseBearer("Basic abc123")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
  });
});

/* ---------------------------------------------------------- authentication */

describe("authenticateAgent", () => {
  it("resolves a live token to its agent", async () => {
    const { agent, token } = await makeAgent();
    const found = await authenticateAgent(token);
    expect(found?.id).toBe(agent.id);
  });

  it("stores only the hash, never the token", async () => {
    const { agent, token } = await makeAgent();
    const row = await query<{ token_hash: string }>(
      `SELECT token_hash FROM agents WHERE id = $1`,
      [agent.id],
    );
    expect(row[0].token_hash).toBe(hashToken(token));
    expect(row[0].token_hash).not.toBe(token);
  });

  it("refuses an unknown, empty or malformed token", async () => {
    expect(await authenticateAgent(null)).toBeNull();
    expect(await authenticateAgent("")).toBeNull();
    expect(await authenticateAgent("short")).toBeNull();
    expect(await authenticateAgent("tsa_nonexistent_token_value_here")).toBeNull();
  });

  it("refuses a revoked token", async () => {
    const { agent, token } = await makeAgent();
    expect(await authenticateAgent(token)).not.toBeNull();

    await revokeAgent(agent.id);
    expect(await authenticateAgent(token)).toBeNull();
  });
});

/* -------------------------------------------------------------- deposits */

describe("creditDeposit", () => {
  it("credits the balance and writes a ledger row", async () => {
    const { agent } = await makeAgent();
    const result = await creditDeposit({
      agentId: agent.id,
      amount: 1_000_000n,
      tx: `dep-${agent.id}-1`,
      memo: "initial funding",
    });

    expect(result.balance).toBe(1_000_000n);
    expect(result.duplicate).toBe(false);

    const ledger = await ledgerFor(agent.id);
    expect(ledger[0].kind).toBe("deposit");
    expect(ledger[0].amount).toBe("1000000");
    expect(ledger[0].balance_after).toBe("1000000");
    expect(ledger[0].memo).toBe("initial funding");
  });

  it("credits the same transaction exactly once", async () => {
    const { agent } = await makeAgent();
    const tx = `dup-${agent.id}`;

    const first = await creditDeposit({ agentId: agent.id, amount: 500n, tx });
    const second = await creditDeposit({ agentId: agent.id, amount: 500n, tx });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.balance).toBe(500n);

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("500");
  });

  it("does not credit when two identical deposits race", async () => {
    const { agent } = await makeAgent();
    const tx = `race-${agent.id}`;

    const results = await Promise.all([
      creditDeposit({ agentId: agent.id, amount: 700n, tx }),
      creditDeposit({ agentId: agent.id, amount: 700n, tx }),
    ]);

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("700");
  });

  it("refuses a non-positive deposit", async () => {
    const { agent } = await makeAgent();
    await expect(creditDeposit({ agentId: agent.id, amount: 0n, tx: "z" })).rejects.toThrow(
      WalletError,
    );
    await expect(creditDeposit({ agentId: agent.id, amount: -5n, tx: "z" })).rejects.toThrow(
      /positive/,
    );
  });
});

/* ----------------------------------------------------------------- debits */

describe("debit", () => {
  it("draws down the balance and records the call", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    const result = await debit({ agentId: agent.id, amount: 2_500n, memo: "call" });

    expect(result.balance).toBe(7_500n);

    const ledger = await ledgerFor(agent.id);
    expect(ledger[0].kind).toBe("debit");
    expect(ledger[0].balance_after).toBe("7500");
  });

  it("increases spent_total as the balance falls", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await debit({ agentId: agent.id, amount: 1_000n });
    await debit({ agentId: agent.id, amount: 2_000n });

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("7000");
    expect(fresh?.spent_total).toBe("3000");
  });

  it("refuses to overdraw", async () => {
    const { agent } = await makeAgent({ balance: 100n });
    await expect(debit({ agentId: agent.id, amount: 101n })).rejects.toThrow(WalletError);

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("100");
  });

  it("allows spending the balance down to exactly zero", async () => {
    const { agent } = await makeAgent({ balance: 100n });
    const result = await debit({ agentId: agent.id, amount: 100n });
    expect(result.balance).toBe(0n);
  });

  it("refuses a debit against a revoked agent", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await revokeAgent(agent.id);
    await expect(debit({ agentId: agent.id, amount: 1n })).rejects.toThrow(
      /revoked|does not cover/,
    );
  });

  it("refuses a non-positive debit", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await expect(debit({ agentId: agent.id, amount: 0n })).rejects.toThrow(/positive/);
  });

  it("lets exactly one of two racing debits win", async () => {
    // The guard is in the UPDATE's WHERE clause precisely for this case: a
    // read-then-write would let both through and drive the balance negative.
    const { agent } = await makeAgent({ balance: 100n });

    const results = await Promise.allSettled([
      debit({ agentId: agent.id, amount: 100n }),
      debit({ agentId: agent.id, amount: 100n }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("0");
  });

  it("never drives a balance negative under heavy contention", async () => {
    const { agent } = await makeAgent({ balance: 1_000n });

    // Twenty concurrent debits of 100 against a balance that covers ten.
    const attempts = Array.from({ length: 20 }, () =>
      debit({ agentId: agent.id, amount: 100n }).catch(() => null),
    );
    const settled = await Promise.all(attempts);

    expect(settled.filter(Boolean)).toHaveLength(10);
    const fresh = await getAgentById(agent.id);
    expect(fresh?.balance).toBe("0");
    expect(await replayBalance(agent.id)).toBe(0n);
  });
});

/* ---------------------------------------------------------------- refunds */

describe("refund", () => {
  it("returns funds and records the reason", async () => {
    const { agent } = await makeAgent({ balance: 5_000n });
    await debit({ agentId: agent.id, amount: 1_000n });
    const result = await refund({ agentId: agent.id, amount: 1_000n, memo: "upstream failed" });

    expect(result.balance).toBe(5_000n);
    const ledger = await ledgerFor(agent.id);
    expect(ledger[0].kind).toBe("refund");
    expect(ledger[0].memo).toBe("upstream failed");
  });

  it("does not drive spent_total below zero", async () => {
    const { agent } = await makeAgent({ balance: 5_000n });
    await refund({ agentId: agent.id, amount: 1_000n });
    const fresh = await getAgentById(agent.id);
    expect(fresh?.spent_total).toBe("0");
  });

  it("refuses a non-positive refund", async () => {
    const { agent } = await makeAgent({ balance: 100n });
    await expect(refund({ agentId: agent.id, amount: 0n })).rejects.toThrow(/positive/);
  });
});

/* ------------------------------------------------------- ledger integrity */

describe("the ledger is authoritative", () => {
  it("replays to exactly the stored balance", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await debit({ agentId: agent.id, amount: 3_000n });
    await debit({ agentId: agent.id, amount: 1_500n });
    await refund({ agentId: agent.id, amount: 500n });
    await creditDeposit({ agentId: agent.id, amount: 2_000n, tx: `top-${agent.id}` });

    const fresh = await getAgentById(agent.id);
    const replayed = await replayBalance(agent.id);
    expect(replayed.toString()).toBe(fresh?.balance);
    expect(replayed).toBe(8_000n);
  });

  it("counts today's spend net of refunds", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await debit({ agentId: agent.id, amount: 3_000n });
    await refund({ agentId: agent.id, amount: 1_000n });
    expect(await spentToday(agent.id)).toBe(2_000n);
  });

  it("never reports a negative day's spend", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await refund({ agentId: agent.id, amount: 1_000n });
    expect(await spentToday(agent.id)).toBe(0n);
  });
});

/* -------------------------------------------------------------- authority */

describe("authoriseSpend", () => {
  it("allows a spend inside every limit", async () => {
    const { agent } = await makeAgent({
      balance: 10_000n,
      perCallCap: 5_000n,
      perDayCap: 8_000n,
    });
    const decision = await authoriseSpend(agent, 1_000n);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.headroom).toBe(5_000n);
  });

  it("reports headroom as the tightest of the three limits", async () => {
    const { agent } = await makeAgent({
      balance: 10_000n,
      perCallCap: 9_000n,
      perDayCap: 2_000n,
    });
    const decision = await authoriseSpend(agent, 1n);
    expect(decision.headroom).toBe(2_000n);
  });

  it("refuses a revoked agent before anything else", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    await revokeAgent(agent.id);
    const revoked = (await getAgentById(agent.id)) as AgentAccount;

    const decision = await authoriseSpend(revoked, 1n);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("agent_revoked");
    expect(decision.headroom).toBe(0n);
  });

  it("refuses a quote above the per-call cap, naming the cap", async () => {
    const { agent } = await makeAgent({ balance: 10_000n, perCallCap: 500n });
    const decision = await authoriseSpend(agent, 600n);
    expect(decision.reason).toBe("per_call_cap_exceeded");
    expect(decision.message).toMatch(/per-call cap/);
  });

  it("refuses a quote above the balance", async () => {
    const { agent } = await makeAgent({ balance: 100n });
    const decision = await authoriseSpend(agent, 101n);
    expect(decision.reason).toBe("insufficient_balance");
    expect(decision.message).toMatch(/Fund the agent/);
  });

  it("refuses a quote that would breach the daily cap", async () => {
    const { agent } = await makeAgent({ balance: 10_000n, perDayCap: 1_000n });
    await debit({ agentId: agent.id, amount: 900n });
    const fresh = (await getAgentById(agent.id)) as AgentAccount;

    const decision = await authoriseSpend(fresh, 200n);
    expect(decision.reason).toBe("daily_cap_exceeded");
    expect(decision.spentToday).toBe(900n);
  });

  it("allows a spend that exactly reaches the daily cap", async () => {
    const { agent } = await makeAgent({ balance: 10_000n, perDayCap: 1_000n });
    await debit({ agentId: agent.id, amount: 900n });
    const fresh = (await getAgentById(agent.id)) as AgentAccount;

    expect((await authoriseSpend(fresh, 100n)).allowed).toBe(true);
  });

  it("refuses a non-positive quote rather than treating it as free", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    expect((await authoriseSpend(agent, 0n)).allowed).toBe(false);
    expect((await authoriseSpend(agent, -1n)).allowed).toBe(false);
  });

  it("treats absent caps as unlimited, bounded only by balance", async () => {
    const { agent } = await makeAgent({ balance: 10_000n });
    const decision = await authoriseSpend(agent, 10_000n);
    expect(decision.allowed).toBe(true);
    expect(decision.perCallCap).toBeNull();
    expect(decision.perDayCap).toBeNull();
    expect(decision.headroom).toBe(10_000n);
  });
});
