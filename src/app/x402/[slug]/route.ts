import { NextResponse, type NextRequest } from "next/server";
import type { PaymentRequirements } from "@x402/core/types";
import { queryOne, transaction } from "@/lib/db";
import { getServiceBySlug } from "@/lib/repo";
import { hashRequest, hashResponse } from "@/lib/hash";
import { meterResponse } from "@/lib/metering";
import { normalizeUnits, quoteFor } from "@/lib/money";
import { assertPublicUrl, fetchUpstream, UnsafeUrlError } from "@/lib/ssrf";
import { applyUpstreamAuth, buildUpstreamRequest, ToolArgumentError } from "@/lib/mcp-tools";
import { requiredDeposit, BASE_URL } from "@/lib/config";
import {
  anonymousKey,
  bucketFor,
  consumeFreeCall,
  exhaustedMessage,
  releaseFreeCall,
  type Bucket,
} from "@/lib/quota";
import { authenticateAgent, parseBearer } from "@/lib/wallet";
import { enqueueCallReceipt } from "@/lib/receipts";
import {
  executeSubgraphQuery,
  GraphNotConfiguredError,
  GraphQueryError,
  readGraphPrice,
  trimGraphResult,
  type GraphPrice,
} from "@/lib/graph";
import {
  buildRequirements,
  decodePaymentHeader,
  encodeSettlementHeader,
  FacilitatorError,
  paymentRequiredBody,
  PaymentHeaderError,
  settlePayment,
  transactionIdFromPayload,
  verifyPayment,
} from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The paid endpoint.
 *
 *   1. quote      — no X-PAYMENT yet, answer 402 with the price
 *   2. verify     — facilitator checks the signed transfer against our quote
 *   3. deliver    — call upstream; a failure here means nobody gets charged
 *   4. settle     — facilitator submits the transfer, seller is paid
 *   5. receipt    — enqueue an HCS receipt and return the body
 *
 * Settlement deliberately happens *after* the upstream call succeeds. Taking
 * money for a response we could not produce is the one outcome the dispute
 * flow should never have to clean up.
 */

export async function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context, null);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const body = await request.text();
  return handle(request, context, body || null);
}

type RouteContext = { params: Promise<{ slug: string }> };

