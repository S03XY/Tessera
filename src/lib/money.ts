/**
 * Amounts are atomic integer units end to end (tinybars for HBAR, base units
 * for HTS tokens). Nothing in this file ever converts through a float, because
 * a rounding error here is a real payment discrepancy.
 */

export const HBAR_ASSET = "0.0.0";
export const HBAR_DECIMALS = 8;
export const TINYBARS_PER_HBAR = 100_000_000n;

export type PriceUnit = "per_call" | "per_token" | "per_row";

export const PRICE_UNIT_LABEL: Record<PriceUnit, string> = {
  per_call: "call",
  per_token: "token",
  per_row: "row",
};

export const PRICE_UNITS: PriceUnit[] = ["per_call", "per_token", "per_row"];

export function isPriceUnit(value: unknown): value is PriceUnit {
  return typeof value === "string" && (PRICE_UNITS as string[]).includes(value);
}

/** Parses an atomic-unit string. Throws on anything that is not a non-negative integer. */
export function toAtomic(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`not an atomic amount: ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

/**
 * Formats atomic units as a decimal string without floating point.
 * `maxFractionDigits` trims trailing zeros but never rounds up a paid amount.
 */
export function formatAmount(
  atomic: string | number | bigint,
  decimals = HBAR_DECIMALS,
  maxFractionDigits = decimals,
): string {
  const value = toAtomic(atomic);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;

  if (fraction === 0n) return whole.toString();

  let fractionText = fraction.toString().padStart(decimals, "0");
  if (maxFractionDigits < decimals) fractionText = fractionText.slice(0, maxFractionDigits);
  fractionText = fractionText.replace(/0+$/, "");

  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

/** Human label for a price, e.g. "0.0009 ℏ / call". */
export function formatPrice(
  atomic: string | bigint,
  unit: PriceUnit,
  decimals = HBAR_DECIMALS,
): string {
  return `${formatAmount(atomic, decimals)} ℏ / ${PRICE_UNIT_LABEL[unit]}`;
}

/**
 * Zero is a real price: the seller published that tool free.
 *
 * Kept here rather than at each call site because "free" has to render
 * identically everywhere — a tool shown as `0.0000 ℏ / row` on one screen and
 * `free` on another reads as a bug in the pricing, which is the one thing a
 * marketplace cannot afford to look like.
 */
export function isFreePrice(atomic: string | bigint): boolean {
  try {
    return toAtomic(atomic) === 0n;
  } catch {
    return false;
  }
}

/** The price as a person reads it: `free`, or `0.0012 ℏ / call`. */
export function priceLabel(
  atomic: string | bigint,
  unit: PriceUnit,
  decimals = HBAR_DECIMALS,
): string {
  if (isFreePrice(atomic)) return "free";
  return `${formatAmount(atomic, decimals)} ℏ / ${PRICE_UNIT_LABEL[unit]}`;
}

/** Short symbol for an asset id. HBAR is the native asset `0.0.0`. */
export function assetSymbol(asset: string): string {
  return asset === HBAR_ASSET ? "ℏ" : asset;
}

/**
 * Quote for a request. `units` is 1 for per_call services and the caller's
 * declared row/token budget otherwise, so a response of 5000 tokens genuinely
 * costs more than one of 50.
 */
export function quoteFor(priceAtomic: string | bigint, units: number): bigint {
  if (!Number.isInteger(units) || units < 1) {
    throw new Error(`units must be a positive integer, got ${units}`);
  }
  return toAtomic(priceAtomic) * BigInt(units);
}

/** Clamps a requested unit count into the range the marketplace allows. */
export const MAX_UNITS = 100_000;

export function normalizeUnits(raw: unknown, unit: PriceUnit): number {
  if (raw === undefined || raw === null || raw === "") return 1;

  // Syntax is validated even for per_call services, so a caller that sends a
  // nonsense budget is told so rather than silently billed for one unit.
  // The regex matters: Number("1e3") is a finite integer, and exponent
  // notation must not be a way to smuggle in a 1000-unit budget.
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error("units must be a positive integer");
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("units must be a positive integer");
  }
  if (parsed > MAX_UNITS) {
    throw new Error(`units exceeds the maximum of ${MAX_UNITS}`);
  }

  // A per_call service bills once no matter what budget was requested.
  return unit === "per_call" ? 1 : parsed;
}
