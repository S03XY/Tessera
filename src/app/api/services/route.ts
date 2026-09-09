import { NextResponse, type NextRequest } from "next/server";
import { discoverServices } from "@/lib/repo";
import { isPriceUnit } from "@/lib/money";
import { BASE_URL } from "@/lib/config";
import { buyerAgentIdentity, sellerIdentity } from "@/lib/agent-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent-facing discovery.
 *
 * This is the endpoint an autonomous buyer hits: plain HTTP, no key, no
 * session. Results carry the paid URL so an agent can go straight from
 * "find me a gold price" to a 402 without scraping a web page.
 *
 * Every seller is published with its HCS-14 Universal Agent ID. That
 * identifier is derived, not assigned, so a buyer can recompute it from the
 * seller's public details and confirm it is dealing with the same counterparty
 * it dealt with last time — without this marketplace vouching for anyone.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const unitParam = params.get("unit");
  const unit = isPriceUnit(unitParam) ? unitParam : undefined;

  const limitRaw = Number(params.get("limit") ?? 25);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;

  const maxPrice = params.get("max_price") ?? undefined;
  if (maxPrice && !/^\d+$/.test(maxPrice)) {
    return NextResponse.json(
      { error: "invalid_max_price", message: "max_price must be an integer in atomic units." },
      { status: 400 },
    );
  }

  const services = await discoverServices({
    q: params.get("q") ?? undefined,
    category: params.get("category") ?? undefined,
    unit,
    maxPrice,
    limit,
    // An agent must never be handed a listing the gateway would refuse.
    payableOnly: true,
  });

  const payable = services;

  return NextResponse.json(
    {
      count: payable.length,
      /** HCS-14 identity of the reference buyer this marketplace operates. */
      agent: process.env.AGENT_ACCOUNT_ID
        ? buyerAgentIdentity(process.env.AGENT_ACCOUNT_ID).uaid
        : null,
      query: {
        q: params.get("q") ?? null,
        category: params.get("category") ?? null,
        unit: unit ?? null,
        max_price: maxPrice ?? null,
      },
      services: payable.map((service) => ({
        slug: service.slug,
        name: service.name,
        description: service.description,
        category: service.category,
        price: {
          amount: service.price_amount,
          asset: service.asset,
          decimals: service.asset_decimals,
          unit: service.price_unit,
        },
        seller: {
          name: service.seller_name,
          account: service.seller_account,
          verified: service.seller_status === "verified",
          uaid: sellerIdentity(service.seller_account, service.seller_name).uaid,
        },
        stats: {
          calls_ok: Number(service.calls_ok),
          calls_failed: Number(service.calls_failed),
          success_rate: service.success_rate,
        },
        // Everything an agent needs to make the paid request itself.
        paid_url: `${BASE_URL}/x402/${service.slug}`,
        x402: {
          version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          pay_to: service.seller_account,
        },
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
