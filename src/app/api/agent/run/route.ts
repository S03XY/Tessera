import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  capability: z.string().min(1).max(200),
  units: z.number().int().min(1).max(100_000).optional(),
});

/** Runs one buyer-agent cycle: discover, select, quote, cap-check, pay, consume. */
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

  const result = await runAgent(parsed.data);
  return NextResponse.json(result, {
    status: result.error && !result.paid ? 200 : 200,
    headers: { "cache-control": "no-store" },
  });
}
