import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeAddressArg,
  hashscanToken,
  readDepositUnits,
  toEvmAddress,
  TokenizedDepositError,
} from "@/lib/tokenized-deposit";

/**
 * The deposit bond is read over the JSON-RPC relay with a hand-encoded
 * `balanceOf`, so the encoding and every failure path are worth pinning: the
 * relay reports a reverted call as a JSON-RPC error rather than an HTTP one,
 * and a seller page must degrade rather than 500 when the chain is unreachable.
 */

const TOKEN = "0.0.10367762";
const HOLDER = "0x930D0145DC771Acc82c00504260E133e6184eb84";

function rpc(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------- addresses */

describe("toEvmAddress", () => {
  it("converts a Hedera contract id to its long-zero address", () => {
    // 10367762 = 0x9E3312
    expect(toEvmAddress("0.0.10367762")).toBe(`0x${"0".repeat(34)}9e3312`);
  });

  it("converts small entity numbers correctly", () => {
    expect(toEvmAddress("0.0.1")).toBe(`0x${"0".repeat(39)}1`);
    expect(toEvmAddress("0.0.0")).toBe(`0x${"0".repeat(40)}`);
  });

  it("passes an EVM address through, lowercased", () => {
    expect(toEvmAddress(HOLDER)).toBe(HOLDER.toLowerCase());
  });

  it("tolerates surrounding whitespace", () => {
    expect(toEvmAddress("  0.0.5  ")).toBe(`0x${"0".repeat(39)}5`);
  });

  it.each([
    ["empty", ""],
    ["not an id", "hello"],
    ["too short an address", "0x1234"],
    ["non-hex address", "0xZZZZ0145DC771Acc82c00504260E133e6184eb84"],
    ["partial id", "0.0"],
    ["negative", "0.0.-5"],
  ])("rejects %s", (_label, value) => {
    expect(() => toEvmAddress(value)).toThrow(TokenizedDepositError);
  });
});

describe("encodeAddressArg", () => {
  it("right-aligns an address in 32 bytes", () => {
    const encoded = encodeAddressArg(HOLDER);
    expect(encoded).toHaveLength(64);
    expect(encoded).toBe(`${"0".repeat(24)}${HOLDER.slice(2).toLowerCase()}`);
  });

  it("encodes a contract id the same way", () => {
    expect(encodeAddressArg("0.0.10367762")).toBe(`${"0".repeat(58)}9e3312`);
  });
});

/* ------------------------------------------------------------------ reading */

describe("readDepositUnits", () => {
  it("decodes a balance and calls the token contract", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) =>
      rpc({ jsonrpc: "2.0", id: 1, result: `0x${(175n).toString(16).padStart(64, "0")}` }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const balance = await readDepositUnits(TOKEN, HOLDER);

    expect(balance?.units).toBe(175n);
    expect(balance?.tokenId).toBe(TOKEN);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(toEvmAddress(TOKEN));
    // balanceOf selector followed by the holder, right-aligned.
    expect(body.params[0].data).toBe(`0x70a08231${encodeAddressArg(HOLDER)}`);
  });

  it("reads a zero balance as zero, not as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => rpc({ result: `0x${"0".repeat(64)}` })),
    );

    const balance = await readDepositUnits(TOKEN, HOLDER);
    expect(balance?.units).toBe(0n);
  });

  it("handles a balance too large for a JS number", async () => {
    const huge = (2n ** 200n).toString(16).padStart(64, "0");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => rpc({ result: `0x${huge}` })));

    const balance = await readDepositUnits(TOKEN, HOLDER);
    expect(balance?.units).toBe(2n ** 200n);
  });

  /** Everything below must return null and let the page keep rendering. */
  it("returns null for a malformed token id without calling the chain", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    expect(await readDepositUnits("not-a-token", HOLDER)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for a malformed holder without calling the chain", async () => {
    const fetchMock = vi.fn<(u: string, i: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    expect(await readDepositUnits(TOKEN, "nope")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The relay answers a reverted call with HTTP 200 and a JSON-RPC error, so
   * a status check alone would treat a revert as a successful read.
   */
  it("returns null on a JSON-RPC error carried in a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) =>
        rpc({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } }),
      ),
    );

    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });

  it("returns null when the contract answers with no data", async () => {
    // "0x" is what a call to an address with no code returns.
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => rpc({ result: "0x" })));
    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });

  it("returns null on a non-hex result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => rpc({ result: "banana" })));
    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });

  it("returns null on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, _i: RequestInit) => rpc({}, 502)));
    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });

  it("returns null on a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => new Response("<html>gateway</html>")),
    );
    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });

  it("returns null when the relay is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i: RequestInit) => {
        throw new Error("ETIMEDOUT");
      }),
    );
    expect(await readDepositUnits(TOKEN, HOLDER)).toBeNull();
  });
});

describe("hashscanToken", () => {
  it("links to the contract on the configured network", () => {
    expect(hashscanToken(TOKEN)).toContain(`/contract/${TOKEN}`);
    expect(hashscanToken(TOKEN)).toMatch(/^https:\/\/hashscan\.io\//);
  });
});
