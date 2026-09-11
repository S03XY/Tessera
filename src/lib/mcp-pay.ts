import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { BASE_URL, X402_NETWORK, treasury, treasuryConfigured, hashscanTx } from "@/lib/config";
import { parsePrivateKey } from "@/lib/hedera";
import { X402_VERSION } from "@/lib/x402";
import { query } from "@/lib/db";
import { getServiceBySlug, type ServiceListing } from "@/lib/repo";
import { normalizeUnits, quoteFor, formatAmount } from "@/lib/money";
import { authoriseSpend, debit, refund, type AgentAccount } from "@/lib/wallet";
import { isFreeTool } from "@/lib/mcp-tools";
import {
  anonymousKey,
  bucketFor,
  consumeFreeCall,
  exhaustedMessage,
  releaseFreeCall,
} from "@/lib/quota";

/**
 * Paying for a tool call.
 *
 * The rule this file exists to enforce is that the marketplace never pays a
 * seller more than the buying agent has already been charged. That sounds
 * obvious and is easy to get backwards: the natural order — call the seller,
 * then bill the agent — leaves a window where a concurrent call has drained
 * the balance and the payout has already happened.
 *
 * So the order is reserve, deliver, reconcile:
 *
 *   1. ask the gateway what it costs, and take *its* number, not ours
 *   2. check every spending gate
 *   3. debit the agent — the reservation
 *   4. sign and make the paid call
 *   5. refund in full if the seller did not deliver
 *
 * Step 1 matters more than it looks. Quoting from our own copy of the price
 * would let a listing whose price changed between search and call settle at a
 * different number than the one the agent was charged. Asking the gateway for
 * a 402 costs nothing and makes the two impossible to diverge.
 *
 * The delivery itself is deliberately *not* reimplemented here. It goes
 * through the same `/x402/<slug>` gateway a wallet-carrying agent uses, so MCP
 * traffic gets the same metering, replay guard, dispute window and HCS receipt
 * as everything else. This module is the payer, not a second gateway.
 */

/* ------------------------------------------------------------------- Types */

export type PayErrorCode =
  | "unknown_service"
  | "service_unavailable"
  | "quote_failed"
  | "price_above_max"
  | "agent_revoked"
  | "per_call_cap_exceeded"
  | "insufficient_balance"
  | "daily_cap_exceeded"
  | "treasury_unconfigured"
  | "signing_failed"
  | "upstream_failed"
  | "invalid_arguments"
  /** The free-tool allowance for this caller is spent for today. */
  | "free_quota_exhausted";

export interface PaidCallResult {
  ok: boolean;
  error: { code: PayErrorCode; message: string } | null;

  slug: string;
  serviceName: string | null;
  sellerName: string | null;

  /** What the gateway quoted, in atomic units. */
  quote: bigint | null;
  /** What actually settled, when it did. */
  paid: string | null;
  units: number;
  truncated: boolean;

  body: string | null;
  contentType: string;
  callId: string | null;
  transaction: string | null;
  explorerUrl: string | null;

  /** The agent's balance after this call, refunds included. */
  balance: bigint | null;
  refunded: boolean;
  /** True when the tool was free: nothing was quoted, charged or settled. */
  free: boolean;
}

export interface PaidCallInput {
  /** Absent is legal: a free tool needs no agent, no balance and no wallet. */
  agent: AgentAccount | null;
  slug: string;
  args?: Record<string, unknown>;
  units?: number;
  /** Refuse if the gateway quotes above this, in atomic units. */
  maxPrice?: bigint | null;
  /**
   * Coarse fingerprint of an unauthenticated caller, for the free-tool
   * allowance. Only consulted when there is no agent — a token or a proven
   * human is a better key than a network address ever is.
   */
  clientKey?: string;
}

/**
 * Seams for testing.
 *
 * Every one of these reaches the network or a chain in production, and the
 * failure branches — a seller that times out, a facilitator that rejects a
 * signature — are the branches most worth testing and the hardest to provoke
 * for real. Injecting them is what makes the negative cases
 * reachable in a unit test.
 */
export interface PayDeps {
  fetchImpl: typeof fetch;
  signPayment: (requirements: PaymentRequirements) => Promise<string>;
  treasuryIsConfigured: boolean;
  baseUrl: string;
}

export function defaultDeps(): PayDeps {
  return {
    fetchImpl: fetch,
    signPayment: signWithTreasury,
    treasuryIsConfigured: treasuryConfigured,
    baseUrl: BASE_URL,
  };
}

/* ---------------------------------------------------------------- Signing */

