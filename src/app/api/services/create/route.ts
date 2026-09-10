import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { getSellerByAccount } from "@/lib/repo";
import { assertPublicUrl, UnsafeUrlError } from "@/lib/ssrf";
import { PRICE_UNITS } from "@/lib/money";
import { requiredDeposit } from "@/lib/config";
import { formatAmount } from "@/lib/money";
import { credentialSpec } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Listing creation — the gate.
 *
 * Three conditions, checked in this order so the error tells the seller what
 * to fix first:
 *   1. the account is a registered seller
 *   2. The configured World ID credential has been proven
 *   3. the dispute deposit is at or above the minimum
 *
 * The endpoint URL is validated against the SSRF rules here as well as at
 * call time, so an obviously-internal address is rejected at listing rather
 * than silently failing on every call.
 */

const Body = z.object({
  account_id: z.string().min(3).max(64),
  name: z.string().min(3).max(80),
  description: z.string().min(10).max(600),
  category: z.string().min(2).max(40).default("general"),
  endpoint_url: z.string().min(8).max(2000),
  price_amount: z.string().regex(/^\d+$/, "price must be an integer in tinybars"),
  price_unit: z.enum(PRICE_UNITS as [string, ...string[]]),
  keywords: z.array(z.string().min(1).max(40)).max(12).default([]),
});

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const input = parsed.data;

  /* --------------------------------------------------------- the gate */

  const seller = await getSellerByAccount(input.account_id.trim());

  if (!seller) {
    return NextResponse.json(
      {
        error: "not_a_seller",
        message:
          `This account is not registered. Complete World ID ${credentialSpec().label} first.`,
      },
      { status: 403 },
    );
  }

  if (seller.verification_status !== "verified") {
    return NextResponse.json(
      {
        error: "not_verified",
        message:
          `This account has not passed World ID ${credentialSpec().label}. Verification is required before listing a service.`,
      },
      { status: 403 },
    );
  }

  // Priced by the credential this seller actually proved: the deposit exists
  // to make them replaceable-at-a-cost, and that cost is exactly what a
  // personhood credential measures.
  const required = requiredDeposit(seller.world_credential);
  if (BigInt(seller.deposit_amount) < required) {
    return NextResponse.json(
      {
        error: "deposit_too_low",
        message: `A dispute deposit of at least ${formatAmount(
          required,
        )} ℏ is required before listing. Currently holding ${formatAmount(
          seller.deposit_amount,
        )} ℏ.`,
        required: required.toString(),
        held: seller.deposit_amount,
        credential: seller.world_credential,
      },
      { status: 403 },
    );
  }

  /* ------------------------------------------------------ the listing */

  let endpoint: URL;
  try {
    endpoint = await assertPublicUrl(input.endpoint_url.trim());
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json(
        { error: "unsafe_endpoint", message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }

  if (BigInt(input.price_amount) <= 0n) {
    return NextResponse.json(
      { error: "invalid_price", message: "Price must be greater than zero." },
      { status: 400 },
    );
  }

  // Slugs are unique; append a short discriminator rather than failing.
  const base = slugify(input.name) || "service";
  let slug = base;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const taken = await queryOne<{ id: string }>(`SELECT id FROM services WHERE slug = $1`, [slug]);
    if (!taken) break;
    slug = `${base}-${attempt + 1}`;
  }

  const rows = await query<{ id: string; slug: string }>(
    `INSERT INTO services
       (seller_id, slug, name, description, category, endpoint_url,
        price_amount, price_unit, keywords, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
     RETURNING id, slug`,
    [
      seller.id,
      slug,
      input.name.trim(),
      input.description.trim(),
      input.category.trim().toLowerCase(),
      endpoint.toString(),
      input.price_amount,
      input.price_unit,
      input.keywords.map((keyword) => keyword.trim().toLowerCase()),
    ],
  );

  return NextResponse.json({ service: rows[0] }, { status: 201 });
}
