import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The World ID readiness checks.
 *
 * These probe World by sending deliberately invalid proofs and reading which
 * error comes back, so what is under test is the *interpretation*: does
 * `app_not_migrated` become "migrate the app" rather than "verification
 * failed", and does an unreachable World read as unknown rather than as a
 * configuration error the operator would waste time chasing.
 */

const GOOD_KEY = "a".repeat(64);
const LIVE_ENV = {
  WORLD_APP_ID: "app_test0000000000000000000000000",
  WORLD_RP_ID: "rp_test0000000000",
  WORLD_RP_SIGNING_KEY: GOOD_KEY,
  WORLD_ACTION: "become-seller",
  WORLD_ENVIRONMENT: "production",
  WORLD_SIMULATION: "",
};

/**
 * Answers the two probes in the order `runWorldChecks` makes them: the v2
 * app/action probe first, then the v4 migration probe.
 */
function stubProbes(v2: unknown, v4: unknown, status = 400) {
  const fetchMock = vi.fn(async (url: string | URL) =>
    new Response(JSON.stringify(String(url).includes("/v2/") ? v2 : v4), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function load(env: Record<string, string> = LIVE_ENV) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("@/lib/world-check");
}

function find(report: { checks: Array<{ id: string; state: string; detail: string }> }, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`no check with id ${id}`);
  return check;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runWorldChecks", () => {
  it("reports ready when every precondition holds and the credential is ungated", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(report.ready).toBe(true);
    expect(report.todo).toHaveLength(0);
    expect(report.mode).toBe("live");
  });

  it("catches the failure that actually blocked this integration", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_proof" }, { code: "app_not_migrated" });

    const report = await runWorldChecks();
    expect(report.ready).toBe(false);
    expect(find(report, "migration").state).toBe("fail");
    expect(report.todo.join(" ")).toMatch(/Enable World ID 4\.0/);
  });

  it("distinguishes a missing action from a missing app", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_action" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(find(report, "action").state).toBe("fail");
    expect(report.todo.join(" ")).toMatch(/Incognito Action/);
    // The migration is fine; only the action is wrong.
    expect(find(report, "migration").state).toBe("pass");
  });

  it("treats a rejected dummy proof as proof the app and action resolve", async () => {
    // World getting as far as rejecting our rubbish proof is the pass signal.
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(find(report, "action").state).toBe("pass");
    expect(find(report, "migration").state).toBe("pass");
  });

  it("flags a gated credential as a warning the operator cannot resolve alone", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "selfie_check" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(find(report, "credential").state).toBe("warn");
    expect(report.ready).toBe(false);
    expect(report.todo.join(" ")).toMatch(/toolsforhumanity\.com/);
    // It must still offer the way to go live today.
    expect(report.todo.join(" ")).toMatch(/orb/);
  });

  it("reports an unreachable World as unknown, not as a bad configuration", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));

    const report = await runWorldChecks();
    expect(find(report, "action").state).toBe("warn");
    expect(find(report, "migration").state).toBe("warn");
    // Nothing to "fix" — we simply could not ask.
    expect(report.todo).toHaveLength(0);
  });

  it("names the missing variable and skips the probes that depend on it", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_RP_SIGNING_KEY: "" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(find(report, "variables").state).toBe("fail");
    expect(find(report, "variables").detail).toMatch(/WORLD_RP_SIGNING_KEY/);
    expect(find(report, "signing").state).toBe("skip");
  });

  it("confirms the signing key can actually sign", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(find(report, "signing").state).toBe("pass");
  });

  it("never returns the signing key", async () => {
    const { runWorldChecks } = await load({ ...LIVE_ENV, WORLD_CREDENTIAL: "orb" });
    stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    const report = await runWorldChecks();
    expect(JSON.stringify(report)).not.toContain(GOOD_KEY);
  });

  it("sends the configured environment to World rather than a rewritten one", async () => {
    // `sandbox` is valid — the verify endpoint's own validation lists it.
    const { runWorldChecks } = await load({
      ...LIVE_ENV,
      WORLD_ENVIRONMENT: "sandbox",
      WORLD_CREDENTIAL: "orb",
    });
    const fetchMock = stubProbes({ code: "invalid_proof" }, { code: "all_verifications_failed" });

    await runWorldChecks();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const v4Call = calls.find(([url]) => String(url).includes("/v4/"));
    expect(JSON.parse(String(v4Call?.[1]?.body)).environment).toBe("sandbox");
  });
});
