import { afterEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import {
  anonymousKey,
  bucketFor,
  consumeFreeCall,
  exhaustedMessage,
  quotaStatus,
  releaseFreeCall,
  type Bucket,
} from "@/lib/quota";

/**
 * The free-tool allowance.
 *
 * Two things matter here and both are security properties rather than
 * conveniences. The first is that the tier a caller lands in reflects what
 * they actually presented, so an authenticated agent never silently shares
 * the anonymous bucket. The second is that the counter holds under
 * concurrency, because a limit enforced by read-then-write is not a limit.
 */

const KEYS = ["test-bucket-a", "test-bucket-b", "test-bucket-c", "test-bucket-d"];

function bucket(key: string, limit: number, kind: Bucket["kind"] = "agent"): Bucket {
  return { kind, key, limit, label: "test" };
}

afterEach(async () => {
  await query(`DELETE FROM free_call_quota WHERE bucket_key = ANY($1::text[])`, [KEYS]);
});

/* ------------------------------------------------------------- tier choice */

describe("bucketFor", () => {
  it("keys a registered agent to its own id", () => {
    const result = bucketFor({ id: "agent-1" }, "anon");
    expect(result.kind).toBe("agent");
    expect(result.key).toBe("agent-1");
  });

  it("gives each agent its own allowance", () => {
    expect(bucketFor({ id: "agent-1" }, "anon").key).not.toBe(
      bucketFor({ id: "agent-2" }, "anon").key,
    );
  });

  it("prefers the token over the address when both are available", () => {
    // Otherwise every agent behind one NAT would share a bucket.
    const result = bucketFor({ id: "agent-1" }, "shared-anon-key");
    expect(result.key).toBe("agent-1");
  });

  it("falls to the anonymous tier with no agent at all", () => {
    const result = bucketFor(null, "anon-key");
    expect(result.kind).toBe("anonymous");
    expect(result.key).toBe("anon-key");
  });

  it("gives a registered agent a larger allowance than an anonymous caller", () => {
    expect(bucketFor({ id: "a" }, "anon").limit).toBeGreaterThan(
      bucketFor(null, "anon").limit,
    );
  });
});

/* ------------------------------------------------------------ anonymousKey */

describe("anonymousKey", () => {
  it("is stable for the same caller and different for another", () => {
    expect(anonymousKey("1.2.3.4", null)).toBe(anonymousKey("1.2.3.4", null));
    expect(anonymousKey("1.2.3.4", null)).not.toBe(anonymousKey("5.6.7.8", null));
  });

  it("uses the first hop of a forwarded chain", () => {
    expect(anonymousKey("1.2.3.4, 9.9.9.9", null)).toBe(anonymousKey("1.2.3.4", null));
  });

  it("never contains the address it was derived from", () => {
    expect(anonymousKey("203.0.113.7", null)).not.toContain("203.0.113");
  });

  it("still yields a key when nothing identifies the caller", () => {
    expect(anonymousKey(null, null).length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- counting */

describe("consumeFreeCall", () => {
  it("counts up from nothing", async () => {
    const b = bucket(KEYS[0], 3);
    expect(await consumeFreeCall(b)).toMatchObject({ allowed: true, used: 1 });
    expect(await consumeFreeCall(b)).toMatchObject({ allowed: true, used: 2 });
  });

  it("allows exactly the limit and then refuses", async () => {
    const b = bucket(KEYS[0], 2);
    expect((await consumeFreeCall(b)).allowed).toBe(true);
    expect((await consumeFreeCall(b)).allowed).toBe(true);
    const third = await consumeFreeCall(b);
    expect(third.allowed).toBe(false);
    expect(third.used).toBe(2);
  });

  it("refuses everything when the allowance is zero", async () => {
    expect((await consumeFreeCall(bucket(KEYS[0], 0))).allowed).toBe(false);
  });

  it("keeps separate buckets separate", async () => {
    await consumeFreeCall(bucket(KEYS[0], 5));
    expect(await quotaStatus(bucket(KEYS[1], 5))).toMatchObject({ used: 0 });
  });

  it("keeps the same key in different tiers separate", async () => {
    await consumeFreeCall(bucket(KEYS[0], 5, "agent"));
    expect(await quotaStatus(bucket(KEYS[0], 5, "anonymous"))).toMatchObject({ used: 0 });
  });

  it("does not overshoot under concurrency", async () => {
    // A limit enforced by read-then-write is not a limit: both callers would
    // see one remaining and both proceed.
    const b = bucket(KEYS[0], 5);
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeFreeCall(b)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await quotaStatus(b)).toMatchObject({ used: 5 });
  });
});

describe("releaseFreeCall", () => {
  it("hands back a call the caller never received", async () => {
    const b = bucket(KEYS[0], 3);
    await consumeFreeCall(b);
    await consumeFreeCall(b);
    await releaseFreeCall(b);
    expect(await quotaStatus(b)).toMatchObject({ used: 1 });
  });

  it("reopens a bucket that had hit its limit", async () => {
    const b = bucket(KEYS[0], 1);
    await consumeFreeCall(b);
    expect((await consumeFreeCall(b)).allowed).toBe(false);
    await releaseFreeCall(b);
    expect((await consumeFreeCall(b)).allowed).toBe(true);
  });

  it("never drives a bucket below zero", async () => {
    const b = bucket(KEYS[0], 3);
    await consumeFreeCall(b);
    await releaseFreeCall(b);
    await releaseFreeCall(b);
    await releaseFreeCall(b);
    expect(await quotaStatus(b)).toMatchObject({ used: 0 });
  });

  it("is silent about a bucket that was never used", async () => {
    await expect(releaseFreeCall(bucket(KEYS[2], 3))).resolves.toBeUndefined();
  });
});

/* --------------------------------------------------------------- messaging */

describe("exhaustedMessage", () => {
  it("tells an anonymous caller both ways up", () => {
    const message = exhaustedMessage({
      allowed: false,
      used: 25,
      limit: 25,
      kind: "anonymous",
      label: "anonymous",
    });
    expect(message).toMatch(/Register an agent/);
  });

  it("tells a registered agent when it resets, and not to expect a way up", () => {
    const message = exhaustedMessage({
      allowed: false,
      used: 100,
      limit: 100,
      kind: "agent",
      label: "registered agent",
    });
    expect(message).toMatch(/resets/);
    expect(message).not.toMatch(/Register an agent/);
  });

  it("always states the numbers", () => {
    const message = exhaustedMessage({
      allowed: false,
      used: 7,
      limit: 7,
      kind: "agent",
      label: "registered agent",
    });
    expect(message).toContain("7/7");
  });
});
