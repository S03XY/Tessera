import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatPrice,
  isPriceUnit,
  MAX_UNITS,
  normalizeUnits,
  quoteFor,
  toAtomic,
} from "@/lib/money";

describe("toAtomic", () => {
  it("accepts integer strings, numbers and bigints", () => {
    expect(toAtomic("100000")).toBe(100000n);
    expect(toAtomic(42)).toBe(42n);
    expect(toAtomic(7n)).toBe(7n);
  });

  it("accepts values beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    const huge = "123456789012345678901234567890";
    expect(toAtomic(huge).toString()).toBe(huge);
  });

  it.each(["", " ", "1.5", "-1", "1e5", "abc", "0x10", "1,000"])(
    "rejects %o",
    (input) => {
      expect(() => toAtomic(input)).toThrow(/not an atomic amount/);
    },
  );
});

describe("formatAmount", () => {
  it("renders whole units with no trailing separator", () => {
    expect(formatAmount("100000000")).toBe("1");
    expect(formatAmount("0")).toBe("0");
  });

  it("trims trailing zeros in the fraction", () => {
    expect(formatAmount("90000")).toBe("0.0009");
    expect(formatAmount("150000")).toBe("0.0015");
    expect(formatAmount("120000000")).toBe("1.2");
  });

  it("never rounds a paid amount upward", () => {
    // 0.000000019 ℏ truncated to 6 dp must not become 0.00000002.
    expect(formatAmount("19", 8, 6)).toBe("0");
  });

  it("honours a non-default decimal scale", () => {
    expect(formatAmount("1500000", 6)).toBe("1.5");
  });
});

describe("formatPrice", () => {
  it("labels the metering unit", () => {
    expect(formatPrice("90000", "per_call")).toBe("0.0009 ℏ / call");
    expect(formatPrice("400", "per_token")).toBe("0.000004 ℏ / token");
    expect(formatPrice("60", "per_row")).toBe("0.0000006 ℏ / row");
  });
});

describe("quoteFor", () => {
  it("multiplies price by declared units", () => {
    expect(quoteFor("400", 50)).toBe(20000n);
    expect(quoteFor("400", 5000)).toBe(2000000n);
  });

  it("scales linearly — 100x the budget is 100x the quote", () => {
    expect(quoteFor("400", 5000)).toBe(quoteFor("400", 50) * 100n);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects unit count %o", (units) => {
    expect(() => quoteFor("400", units)).toThrow(/positive integer/);
  });
});

describe("normalizeUnits", () => {
  it("defaults to one unit when absent", () => {
    expect(normalizeUnits(undefined, "per_token")).toBe(1);
    expect(normalizeUnits(null, "per_row")).toBe(1);
    expect(normalizeUnits("", "per_token")).toBe(1);
  });

  it("passes a declared budget through for metered services", () => {
    expect(normalizeUnits("50", "per_token")).toBe(50);
    expect(normalizeUnits("500", "per_row")).toBe(500);
  });

  it("collapses to one unit for per_call regardless of the budget", () => {
    expect(normalizeUnits("500", "per_call")).toBe(1);
  });

  it.each(["abc", "0", "-5", "1.5", "1e3"])("rejects %o even for per_call", (raw) => {
    expect(() => normalizeUnits(raw, "per_call")).toThrow();
    expect(() => normalizeUnits(raw, "per_token")).toThrow();
  });

  it("rejects a budget above the cap", () => {
    expect(() => normalizeUnits(String(MAX_UNITS + 1), "per_token")).toThrow(/maximum/);
    expect(normalizeUnits(String(MAX_UNITS), "per_token")).toBe(MAX_UNITS);
  });
});

describe("isPriceUnit", () => {
  it("accepts the three supported units and nothing else", () => {
    expect(isPriceUnit("per_call")).toBe(true);
    expect(isPriceUnit("per_token")).toBe(true);
    expect(isPriceUnit("per_row")).toBe(true);
    expect(isPriceUnit("per_gigabyte")).toBe(false);
    expect(isPriceUnit(undefined)).toBe(false);
  });
});
