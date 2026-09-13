import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ClaimError, resolveClaim } from "@/lib/claims";
import { drainReceipts } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  decision: z.enum(["upheld", "rejected"]),
  rationale: z.string().min(1).max(1000),
});

/**
 * Resolver endpoint for claims that need judgement. Upholding executes the
 * refund out of the seller's deposit.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const secret = process.env.RESOLVER_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  try {
    const claim = await resolveClaim(id, parsed.data.decision, parsed.data.rationale);
    // An upheld claim queues a refund receipt; submit it now rather than at the
    // daily cron.
    after(() => drainReceipts(5).catch(() => undefined));
    return NextResponse.json(claim);
  } catch (err) {
    if (err instanceof ClaimError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
}
