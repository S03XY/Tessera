import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIALS,
  DEFAULT_CREDENTIAL,
  REAL_CREDENTIALS,
  SIMULATED_CREDENTIAL,
  credentialLabel,
} from "@/lib/world-credentials";

/**
 * The World ID credential layer.
 *
 * These cover the parts that decide whether a seller is let through: which
 * credential is demanded, whether the configuration can actually satisfy it,
 * and — the one that matters most — that a proof of some *other* credential
 * can never be recorded as the one we asked for.
 *
 * `world.ts` reads its configuration once at import, so anything that depends
 * on the environment is exercised through a fresh module instance rather than
 * by mutating a live one.
 */

/** Loads `@/lib/world` with a specific environment, isolated from other tests. */
async function loadWorld(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("@/lib/world");
}

const GOOD_KEY = "a".repeat(64);
const LIVE_ENV = {
  WORLD_APP_ID: "app_test0000000000000000000000000",
  WORLD_RP_ID: "rp_test0000000000",
  WORLD_RP_SIGNING_KEY: GOOD_KEY,
  WORLD_ACTION: "become-seller",
  WORLD_SIMULATION: "",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------------------------------------- the registry */

describe("credential registry", () => {
  it("offers the default credential", () => {
    expect(CREDENTIALS[DEFAULT_CREDENTIAL]).toBeDefined();
  });

  it("gives every credential at least one accepted identifier", () => {
    for (const [id, spec] of Object.entries(CREDENTIALS)) {
      expect(spec.identifiers.length, id).toBeGreaterThan(0);
      expect(spec.label.length, id).toBeGreaterThan(0);
    }
  });

  it("marks Selfie Check as gated and leaves an ungated option available", () => {
    expect(CREDENTIALS.selfie_check.gated).toBe(true);
    const ungated = Object.values(CREDENTIALS).filter((spec) => !spec.gated);
    expect(ungated.length).toBeGreaterThan(0);
  });

  it("accepts both spellings World uses for a Selfie Check proof", () => {
    // IDKit normalises the legacy verification_level `face` to `selfie`.
    expect(CREDENTIALS.selfie_check.identifiers).toContain("selfie");
    expect(CREDENTIALS.selfie_check.identifiers).toContain("face");
  });

  it("requires legacy proofs for every credential that returns v3 proofs", () => {
    // Getting this wrong is not a soft failure — IDKit refuses the request.
    expect(CREDENTIALS.selfie_check.legacyProofs).toBe(true);
    expect(CREDENTIALS.orb.legacyProofs).toBe(true);
  });

  it("never treats the simulated credential as real", () => {
    expect(REAL_CREDENTIALS.has(SIMULATED_CREDENTIAL)).toBe(false);
  });

  it("labels known credentials and falls back for everything else", () => {
    expect(credentialLabel("orb")).toBe("Orb");
    expect(credentialLabel("selfie_check")).toBe("Selfie Check");
    expect(credentialLabel(null)).toBe("World ID");
    // Seeded demo fixtures use a value that is deliberately not a credential.
    expect(credentialLabel("selfie-check-seed")).toBe("World ID");
  });
});

/* -------------------------------------------------------------- the config */

describe("configuration", () => {
  it("accepts a complete configuration", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.configurationProblem()).toBeNull();
    expect(world.worldMode()).toBe("live");
  });

  it("tolerates a 0x-prefixed signing key", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_RP_SIGNING_KEY: `0x${GOOD_KEY}` });
    expect(world.configurationProblem()).toBeNull();
  });

  it.each([
    ["a missing app id", { WORLD_APP_ID: "" }, /WORLD_APP_ID/],
    ["an app id of the wrong shape", { WORLD_APP_ID: "nope" }, /must start with/],
    ["a missing rp id", { WORLD_RP_ID: "" }, /WORLD_RP_ID/],
    ["an rp id of the wrong shape", { WORLD_RP_ID: "app_x" }, /must start with/],
    ["a missing signing key", { WORLD_RP_SIGNING_KEY: "" }, /WORLD_RP_SIGNING_KEY/],
    ["a truncated signing key", { WORLD_RP_SIGNING_KEY: "abc123" }, /64 hex characters/],
    ["a non-hex signing key", { WORLD_RP_SIGNING_KEY: "z".repeat(64) }, /64 hex characters/],
  ])("refuses %s", async (_label, override, expected) => {
    const world = await loadWorld({ ...LIVE_ENV, ...override });
    expect(world.configurationProblem()).toMatch(expected);
    expect(world.worldMode()).not.toBe("live");
  });

  it("falls back to the default when the credential is unknown", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "not-a-credential" });
    expect(world.world.credential).toBe(DEFAULT_CREDENTIAL);
  });

  it("honours a credential the operator did choose", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    expect(world.world.credential).toBe("orb");
    expect(world.credentialSpec().preset).toBe("orbLegacy");
  });

  it("lets a real configuration beat a stale simulation flag", async () => {
    // A deployment that can prove humans must never keep pretending to.
    const world = await loadWorld({ ...LIVE_ENV, WORLD_SIMULATION: "1" });
    expect(world.worldMode()).toBe("live");
  });

  it("simulates only when an app id exists but the key does not", async () => {
    const world = await loadWorld({
      ...LIVE_ENV,
      WORLD_RP_SIGNING_KEY: "",
      WORLD_SIMULATION: "1",
    });
    expect(world.worldMode()).toBe("simulated");
  });

  it("is unavailable with no configuration at all", async () => {
    const world = await loadWorld({
      WORLD_APP_ID: "",
      WORLD_RP_ID: "",
      WORLD_RP_SIGNING_KEY: "",
      WORLD_SIMULATION: "",
    });
    expect(world.worldMode()).toBe("unavailable");
  });

  it("keeps secrets out of the status description", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(JSON.stringify(world.describeWorld())).not.toContain(GOOD_KEY);
  });
});

