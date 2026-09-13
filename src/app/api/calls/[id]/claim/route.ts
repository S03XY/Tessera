import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { CLAIM_REASONS, ClaimError, fileClaim } from "@/lib/claims";
import { drainReceipts } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  reason: z.enum(CLAIM_REASONS),
  evidence: z.string().max(2000).optional(),
});

/** Files a dispute against a delivered call. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

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
      {
        error: "invalid_request",
        message: `reason must be one of: ${CLAIM_REASONS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const claim = await fileClaim({ callId: id, ...parsed.data });
    // An objectively checkable claim is upheld on the spot and queues a refund
    // receipt; submit it now rather than at the daily cron.
    after(() => drainReceipts(5).catch(() => undefined));
    return NextResponse.json(claim, { status: 201 });
  } catch (err) {
    if (err instanceof ClaimError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    throw err;
  }
}