async function handle(
  request: NextRequest,
  context: RouteContext,
  requestBody: string | null,
) {
  const started = Date.now();
  const { slug } = await context.params;

  /* ---------------------------------------------------------- 0. listing */

  const service = await getServiceBySlug(slug);
  if (!service) {
    return problem(404, "unknown_service", `No service is listed at “${slug}”.`);
  }
  if (service.status !== "active") {
    return problem(
      409,
      "service_unavailable",
      `Service “${slug}” is ${service.status} and is not accepting calls.`,
    );
  }
  if (service.seller_status !== "verified") {
    return problem(
      409,
      "seller_unverified",
      "The seller behind this service is not verified and cannot take payments.",
    );
  }
  if (BigInt(service.seller_deposit) < requiredDeposit()) {
    return problem(
      409,
      "seller_underfunded",
      "The seller's dispute deposit is below the marketplace minimum.",
    );
  }

  /* ------------------------------------------------------------ 1. quote */

  let units: number;
  try {
    units = normalizeUnits(request.nextUrl.searchParams.get("units"), service.price_unit);
  } catch (err) {
    return problem(400, "invalid_units", (err as Error).message);
  }

  const quoted = quoteFor(service.price_amount, units);
  const resourceUrl = `${BASE_URL}/x402/${service.slug}`;

  /**
   * A free tool.
   *
   * Zero is a real price here, not a sentinel: the seller chose it, tool by
   * tool, and a free call is still a call. It is recorded, hashed, receipted
   * and covered by the same dispute deposit as a paid one — the only thing
   * missing is the payment leg.
   *
   * Everything below is therefore skipped rather than run with an amount of
   * zero. Asking the facilitator to quote, verify and settle nothing would be
   * three network round trips to move no money, and it is the difference
   * between a free tool answering in 40ms and answering in 900.
   */
  const isFree = quoted === 0n;

  /*
   * Free does not mean unlimited.
   *
   * Payment is what rate-limits a paid tool; a free one has no such brake and
   * needs no token at all, so without this the seller pays an unbounded
   * upstream bill for whoever finds the URL. The allowance is spent before the
   * proxy runs, because the cost being managed is the request itself.
   *
   * The gateway is a public HTTP surface, so the tier here is whatever the
   * caller can prove: a bearer token if they sent one, the human behind it if
   * they proved one, and otherwise a coarse hash of where they came from.
   */
  let freeBucket: Bucket | null = null;
  if (isFree) {
    const freeAgent = await authenticateAgent(parseBearer(request.headers.get("authorization")));
    freeBucket = bucketFor(
      freeAgent,
      anonymousKey(
        request.headers.get("x-forwarded-for"),
        request.headers.get("x-real-ip"),
      ),
    );
    const quota = await consumeFreeCall(freeBucket);
    if (!quota.allowed) {
      return problem(429, "free_quota_exhausted", exhaustedMessage(quota));
    }
  }

  const requirements = isFree
    ? null
    : await buildRequirements({
        amount: quoted,
        payTo: service.seller_account,
        asset: service.asset,
      });

  const resourceInfo = {
    url: resourceUrl,
    description: service.description,
    mimeType: "application/json",
    serviceName: service.name,
    tags: [service.category, service.price_unit],
  };

  const paymentHeader = isFree ? null : request.headers.get("x-payment");

  if (!paymentHeader && !isFree) {
    // Nothing owed yet — publish the price and let the agent decide.
    return NextResponse.json(
      paymentRequiredBody([requirements!], resourceInfo, "payment required"),
      {
        status: 402,
        headers: {
          "cache-control": "no-store",
          "x-tessera-units": String(units),
          "x-tessera-unit": service.price_unit,
        },
      },
    );
  }

  /* ----------------------------------------------------------- 2. verify */

  let payload: ReturnType<typeof decodePaymentHeader> | null = null;
  let payer: string | null = null;

  if (!isFree) {
    try {
      payload = decodePaymentHeader(paymentHeader as string);
    } catch (err) {
      if (err instanceof PaymentHeaderError) {
        return problem(400, "malformed_payment", err.message);
      }
      throw err;
    }

    // The client's `accepted` block is untrusted. Verification runs against the
    // requirements we just computed, so a doctored price cannot buy a call.
    const transactionId = transactionIdFromPayload(payload);

    if (transactionId) {
      const existing = await queryOne<{ id: string }>(
        "SELECT id FROM calls WHERE payment_tx = $1",
        [transactionId],
      );
      if (existing) {
        return problem(
          409,
          "payment_replayed",
          "That payment has already been settled for a previous call.",
          { call_id: existing.id, transaction: transactionId },
        );
      }
    }

    let verification;
    try {
      verification = await verifyPayment(payload, requirements!);
    } catch (err) {
      return facilitatorProblem(err, "verify");
    }

    if (!verification.isValid) {
      return NextResponse.json(
        paymentRequiredBody(
          [requirements!],
          resourceInfo,
          verification.invalidMessage ??
            verification.invalidReason ??
            "payment verification failed",
        ),
        { status: 402, headers: { "cache-control": "no-store" } },
      );
    }

    payer = verification.payer ?? null;
  }

  /* ---------------------------------------------------------- 3. deliver */

  let upstreamStatus: number;
  let upstreamContentType: string;
  let metered: { body: string; units: number; truncated: boolean };

  /**
   * The second leg of a Graph-backed purchase: what the same query lists for
   * bought straight from The Graph. Read from their own 402 challenge, so the
   * number is the supplier's rather than ours.
   */
  let graphPrice: GraphPrice | null = null;

  if (service.upstream_kind === "graph_subgraph") {
    // The CHECK constraint on services guarantees both are present.
    const subgraphId = service.upstream_ref as string;
    const document = service.upstream_query as string;

    let data: unknown;
    try {
      data = await executeSubgraphQuery(subgraphId, document);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordFailure(service.id, quoted, service.asset, payer, reason);

      // Same rule as the http path: nothing settled, so the payer keeps their
      // money. Only the diagnosis differs.
      if (err instanceof GraphNotConfiguredError) {
        return problem(503, "graph_not_configured", reason);
      }
      const unreachable = err instanceof GraphQueryError && err.status === 503;
      return problem(
        unreachable ? 504 : 502,
        unreachable ? "graph_unreachable" : "graph_error",
        `The Graph did not answer: ${reason}. No payment was settled.`,
      );
    }

    upstreamStatus = 200;
    upstreamContentType = "application/json";

    if (service.price_unit === "per_row") {
      // A GraphQL result is a map of named lists, which the generic per_row
      // rules would count as a single row. Trim by real row count instead.
      const trimmed = trimGraphResult(data, units);
      metered = {
        body: JSON.stringify(trimmed.data),
        units: trimmed.rows,
        truncated: trimmed.truncated,
      };
    } else {
      metered = meterResponse(
        service.price_unit,
        units,
        JSON.stringify(data),
        upstreamContentType,
      );
    }

    graphPrice = await readGraphPrice(subgraphId);
  } else if (service.upstream_kind === "openapi") {
    /**
     * One tool of a published MCP server.
     *
     * The arguments arrive as a JSON body because the gateway has to rebuild
     * the seller's own request from them. Everything hostile about that — path
     * traversal, header injection, an argument trying to change the host — is
     * handled in buildUpstreamRequest, and the resulting URL still goes through
     * the same SSRF check as any other listing.
     */
    if (!service.mcp_base_url || !service.mcp_operation) {
      await recordFailure(
        service.id,
        quoted,
        service.asset,
        payer,
        "listing is missing its MCP operation",
      );
      return problem(
        500,
        "listing_misconfigured",
        "This listing is registered as an MCP tool but is missing its operation. No payment was settled.",
      );
    }

    if (service.mcp_status !== "active") {
      return problem(
        409,
        "server_unavailable",
        "The MCP server this tool belongs to is not active.",
      );
    }

    let args: Record<string, unknown>;
    try {
      args = requestBody ? (JSON.parse(requestBody) as Record<string, unknown>) : {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("arguments must be a JSON object");
      }
    } catch (err) {
      return problem(400, "invalid_arguments", `Could not read the arguments: ${(err as Error).message}`);
    }

    let built;
    try {
      built = buildUpstreamRequest(service.mcp_base_url, service.mcp_operation, args);
    } catch (err) {
      if (err instanceof ToolArgumentError) {
        // A bad argument is the caller's error, and nothing was settled.
        return problem(400, "invalid_arguments", err.message);
      }
      throw err;
    }

    built = applyUpstreamAuth(
      built,
      { mode: service.mcp_auth_mode, param: service.mcp_auth_param },
      service.mcp_auth_ref ? (process.env[service.mcp_auth_ref] ?? null) : null,
    );

    let upstreamUrl: URL;
    try {
      upstreamUrl = await assertPublicUrl(built.url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        await recordFailure(service.id, quoted, service.asset, payer, err.message);
        return problem(502, "endpoint_rejected", `Upstream endpoint rejected: ${err.message}`);
      }
      throw err;
    }

    let upstream;
    try {
      upstream = await fetchUpstream(upstreamUrl, {
        method: built.method,
        headers: built.headers,
        ...(built.body !== null ? { body: built.body } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordFailure(service.id, quoted, service.asset, payer, reason);
      return problem(504, "upstream_unreachable", `Upstream did not respond: ${reason}`);
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      await recordFailure(
        service.id,
        quoted,
        service.asset,
        payer,
        `upstream returned ${upstream.status}`,
        upstream.status,
      );
      if (freeBucket) await releaseFreeCall(freeBucket);
      return problem(
        502,
        "upstream_error",
        `Upstream returned ${upstream.status}. No payment was settled.`,
      );
    }

    upstreamStatus = upstream.status;
    upstreamContentType = upstream.contentType;
    metered = meterResponse(service.price_unit, units, upstream.body, upstream.contentType);
  } else {
    let upstreamUrl: URL;
    try {
      upstreamUrl = await assertPublicUrl(service.endpoint_url);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        await recordFailure(service.id, quoted, service.asset, payer, err.message);
        return problem(502, "endpoint_rejected", `Upstream endpoint rejected: ${err.message}`);
      }
      throw err;
    }

    let upstream;
    try {
      upstream = await fetchUpstream(upstreamUrl, {
        method: service.endpoint_method,
        ...(requestBody && service.endpoint_method === "POST"
          ? { body: requestBody, headers: { "content-type": "application/json" } }
          : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordFailure(service.id, quoted, service.asset, payer, reason);
      // No settle call was made, so the payer keeps their money — and a free
      // caller keeps the allowance they never got a response for.
      if (freeBucket) await releaseFreeCall(freeBucket);
      return problem(504, "upstream_unreachable", `Upstream did not respond: ${reason}`);
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      await recordFailure(
        service.id,
        quoted,
        service.asset,
        payer,
        `upstream returned ${upstream.status}`,
        upstream.status,
      );
      return problem(
        502,
        "upstream_error",
        `Upstream returned ${upstream.status}. No payment was settled.`,
      );
    }

    upstreamStatus = upstream.status;
    upstreamContentType = upstream.contentType;
    metered = meterResponse(
      service.price_unit,
      units,
      upstream.body,
      upstream.contentType,
    );
  }

  /* ----------------------------------------------------------- 4. settle */

  // A free tool has nothing to settle. The upstream already answered, so the
  // call is a success with no payment attached.
  let settlement: Awaited<ReturnType<typeof settlePayment>> | null = null;

  if (!isFree) {
    try {
      settlement = await settlePayment(payload!, requirements!);
    } catch (err) {
      await recordFailure(service.id, quoted, service.asset, payer, "settlement failed");
      return facilitatorProblem(err, "settle");
    }

    if (!settlement.success) {
      await recordFailure(
        service.id,
        quoted,
        service.asset,
        payer,
        settlement.errorMessage ?? settlement.errorReason ?? "settlement rejected",
      );
      return problem(
        402,
        "settlement_failed",
        settlement.errorMessage ?? settlement.errorReason ?? "Settlement was rejected.",
      );
    }
  }

  /* ---------------------------------------------------- 5. record + ship */

  const latency = Date.now() - started;
  const requestHash = hashRequest(request.method, request.nextUrl.toString(), requestBody);
  const responseHash = hashResponse(upstreamStatus, metered.body);
  const paidAmount = isFree ? "0" : (settlement!.amount ?? quoted.toString());

  const callId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO calls
         (service_id, payer_account, quoted_amount, paid_amount, units, asset,
          payment_tx, request_hash, response_hash, status, http_status,
          latency_ms, delivered_at,
          upstream_kind, upstream_ref, upstream_cost_atomic, upstream_cost_asset,
          upstream_network)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'delivered',$10,$11, now(),
               $12,$13,$14,$15,$16)
       RETURNING id`,
      [
        service.id,
        payer,
        quoted.toString(),
        paidAmount,
        metered.units,
        service.asset,
        settlement?.transaction ?? null,
        requestHash,
        responseHash,
        upstreamStatus,
        latency,
        service.upstream_kind,
        service.upstream_ref,
        // The supplier's own list price, recorded beside what the buyer paid,
        // so a receipt shows both legs of the purchase rather than half of it.
        graphPrice?.amountAtomic ?? null,
        graphPrice?.asset ?? null,
        graphPrice?.network ?? null,
      ],
    );

    await client.query(
      `UPDATE services
          SET calls_ok      = calls_ok + 1,
              revenue_total = revenue_total + $2::numeric
        WHERE id = $1`,
      [service.id, paidAmount],
    );
    await client.query(
      `UPDATE sellers SET calls_ok = calls_ok + 1 WHERE id = $1`,
      [service.seller_id],
    );

    return inserted.rows[0].id;
  });

  // HCS consensus takes seconds; the buyer must not wait for it.
  await enqueueCallReceipt(callId, {
    service_id: service.id,
    service_slug: service.slug,
    seller_account: service.seller_account,
    payer_account: payer,
    amount: paidAmount,
    asset: service.asset,
    units: metered.units,
    price_unit: service.price_unit,
    payment_tx: settlement?.transaction ?? null,
    request_hash: requestHash,
    response_hash: responseHash,
  });

  return new NextResponse(metered.body, {
    status: 200,
    headers: {
      "content-type": upstreamContentType,
      "cache-control": "no-store",
      ...(settlement ? { "x-payment-response": encodeSettlementHeader(settlement) } : {}),
      "x-tessera-call-id": callId,
      "x-tessera-units": String(metered.units),
      "x-tessera-unit": service.price_unit,
      "x-tessera-paid": paidAmount,
      "x-tessera-truncated": String(metered.truncated),
      ...(settlement?.transaction ? { "x-tessera-tx": settlement.transaction } : {}),
      "x-tessera-free": String(isFree),
    },
  });
}

/* ------------------------------------------------------------------ helpers */

/** Records a call that failed before or during settlement. */
async function recordFailure(
  serviceId: string,
  quoted: bigint,
  asset: string,
  payer: string | null,
  error: string,
  httpStatus?: number,
) {
  try {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO calls
           (service_id, payer_account, quoted_amount, asset, status, error, http_status)
         VALUES ($1,$2,$3,$4,'failed',$5,$6)`,
        [serviceId, payer, quoted.toString(), asset, error.slice(0, 500), httpStatus ?? null],
      );
      await client.query(
        `UPDATE services SET calls_failed = calls_failed + 1 WHERE id = $1`,
        [serviceId],
      );
    });
  } catch {
    // Bookkeeping must never mask the underlying delivery error.
  }
}

function problem(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    { error: code, message, ...extra },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function facilitatorProblem(err: unknown, stage: "verify" | "settle") {
  if (err instanceof FacilitatorError) {
    return problem(
      err.status === 503 ? 503 : 502,
      `facilitator_${stage}_failed`,
      err.message,
      err.body ? { facilitator: err.body } : {},
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return problem(502, `facilitator_${stage}_failed`, reason);
}

export type { PaymentRequirements };