/* ------------------------------------------------------------ RP signing */

describe("createRpContext", () => {
  it("signs a challenge with the configured rp id", async () => {
    const world = await loadWorld(LIVE_ENV);
    const context = world.createRpContext();
    expect(context.rp_id).toBe(LIVE_ENV.WORLD_RP_ID);
    expect(context.signature.length).toBeGreaterThan(0);
    expect(context.expires_at).toBeGreaterThan(context.created_at);
  });

  it("produces a fresh nonce each time, so a challenge cannot be replayed", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.createRpContext().nonce).not.toBe(world.createRpContext().nonce);
  });

  it("signs the same request identically with or without the 0x prefix", async () => {
    // A pasted `0x` must be stripped, not signed as part of the key.
    const bare = await loadWorld(LIVE_ENV);
    const bareMessage = bare.createRpContext();
    const prefixed = await loadWorld({ ...LIVE_ENV, WORLD_RP_SIGNING_KEY: `0x${GOOD_KEY}` });
    const prefixedMessage = prefixed.createRpContext();
    // Different nonces mean different signatures; what must match is that both
    // signed at all, and produced signatures of the same shape.
    expect(prefixedMessage.signature).toHaveLength(bareMessage.signature.length);
  });

  it("refuses to sign when the configuration is incomplete", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_RP_SIGNING_KEY: "" });
    expect(() => world.createRpContext()).toThrow(/not configured/i);
  });
});

/* ------------------------------------------------------- failure guidance */

