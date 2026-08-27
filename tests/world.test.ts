import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { simulateProof } from "@/lib/world";

/**
 * Selfie Check gate.
 *
 * These exercise the *simulation* path, which stands in for the real
 * credential until World enables it. The rule under test is the one that
 * matters either way: one human maps to exactly one seller account.
 */

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ACCOUNTS = ["0.0.9990001", "0.0.9990002", "0.0.9990003"];

async function verify(body: object) {
  const response = await fetch(`${BASE}/api/world/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) throw new Error(`Gateway not reachable at ${BASE}. Run npm run dev.`);
  const mode = (await health.json()).world_id;
  if (mode !== "simulated") {
    throw new Error(
      `These tests cover the simulation path but world_id mode is "${mode}". ` +
        `Set WORLD_SIMULATION=1, or update this suite for the live flow.`,
    );
  }
});

afterEach(async () => {
  await query(`DELETE FROM sellers WHERE account_id = ANY($1::text[])`, [ACCOUNTS]);
});

describe("simulateProof", () => {
  it("is deterministic for a persona", () => {
    expect(simulateProof("alice").nullifier).toBe(simulateProof("alice").nullifier);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(simulateProof("  Alice ").nullifier).toBe(simulateProof("alice").nullifier);
  });

  it("separates distinct personas", () => {
    expect(simulateProof("alice").nullifier).not.toBe(simulateProof("bob").nullifier);
  });

  it("never claims to be a real credential", () => {
    expect(simulateProof("alice").credential).toBe("selfie_check_simulated");
    expect(simulateProof("alice").nullifier.startsWith("sim_")).toBe(true);
  });
});

describe("verification endpoint", () => {
  it("verifies a new seller and marks the pass as simulated", async () => {
    const { status, body } = await verify({
      account_id: ACCOUNTS[0],
      display_name: "Alice Data",
      persona: "alice",
    });
    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.simulated).toBe(true);
    expect(body.credential).toBe("selfie_check_simulated");
  });

  it("refuses a second account for the same human", async () => {
    await verify({ account_id: ACCOUNTS[0], persona: "alice" });
    const { status, body } = await verify({ account_id: ACCOUNTS[1], persona: "alice" });

    expect(status).toBe(409);
    expect(body.error).toBe("nullifier_already_used");
    expect(body.message).toContain(ACCOUNTS[0]);
  });

  it("allows a different human", async () => {
    await verify({ account_id: ACCOUNTS[0], persona: "alice" });
    const { status } = await verify({ account_id: ACCOUNTS[1], persona: "bob" });
    expect(status).toBe(200);
  });

  it("lets the same human re-verify their own account", async () => {
    await verify({ account_id: ACCOUNTS[0], persona: "alice" });
    const { status } = await verify({ account_id: ACCOUNTS[0], persona: "alice" });
    expect(status).toBe(200);
  });

  it.each([
    ["no persona", { account_id: ACCOUNTS[0] }, 400, "missing_persona"],
    ["bad account id", { account_id: "nope", persona: "x" }, 400, "invalid_account"],
    ["empty body", {}, 400, "invalid_request"],
  ])("refuses %s", async (_label, body, expectedStatus, expectedError) => {
    const result = await verify(body);
    expect(result.status).toBe(expectedStatus);
    expect(result.body.error).toBe(expectedError);
  });
});

describe("the gate still applies to a simulated seller", () => {
  it("refuses a listing until the deposit is posted", async () => {
    await verify({ account_id: ACCOUNTS[0], display_name: "Alice Data", persona: "alice" });

    const response = await fetch(`${BASE}/api/services/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account_id: ACCOUNTS[0],
        name: "Alice Feed",
        description: "A listing attempted before any deposit has been posted.",
        category: "test",
        endpoint_url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        price_amount: "100000",
        price_unit: "per_call",
      }),
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("deposit_too_low");
  });
});
