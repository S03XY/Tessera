import type { PriceUnit } from "@/lib/money";

/**
 * Metering.
 *
 * A flat per-request fee is the thing this marketplace is explicitly not.
 * The buyer declares how many units it is willing to pay for, the quote is
 * price × units, and the gateway then holds the response to that budget — so
 * a call returning 5000 tokens really does cost more than one returning 50,
 * and a buyer can never be billed for more than it agreed to.
 */

/** Deterministic token estimate. Documented so buyers can predict the bill. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 characters per token, the standard rough BPE ratio, rounded up.
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface MeteredResult {
  body: string;
  units: number;
  truncated: boolean;
}

/**
 * Applies the buyer's unit budget to an upstream response.
 *
 * per_call  — one unit, body untouched.
 * per_row   — a JSON array is trimmed to `budget` elements; anything else is
 *             trimmed to `budget` newline-delimited records.
 * per_token — text trimmed to the character span covered by `budget` tokens.
 */
export function meterResponse(
  unit: PriceUnit,
  budget: number,
  body: string,
  contentType: string,
): MeteredResult {
  if (unit === "per_call") {
    return { body, units: 1, truncated: false };
  }

  if (unit === "per_row") {
    if (contentType.includes("json")) {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) {
          const truncated = parsed.length > budget;
          const kept = truncated ? parsed.slice(0, budget) : parsed;
          return {
            body: JSON.stringify(kept),
            units: kept.length,
            truncated,
          };
        }
        // A JSON object is a single row.
        return { body, units: 1, truncated: false };
      } catch {
        // Fall through to line counting on malformed JSON.
      }
    }

    const lines = body.split("\n").filter((line) => line.trim() !== "");
    const truncated = lines.length > budget;
    const kept = truncated ? lines.slice(0, budget) : lines;
    return { body: kept.join("\n"), units: Math.max(kept.length, 1), truncated };
  }

  // per_token
  const maxChars = budget * 4;
  const truncated = body.length > maxChars;
  const kept = truncated ? body.slice(0, maxChars) : body;
  return { body: kept, units: estimateTokens(kept), truncated };
}
