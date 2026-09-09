import { describe, it, expect } from "vitest";
import {
  base58Encode,
  canonicalAgentJson,
  deriveAid,
  uaid,
  buyerAgentIdentity,
  sellerIdentity,
  hederaNativeId,
  type CanonicalAgent,
} from "@/lib/agent-identity";

const AGENT: CanonicalAgent = {
  registry: "HOL",
  name: "  Support Agent  ",
  version: "1.0.0",
  protocol: "HCS-10",
  nativeId: "hedera:testnet:0.0.123456",
  skills: [17, 0],
};

describe("base58", () => {
  it("matches the reference vectors", () => {
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(base58Encode(new Uint8Array([0, 0, 40, 127, 180, 205]))).toBe("11233QC4");
  });

  it("encodes zero bytes as exactly one '1' each", () => {
    expect(base58Encode(new Uint8Array([]))).toBe("");
    expect(base58Encode(new Uint8Array([0]))).toBe("1");
    expect(base58Encode(new Uint8Array([0, 0]))).toBe("11");
  });

  it("never emits a character outside the alphabet", () => {
    const bytes = new Uint8Array(64).map((_, i) => (i * 37) % 256);
    expect(base58Encode(bytes)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});

describe("canonical JSON", () => {
  it("lowercases registry and protocol, trims, sorts skills, orders keys", () => {
    expect(canonicalAgentJson(AGENT)).toBe(
      '{"name":"Support Agent","nativeId":"hedera:testnet:0.0.123456",' +
        '"protocol":"hcs-10","registry":"hol","skills":[0,17],"version":"1.0.0"}',
    );
  });

  /** The whole point of deriving rather than assigning. */
  it("is insensitive to input field order and casing", () => {
    const shuffled: CanonicalAgent = {
      skills: [0, 17],
      nativeId: "hedera:testnet:0.0.123456",
      version: "1.0.0",
      protocol: "hcs-10",
      name: "Support Agent",
      registry: "hol",
    };
    expect(deriveAid(shuffled)).toBe(deriveAid(AGENT));
  });

  it("changes the identifier when any canonical field changes", () => {
    const base = deriveAid(AGENT);
    expect(deriveAid({ ...AGENT, version: "1.0.1" })).not.toBe(base);
    expect(deriveAid({ ...AGENT, skills: [0] })).not.toBe(base);
    expect(deriveAid({ ...AGENT, nativeId: "hedera:mainnet:0.0.123456" })).not.toBe(base);
  });
});

describe("uaid", () => {
  it("has the shape the standard specifies", () => {
    const id = uaid(AGENT);
    expect(id).toMatch(
      /^uaid:aid:[1-9A-HJ-NP-Za-km-z]+;uid=0;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0\.0\.123456$/,
    );
  });

  it("omits parameters that have no value rather than emitting them empty", () => {
    expect(uaid(AGENT)).not.toContain("domain=");
    expect(uaid(AGENT, { domain: "tessera.example" })).toContain(";domain=tessera.example");
  });

  it("is stable across calls", () => {
    expect(uaid(AGENT)).toBe(uaid(AGENT));
  });
});

describe("this marketplace", () => {
  it("derives a buyer identity from the agent's own account", () => {
    const identity = buyerAgentIdentity("0.0.4759408");
    expect(identity.uaid).toContain("registry=tessera");
    expect(identity.uaid).toContain("proto=x402");
    expect(identity.canonical.nativeId).toBe(hederaNativeId("0.0.4759408"));
  });

  it("gives two different sellers two different identities", () => {
    const a = sellerIdentity("0.0.7399100", "Indexwell Research");
    const b = sellerIdentity("0.0.7326077", "Cobalt Feeds");
    expect(a.aid).not.toBe(b.aid);
  });

  it("gives the same seller the same identity every time", () => {
    expect(sellerIdentity("0.0.7399100", "Indexwell Research").aid).toBe(
      sellerIdentity("0.0.7399100", "Indexwell Research").aid,
    );
  });
});
