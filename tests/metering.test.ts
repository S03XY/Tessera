import { describe, expect, it } from "vitest";
import { estimateTokens, meterResponse } from "@/lib/metering";

const JSON_CT = "application/json";
const TEXT_CT = "text/plain";

describe("estimateTokens", () => {
  it("is zero only for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });

  it("uses the documented four-characters-per-token ratio", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("meterResponse — per_call", () => {
  it("returns the body untouched and bills one unit", () => {
    const body = JSON.stringify({ rate: 1.09 });
    const result = meterResponse("per_call", 1, body, JSON_CT);
    expect(result).toEqual({ body, units: 1, truncated: false });
  });

  it("ignores the budget entirely", () => {
    const body = "x".repeat(10_000);
    expect(meterResponse("per_call", 1, body, TEXT_CT).body).toBe(body);
  });
});

describe("meterResponse — per_row", () => {
  it("bills the row count of a JSON array", () => {
    const body = JSON.stringify([1, 2, 3]);
    const result = meterResponse("per_row", 10, body, JSON_CT);
    expect(result.units).toBe(3);
    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.body)).toEqual([1, 2, 3]);
  });

  it("trims the array to the paid budget", () => {
    const body = JSON.stringify(Array.from({ length: 500 }, (_, i) => i));
    const result = meterResponse("per_row", 10, body, JSON_CT);
    expect(JSON.parse(result.body)).toHaveLength(10);
    expect(result.units).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it("treats a JSON object as a single row", () => {
    const body = JSON.stringify({ a: 1, b: 2 });
    const result = meterResponse("per_row", 5, body, JSON_CT);
    expect(result.units).toBe(1);
    expect(result.body).toBe(body);
  });

  it("falls back to line counting for non-JSON", () => {
    const body = "alpha\nbravo\ncharlie\ndelta";
    const result = meterResponse("per_row", 2, body, TEXT_CT);
    expect(result.body).toBe("alpha\nbravo");
    expect(result.units).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("ignores blank lines when counting rows", () => {
    const result = meterResponse("per_row", 10, "a\n\n\nb\n", TEXT_CT);
    expect(result.units).toBe(2);
  });

  it("falls back to line counting when JSON is malformed", () => {
    const result = meterResponse("per_row", 5, "{not json\nsecond line", JSON_CT);
    expect(result.units).toBe(2);
  });
});

describe("meterResponse — per_token", () => {
  it("bills the estimated token count when under budget", () => {
    const body = "x".repeat(200); // 50 tokens
    const result = meterResponse("per_token", 500, body, TEXT_CT);
    expect(result.units).toBe(50);
    expect(result.truncated).toBe(false);
    expect(result.body).toBe(body);
  });

  it("truncates to the paid token budget", () => {
    const body = "x".repeat(10_000);
    const result = meterResponse("per_token", 50, body, TEXT_CT);
    expect(result.body).toHaveLength(200);
    expect(result.units).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it("never bills more units than were paid for", () => {
    for (const budget of [1, 7, 50, 1000]) {
      const result = meterResponse("per_token", budget, "y".repeat(100_000), TEXT_CT);
      expect(result.units).toBeLessThanOrEqual(budget);
    }
  });
});
