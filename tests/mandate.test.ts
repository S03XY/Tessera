/**
 * The mandate is the one authority the agent cannot argue with, so the tests
 * that matter are the ones proving it fails closed: an unreadable mandate must
 * never be mistaken for permission.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatMandateUnits,
  mandateRefusal,
  describeRefusal,
  readMandate,
  isMandateConfigured,
  type MandateState,
  type MandateConfig,
} from "@/lib/mandate";

const CONFIGURED: MandateConfig = {
  router: "0xE0819A899d0c8f41166c6F603f90d8ea769af1F8",
  owner: "0x73674fdBA685c417cf1f91f1f81ac3aa8bfCbd49",
  orderHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
  mandateId: 7,
  dailyCap: 25_000_000_000_000_000_000n,
  chain: "base",
  rpcUrl: "http://localhost:8545",
  explorerBase: "https://basescan.org",
  decimals: 18,
};

const UNCONFIGURED: MandateConfig = { ...CONFIGURED, router: "", owner: "", orderHash: "" };

const STATE: MandateState = {
  router: "0xE0819A899d0c8f41166c6F603f90d8ea769af1F8",
  owner: "0x73674fdBA685c417cf1f91f1f81ac3aa8bfCbd49",
  mandateId: 7,
  chain: "base",
  revoked: false,
  spentToday: 0n,
  dailyCap: 25_000_000_000_000_000_000n,
  remaining: 25_000_000_000_000_000_000n,
  explorerUrl: "https://basescan.org/address/0xE0819A899d0c8f41166c6F603f90d8ea769af1F8",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatMandateUnits", () => {
  it("renders whole units", () => {
    expect(formatMandateUnits(25_000_000_000_000_000_000n)).toBe("25");
    expect(formatMandateUnits(0n)).toBe("0");
  });

  it("keeps a short fraction and drops trailing zeros", () => {
    expect(formatMandateUnits(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatMandateUnits(1_234_500_000_000_000_000n)).toBe("1.2345");
  });

  it("passes raw values through when the token has no decimals", () => {
    expect(formatMandateUnits(42n, 0)).toBe("42");
  });

  /**
   * A malformed MANDATE_DECIMALS used to reach `10n ** BigInt(NaN)`, which
   * throws. Rendering a raw number is a cosmetic loss; throwing inside a
   * server component is a 500.
   */
  it("never throws on a malformed decimals value", () => {
    for (const bad of [NaN, Infinity, -1, 1.5, 999]) {
      expect(() => formatMandateUnits(42n, bad)).not.toThrow();
      expect(formatMandateUnits(42n, bad)).toBe("42");
    }
  });
});

describe("mandateRefusal", () => {
  it("permits a live mandate with budget left", () => {
    expect(mandateRefusal(STATE)).toBeNull();
  });

  it("refuses a revoked mandate even with budget left", () => {
    expect(mandateRefusal({ ...STATE, revoked: true })).toBe("revoked");
  });

  it("refuses once the daily budget is gone", () => {
    expect(
      mandateRefusal({ ...STATE, spentToday: STATE.dailyCap, remaining: 0n }),
    ).toBe("daily_cap_exhausted");
  });

  it("revocation outranks an unspent budget", () => {
    expect(mandateRefusal({ ...STATE, revoked: true, remaining: 0n })).toBe("revoked");
  });

  /**
   * Null means "no mandate to ask", which is not the same as "no". The agent's
   * own per-call cap still applies; this function must not invent a refusal.
   */
  it("does not refuse when there is no mandate at all", () => {
    expect(mandateRefusal(null)).toBeNull();
  });
});

describe("describeRefusal", () => {
  it("names the chain and the mandate for a revocation", () => {
    const text = describeRefusal("revoked", { ...STATE, revoked: true });
    expect(text).toContain("#7");
    expect(text).toContain("base");
  });

  it("reports the budget in readable units, not wei", () => {
    const text = describeRefusal("daily_cap_exhausted", {
      ...STATE,
      spentToday: STATE.dailyCap,
      remaining: 0n,
    });
    expect(text).toContain("25 of 25");
    expect(text).not.toContain("25000000000000000000");
  });
});

describe("readMandate", () => {
  /**
   * With no router configured there is nothing to read. The caller treats null
   * as "no on-chain authority", never as permission.
   */
  it("returns null when unconfigured, without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(isMandateConfigured(UNCONFIGURED)).toBe(false);
    expect(await readMandate(UNCONFIGURED)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the RPC is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(readMandate(CONFIGURED)).resolves.toBeNull();
  });

  it("treats a JSON-RPC error as unreadable rather than permitted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "reverted" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));
    await expect(readMandate(CONFIGURED)).resolves.toBeNull();
  });

  it("reads a live mandate and computes what is left", async () => {
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      // First call is mandateRevoked, second is mandateSpentToday.
      const result = call++ === 0 ? word(0n) : word(10_000_000_000_000_000_000n);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const state = await readMandate(CONFIGURED);
    expect(state).not.toBeNull();
    expect(state!.revoked).toBe(false);
    expect(formatMandateUnits(state!.spentToday)).toBe("10");
    expect(formatMandateUnits(state!.remaining)).toBe("15");
  });
});
