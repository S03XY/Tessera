import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSellerByAccount } from "@/lib/repo";
import { fetchSpec, normaliseSlug, planFromSpec, publishServer, PublishError } from "@/lib/publish";
import { BASE_URL, MCP_MAX_TOOLS, requiredDeposit } from "@/lib/config";
import { formatAmount, PRICE_UNITS } from "@/lib/money";
import { credentialSpec } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Publish a seller's API as an MCP server.
 *
 * The same gate as any other listing, in the same order, so the error tells
 * the seller what to fix first: registered, verified, funded. An MCP server is
 * a bundle of listings and gets no softer treatment than one — every tool it
 * publishes is backed by the seller's dispute deposit exactly as a hand-written
 * listing is.
 */

const Body = z
  .object({
    account_id: z.string().min(3).max(64),
    slug: z.string().min(2).max(60).optional(),
    name: z.string().min(3).max(80).optional(),
    description: z.string().max(600).optional(),

    spec_url: z.string().min(8).max(2000).optional(),
    spec: z.string().min(20).max(4_000_000).optional(),
    base_url: z.string().max(2000).optional(),

    // 0 is legal and means the tool is published free.
    price_amount: z.string().regex(/^\d+$/, "price must be a whole number of tinybars, or 0"),
    price_unit: z.enum(PRICE_UNITS as [string, ...string[]]).default("per_call"),
    price_overrides: z.record(z.string(), z.string().regex(/^\d+$/)).optional(),
    /** Tool names to publish free, whatever the default price is. */
    free_tools: z.array(z.string().min(1).max(64)).max(200).optional(),
    category: z.string().min(2).max(40).optional(),

    max_tools: z.number().int().min(1).max(200).optional(),
    include_tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    only: z.array(z.string().min(1).max(64)).max(200).optional(),

    auth_mode: z.enum(["none", "bearer", "api_key_header", "api_key_query"]).default("none"),
    /** Name of the env var holding the credential — never the credential. */
    auth_ref: z.string().max(80).optional(),
    auth_param: z.string().max(80).optional(),

    activate: z.boolean().default(true),
  })
  .refine((value) => Boolean(value.spec_url || value.spec), {
    message: "Provide either spec_url or spec.",
  });

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const input = parsed.data;

  /* ----------------------------------------------------------- the gate */

  const seller = await getSellerByAccount(input.account_id.trim());

  if (!seller) {
    return NextResponse.json(
      {
        error: "not_a_seller",
        message: `This account is not registered. Complete World ID ${credentialSpec().label} first.`,
      },
      { status: 403 },
    );
  }

  if (seller.verification_status !== "verified") {
    return NextResponse.json(
      {
        error: "not_verified",
        message: `This seller has not passed World ID ${credentialSpec().label}.`,
      },
      { status: 403 },
    );
  }

  const required = requiredDeposit(seller.world_credential);
  if (BigInt(seller.deposit_amount) < required) {
    return NextResponse.json(
      {
        error: "deposit_too_low",
        message:
          `A dispute deposit of at least ${formatAmount(required)} ℏ is required ` +
          `before publishing. This seller has ${formatAmount(seller.deposit_amount)} ℏ.`,
        required: required.toString(),
        credential: seller.world_credential,
      },
      { status: 403 },
    );
  }

  /* -------------------------------------------------------- shape + write */

  try {
    const specText = input.spec ?? (await fetchSpec(input.spec_url as string));

    const plan = planFromSpec(specText, {
      specUrl: input.spec_url ?? null,
      baseUrl: input.base_url ?? null,
      maxTools: input.max_tools ?? MCP_MAX_TOOLS,
      includeTags: input.include_tags,
      only: input.only,
    });

    const slug = normaliseSlug(input.slug ?? plan.title);

    const result = await publishServer(
      {
        sellerId: seller.id,
        slug,
        name: input.name ?? plan.title,
        description: input.description ?? plan.description,
        plan,
        specUrl: input.spec_url ?? null,
        price: input.price_amount,
        priceUnit: input.price_unit as "per_call" | "per_token" | "per_row",
        priceOverrides: input.price_overrides,
        freeTools: input.free_tools,
        category: input.category,
        auth: {
          mode: input.auth_mode,
          ref: input.auth_ref ?? null,
          param: input.auth_param ?? null,
        },
        activate: input.activate,
      },
      BASE_URL,
    );

    return NextResponse.json(
      {
        ok: true,
        server: {
          id: result.serverId,
          slug: result.slug,
          url: result.url,
          tool_count: result.toolCount,
          free_tools: result.freeCount,
          paid_tools: result.toolCount - result.freeCount,
          status: input.activate ? "active" : "draft",
        },
        tools: result.tools,
        dropped: { count: plan.dropped.length, truncated: plan.truncated },
        connect: {
          // What a person pastes into a client, verbatim.
          claude_desktop: { mcpServers: { [result.slug]: { url: result.url } } },
          note:
            "Agents connect to this URL directly. To spend, they present " +
            "`Authorization: Bearer <agent token>`.",
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PublishError) {
      const status = err.code === "slug_taken" ? 409 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { error: "publish_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