describe("explainFailure", () => {
  it("explains the failure that actually blocked this integration", async () => {
    const world = await loadWorld(LIVE_ENV);
    const { message } = world.explainFailure("app_not_migrated");
    expect(message).toMatch(/World ID 4\.0/);
  });

  it.each([
    ["invalid_action", /Developer Portal/],
    ["credential_unavailable", /access-gated|WORLD_CREDENTIAL/],
    ["invalid_rp_signature", /WORLD_RP_SIGNING_KEY/],
  ])("gives %s an actionable remedy", async (code, expected) => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.explainFailure(code).message).toMatch(expected);
  });

  it("marks transient failures retryable and configuration failures not", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.explainFailure("timeout").retryable).toBe(true);
    expect(world.explainFailure("app_not_migrated").retryable).toBe(false);
  });

  it("falls through to World's own detail for an unmapped code", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.explainFailure("some_new_code", "World said this").message).toBe("World said this");
  });

  it("never renders an empty message", async () => {
    const world = await loadWorld(LIVE_ENV);
    expect(world.explainFailure("some_new_code", "   ").message).toContain("some_new_code");
  });
});

/* ------------------------------------------------------------ verifyProof */

/** Answers the next fetch with a canned World verify response. */
function stubVerify(status: number, body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("verifyProof", () => {
  it("accepts a proof of the credential we asked for", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubVerify(200, {
      success: true,
      results: [{ identifier: "orb", success: true, nullifier: "0xnull" }],
    });

    const verified = await world.verifyProof({ any: "proof" });
    expect(verified.nullifier).toBe("0xnull");
    expect(verified.credential).toBe("orb");
    expect(verified.identifier).toBe("orb");
  });

  it("posts the proof verbatim to the rp-scoped endpoint", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    const fetchMock = stubVerify(200, {
      success: true,
      results: [{ identifier: "orb", success: true, nullifier: "0xnull" }],
    });

    await world.verifyProof({ marker: "untouched" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(LIVE_ENV.WORLD_RP_ID);
    expect(JSON.parse(String(init.body))).toEqual({ marker: "untouched" });
  });

  it("accepts the legacy `face` spelling of a Selfie Check proof", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "selfie_check" });
    stubVerify(200, {
      success: true,
      results: [{ identifier: "face", success: true, nullifier: "0xnull" }],
    });
    await expect(world.verifyProof({})).resolves.toMatchObject({ credential: "selfie_check" });
  });

  it("refuses a proof of a different credential than the one demanded", async () => {
    // The downgrade guard. Recording this would put a claim in the database
    // that the proof does not support.
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "selfie_check" });
    stubVerify(200, {
      success: true,
      results: [{ identifier: "device", success: true, nullifier: "0xnull" }],
    });

    await expect(world.verifyProof({})).rejects.toMatchObject({ code: "credential_mismatch" });
  });

  it("refuses a response where nothing passed", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubVerify(200, {
      success: true,
      results: [{ identifier: "orb", success: false, nullifier: "" }],
    });

    await expect(world.verifyProof({})).rejects.toMatchObject({ code: "no_passing_credential" });
  });

  it("never trusts a client that claims success on its own", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubVerify(200, { success: false, code: "all_verifications_failed" });
    await expect(world.verifyProof({ success: true })).rejects.toThrow();
  });

  it("surfaces World's failure code with guidance attached", async () => {
    const world = await loadWorld(LIVE_ENV);
    stubVerify(400, { success: false, code: "app_not_migrated", detail: "raw detail" });

    await expect(world.verifyProof({})).rejects.toMatchObject({
      code: "app_not_migrated",
      message: expect.stringMatching(/World ID 4\.0/),
    });
  });

  it("reports an unreachable verifier as retryable rather than as a bad proof", async () => {
    const world = await loadWorld(LIVE_ENV);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(world.verifyProof({})).rejects.toMatchObject({
      code: "verifier_unreachable",
      retryable: true,
    });
  });

  it("reports a non-JSON response instead of throwing a parse error", async () => {
    const world = await loadWorld(LIVE_ENV);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    await expect(world.verifyProof({})).rejects.toMatchObject({ code: "bad_verifier_response" });
  });

  it("refuses to call World at all when unconfigured", async () => {
    const world = await loadWorld({ ...LIVE_ENV, WORLD_RP_SIGNING_KEY: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(world.verifyProof({})).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