/**
 * Signs an x402 payment from the marketplace treasury.
 *
 * The signature authorises a transfer from the treasury account to the seller.
 * The buying agent's money moved earlier, into that treasury, and its claim on
 * the float is the ledger — not this signature.
 */
export async function signWithTreasury(requirements: PaymentRequirements): Promise<string> {
  const signer = createClientHederaSigner(
    treasury.accountId,
    parsePrivateKey(treasury.privateKey, treasury.keyType),
    { network: X402_NETWORK },
  );
  const scheme = new ExactHederaScheme(signer);
  const signed = await scheme.createPaymentPayload(X402_VERSION, requirements);

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted: requirements,
    payload: signed.payload,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/* -------------------------------------------------------------- Gateway URL */

/**
 * Where and how to call the gateway for this listing.
 *
 * An openapi-backed listing always posts its arguments as a JSON body, because
 * the gateway has to rebuild an upstream request from them. Everything else
 * keeps the shape it has always had, so no existing listing changes behaviour
 * because MCP was added.
 */
export function gatewayRequestFor(
  listing: Pick<ServiceListing, "slug" | "upstream_kind" | "endpoint_method" | "price_unit">,
  baseUrl: string,
  args: Record<string, unknown>,
  units: number,
): { url: string; method: "GET" | "POST"; body: string | null } {
  const url = new URL(`/x402/${listing.slug}`, baseUrl);
  if (listing.price_unit !== "per_call") url.searchParams.set("units", String(units));

  if (listing.upstream_kind === "openapi") {
    return { url: url.toString(), method: "POST", body: JSON.stringify(args ?? {}) };
  }

  if (listing.endpoint_method === "POST") {
    const body = args?.body === undefined ? null : JSON.stringify(args.body);
    return { url: url.toString(), method: "POST", body };
  }

  return { url: url.toString(), method: "GET", body: null };
}

/* -------------------------------------------------------------------- Pay */

export async function payAndCall(
  input: PaidCallInput,
  overrides: Partial<PayDeps> = {},
): Promise<PaidCallResult> {
  const deps: PayDeps = { ...defaultDeps(), ...overrides };
  const { agent, slug } = input;

  const balanceOf = (): bigint => {
    try {
      return agent ? BigInt(agent.balance) : 0n;
    } catch {
      return 0n;
    }
  };

  const base = (): PaidCallResult => ({
    ok: false,
    error: null,
    slug,
    serviceName: null,
    sellerName: null,
    quote: null,
    paid: null,
    units: 1,
    truncated: false,
    body: null,
    contentType: "application/json",
    callId: null,
    transaction: null,
    explorerUrl: null,
    balance: balanceOf(),
    refunded: false,
    free: false,
  });

  const fail = (code: PayErrorCode, message: string, partial: Partial<PaidCallResult> = {}) => ({
    ...base(),
    ...partial,
    ok: false,
    error: { code, message },
  });

  /* ----------------------------------------------------------- 0. listing */

  const listing = await getServiceBySlug(slug);
  if (!listing) {
    return fail("unknown_service", `No service is listed at “${slug}”.`);
  }
  if (listing.status !== "active") {
    return fail(
      "service_unavailable",
      `“${listing.name}” is ${listing.status} and is not accepting calls.`,
      { serviceName: listing.name, sellerName: listing.seller_name },
    );
  }

  let units: number;
  try {
    units = normalizeUnits(input.units, listing.price_unit);
  } catch (err) {
    return fail("invalid_arguments", (err as Error).message, {
      serviceName: listing.name,
      sellerName: listing.seller_name,
    });
  }

  const context = {
    serviceName: listing.name,
    sellerName: listing.seller_name,
    units,
  };

  const request = gatewayRequestFor(listing, deps.baseUrl, input.args ?? {}, units);

  /* -------------------------------------------------------- 0b. free tool */

  /**
   * A free tool short-circuits everything below.
   *
   * No quote, no spending gates, no signature, no ledger
   * entry — there is nothing to authorise, and running the paid path with an
   * amount of zero would refuse the call outright, because `authoriseSpend`
   * quite correctly treats a non-positive quote as a bug rather than a
   * bargain.
   *
   * It also means a free tool needs no agent at all, which is the point: an
   * agent can connect with no token, no balance and no wallet, call the free
   * tools, and only then decide whether the paid ones are worth funding.
   */
  if (isFreeTool(listing)) {
    /*
     * Free does not mean unlimited.
     *
     * The seller is paying the upstream bill for every one of these, so the
     * allowance is spent *before* the call goes out rather than after — the
     * whole point is to not make the request. A caller who is over their
     * allowance is told which limit stopped them and when it resets.
     */
    const bucket = bucketFor(agent, input.clientKey ?? anonymousKey(null, null));
    const quota = await consumeFreeCall(bucket);
    if (!quota.allowed) {
      return fail("free_quota_exhausted", exhaustedMessage(quota), context);
    }

    let response: Response;
    try {
      response = await deps.fetchImpl(request.url, {
        method: request.method,
        cache: "no-store",
        ...(request.body !== null
          ? { body: request.body, headers: { "content-type": "application/json" } }
          : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Symmetry with the paid path, which refunds a call that never landed.
      await releaseFreeCall(bucket);
      return fail("upstream_failed", `The provider was unreachable: ${reason}`, context);
    }

    const text = await response.text();

    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = parsed.message ?? parsed.error ?? message;
      } catch {
        // A non-JSON error body is still worth showing verbatim.
      }
      await releaseFreeCall(bucket);
      return fail("upstream_failed", message, context);
    }

    const freeCallId = isUuid(response.headers.get("x-tessera-call-id"));

    // A free call is still MCP traffic, and a seller looking at their activity
    // should see it as such. Attributed here for the same reason the paid path
    // does it — after the fact, rather than on a header the gateway would have
    // to take on faith from its caller.
    if (freeCallId) {
      try {
        await query(
          `UPDATE calls SET via = 'mcp', agent_id = COALESCE(agent_id, $2)
            WHERE id = $1 AND via IS NULL`,
          [freeCallId, agent?.id ?? null],
        );
      } catch {
        // Attribution is bookkeeping; it must never fail a delivered call.
      }
    }

    return {
      ...base(),
      ...context,
      ok: true,
      error: null,
      quote: 0n,
      paid: "0",
      free: true,
      body: text,
      contentType: response.headers.get("content-type") ?? "application/json",
      callId: freeCallId,
    };
  }

  /**
   * Past this point the tool costs money, so it needs a funded agent. Narrowing
   * here keeps every gate below free of null checks it should not be making.
   */
  if (!agent) {
    return fail(
      "insufficient_balance",
      "This tool is paid, and no agent token was presented. Register one to call it — " +
        "the free tools on this server need no token at all.",
      context,
    );
  }

  /* ------------------------------------------------------------- 1. quote */

  let requirements: PaymentRequirements;
  try {
    const response = await deps.fetchImpl(request.url, {
      method: request.method,
      cache: "no-store",
      ...(request.body !== null
        ? { body: request.body, headers: { "content-type": "application/json" } }
        : {}),
    });

    if (response.status !== 402) {
      const text = await response.text();
      return fail(
        "quote_failed",
        `The gateway did not quote a price (HTTP ${response.status}): ${text.slice(0, 200)}`,
        context,
      );
    }

    const quoted = (await response.json()) as { accepts?: PaymentRequirements[] };
    const first = quoted.accepts?.[0];
    if (!first) {
      return fail("quote_failed", "The gateway's 402 carried no payment requirements.", context);
    }
    requirements = first;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail("quote_failed", `Could not reach the gateway: ${reason}`, context);
  }

  const amount = BigInt(requirements.amount);

  /* --------------------------------------------------------- 2. the gates */

  if (input.maxPrice !== undefined && input.maxPrice !== null && amount > input.maxPrice) {
    return fail(
      "price_above_max",
      `This call quotes ${formatAmount(amount)} ℏ, above the ${formatAmount(
        input.maxPrice,
      )} ℏ ceiling you set. Nothing was spent.`,
      { ...context, quote: amount },
    );
  }

  const decision = await authoriseSpend(agent, amount);
  if (!decision.allowed) {
    return fail(decision.reason ?? "insufficient_balance", decision.message, {
      ...context,
      quote: amount,
      balance: decision.balance,
    });
  }

  if (!deps.treasuryIsConfigured) {
    return fail(
      "treasury_unconfigured",
      "This marketplace has no funded treasury account, so it cannot settle a payment " +
        "on your behalf. Set MCP_TREASURY_ACCOUNT_ID and MCP_TREASURY_KEY.",
      { ...context, quote: amount },
    );
  }

  /* ----------------------------------------------------------- 3. reserve */

  let balanceAfterDebit: bigint;
  try {
    const result = await debit({
      agentId: agent.id,
      amount,
      memo: `mcp:${listing.slug}`,
    });
    balanceAfterDebit = result.balance;
  } catch {
    // authoriseSpend passed but the UPDATE did not: a concurrent call took the
    // balance between the two. The row guard is what makes this safe.
    return fail(
      "insufficient_balance",
      "The balance was spent by another call before this one could reserve it.",
      { ...context, quote: amount },
    );
  }

  /**
   * From here on the agent has been charged, so every failure path must either
   * deliver a response or return the money. There is no third option.
   */
  const refundAll = async (): Promise<bigint> => {
    try {
      const result = await refund({
        agentId: agent.id,
        amount,
        memo: `refund:${listing.slug}`,
      });
      return result.balance;
    } catch {
      return balanceAfterDebit;
    }
  };

  /* -------------------------------------------------------------- 4. sign */

  let paymentHeader: string;
  try {
    paymentHeader = await deps.signPayment(requirements);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...fail("signing_failed", `The payment could not be signed: ${reason}`, {
        ...context,
        quote: amount,
      }),
      balance: await refundAll(),
      refunded: true,
    };
  }

  /* ------------------------------------------------------------ 5. deliver */

  let response: Response;
  try {
    response = await deps.fetchImpl(request.url, {
      method: request.method,
      cache: "no-store",
      headers: {
        "x-payment": paymentHeader,
        ...(request.body !== null ? { "content-type": "application/json" } : {}),
      },
      ...(request.body !== null ? { body: request.body } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...fail("upstream_failed", `The gateway was unreachable: ${reason}. You were refunded.`, {
        ...context,
        quote: amount,
      }),
      balance: await refundAll(),
      refunded: true,
    };
  }

  const text = await response.text();

  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // A non-JSON error body is still worth showing verbatim.
    }
    return {
      ...fail("upstream_failed", `${message} You were refunded in full.`, {
        ...context,
        quote: amount,
      }),
      balance: await refundAll(),
      refunded: true,
    };
  }

  /* ------------------------------------------------------- 6. reconcile */

  /**
   * A header that is present but empty is absent. Treating "" as a value once
   * cost a buyer a refund: it was passed as a uuid, the insert threw, and the
   * catch below swallowed it — so the unused budget was quietly kept.
   */
  const header = (name: string): string | null => {
    const value = response.headers.get(name);
    return value && value.trim() !== "" ? value : null;
  };

  const callId = isUuid(header("x-tessera-call-id"));
  const transaction = header("x-tessera-tx");
  const paid = header("x-tessera-paid");
  const deliveredUnits = Number(header("x-tessera-units") ?? units);

  let balance = balanceAfterDebit;

  /**
   * Settling for less than we reserved is legitimate — a metered call that
   * returned fewer rows than the budget allowed — and the difference belongs
   * to the buyer, not to us.
   */
  if (paid) {
    try {
      const settled = BigInt(paid);
      if (settled < amount) {
        const result = await refund({
          agentId: agent.id,
          amount: amount - settled,
          callId,
          memo: `unused budget:${listing.slug}`,
        });
        balance = result.balance;
      }
    } catch {
      // A malformed header must not turn a delivered call into a failure.
    }
  }

  // Attribute the call after the fact rather than trusting a header the
  // gateway would have to take on faith from its caller.
  if (callId) {
    try {
      await query(
        `UPDATE calls SET agent_id = $2, via = 'mcp' WHERE id = $1 AND agent_id IS NULL`,
        [callId, agent.id],
      );
      await query(`UPDATE agent_ledger SET call_id = $2 WHERE call_id IS NULL AND agent_id = $1
                    AND kind = 'debit' AND created_at > now() - interval '2 minutes'`, [
        agent.id,
        callId,
      ]);
    } catch {
      // Attribution is bookkeeping; it must never fail a delivered call.
    }
  }

  return {
    ok: true,
    error: null,
    slug: listing.slug,
    serviceName: listing.name,
    sellerName: listing.seller_name,
    quote: amount,
    paid,
    units: Number.isFinite(deliveredUnits) ? deliveredUnits : units,
    truncated: response.headers.get("x-tessera-truncated") === "true",
    body: text,
    contentType: response.headers.get("content-type") ?? "application/json",
    callId,
    transaction,
    explorerUrl: transaction ? hashscanTx(transaction) : null,
    balance,
    refunded: false,
    free: false,
  };
}

/* ------------------------------------------------------------------ Quotes */

/**
 * The price of a call without making one.
 *
 * Used by `describe_service` so an agent can price a listing before deciding,
 * which is the difference between an agent that budgets and one that discovers
 * the cost after spending it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrows a header to a usable call id.
 *
 * The refund below must not depend on this being present: money owed to a
 * buyer cannot be contingent on the shape of a bookkeeping header.
 */
function isUuid(value: string | null): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

export function quoteListing(
  listing: Pick<ServiceListing, "price_amount" | "price_unit">,
  requestedUnits?: number,
): { units: number; quote: bigint } {
  const units = normalizeUnits(requestedUnits, listing.price_unit);
  return { units, quote: quoteFor(listing.price_amount, units) };
}
