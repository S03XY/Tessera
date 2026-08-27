import { NextResponse, type NextRequest } from "next/server";
import { drainReceipts } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel Cron target. Submits queued HCS receipts.
 *
 * Vercel signs cron invocations with CRON_SECRET; when that is set we require
 * it, so the drain cannot be triggered by anyone who finds the URL.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const result = await drainReceipts(20);
  return NextResponse.json(result, {
    status: result.configured || result.pending === 0 ? 200 : 202,
    headers: { "cache-control": "no-store" },
  });
}
