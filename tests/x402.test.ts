import { describe, expect, it } from "vitest";
import {
  buildRequirements,
  decodePaymentHeader,
  encodeSettlementHeader,
  facilitatorSupportsNetwork,
  getSupported,
  PaymentHeaderError,
  SCHEME,
  X402_VERSION,
} from "@/lib/x402";
import { X402_NETWORK } from "@/lib/config";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const validPayload = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: "90000",
    payTo: "0.0.7326076",
    maxTimeoutSeconds: 300,
    extra: {},
  },
  payload: { transaction: "CgYKBBCA" },
};

describe("decodePaymentHeader — accepts", () => {
  it("decodes a well-formed v2 payload", () => {
    const payload = decodePaymentHeader(encode(validPayload));
    expect(payload.x402Version).toBe(X402_VERSION);
    expect(payload.accepted.amount).toBe("90000");
  });
});

describe("decodePaymentHeader — rejects", () => {
  it("rejects non-JSON base64", () => {
    const header = Buffer.from("this is not json", "utf8").toString("base64");
    expect(() => decodePaymentHeader(header)).toThrow(PaymentHeaderError);
    expect(() => decodePaymentHeader(header)).toThrow(/does not decode to JSON/);
  });

  it("rejects a non-object payload", () => {
    expect(() => decodePaymentHeader(encode("a string"))).toThrow(/not an object/);
    expect(() => decodePaymentHeader(encode(42))).toThrow(/not an object/);
  });

  it("rejects a v1 payload against a v2 gateway", () => {
    expect(() => decodePaymentHeader(encode({ ...validPayload, x402Version: 1 }))).toThrow(
      /unsupported x402Version 1/,
    );
  });

  it("rejects a payload with no accepted requirements", () => {
    const { accepted: _accepted, ...rest } = validPayload;
    expect(() => decodePaymentHeader(encode(rest))).toThrow(/missing the accepted/);
  });

  it("rejects a payload with no scheme payload", () => {
    const { payload: _payload, ...rest } = validPayload;
    expect(() => decodePaymentHeader(encode(rest))).toThrow(/missing the scheme payload/);
  });
});

describe("encodeSettlementHeader", () => {
  it("round-trips through base64", () => {
    const settlement = {
      success: true,
      transaction: "0.0.7326075@1756290000.000000000",
      network: "hedera:testnet" as const,
      payer: "0.0.7326078",
    };
    const decoded = JSON.parse(
      Buffer.from(encodeSettlementHeader(settlement), "base64").toString("utf8"),
    );
    expect(decoded).toEqual(settlement);
  });
});

/**
 * These hit the real Blocky402 testnet facilitator. If they fail, settlement
 * is genuinely unavailable and the Hedera track requirement is not being met —
 * which is exactly what a test should tell us.
 */
describe("Blocky402 facilitator (live)", () => {
  it("advertises the exact scheme on our configured network", async () => {
    const supported = await getSupported(true);
    const kind = supported.kinds.find(
      (entry) => entry.network === X402_NETWORK && entry.scheme === SCHEME,
    );
    expect(kind, `facilitator does not support ${SCHEME} on ${X402_NETWORK}`).toBeDefined();
    expect(kind?.x402Version).toBe(X402_VERSION);
  });

  it("publishes a Hedera fee payer account", async () => {
    const supported = await getSupported();
    const kind = supported.kinds.find((entry) => entry.network === X402_NETWORK);
    expect(kind?.extra?.feePayer).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("confirms network support through the helper", async () => {
    await expect(facilitatorSupportsNetwork()).resolves.toBe(true);
  });
});

describe("buildRequirements", () => {
  it("produces a spec-shaped requirements object with the live fee payer", async () => {
    const requirements = await buildRequirements({
      amount: 90000n,
      payTo: "0.0.7326076",
      asset: "0.0.0",
    });

    expect(requirements.scheme).toBe("exact");
    expect(requirements.network).toBe(X402_NETWORK);
    expect(requirements.amount).toBe("90000");
    expect(requirements.payTo).toBe("0.0.7326076");
    expect(requirements.asset).toBe("0.0.0");
    expect(requirements.maxTimeoutSeconds).toBe(300);
    expect(requirements.extra).toHaveProperty("feePayer");
  });

  it("serialises a bigint amount without precision loss", async () => {
    const requirements = await buildRequirements({
      amount: 9_007_199_254_740_993n, // Number.MAX_SAFE_INTEGER + 2
      payTo: "0.0.1",
      asset: "0.0.0",
    });
    expect(requirements.amount).toBe("9007199254740993");
  });
});
