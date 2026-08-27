import { NextResponse, type NextRequest } from "next/server";
import { verificationStatus, isHederaAccountId } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Onboarding status for one seller account. */
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("account_id")?.trim() ?? "";

  if (!isHederaAccountId(accountId)) {
    return NextResponse.json(
      { error: "invalid_account", message: "account_id must look like 0.0.12345." },
      { status: 400 },
    );
  }

  const seller = await verificationStatus(accountId);
  if (!seller) {
    return NextResponse.json(
      { error: "not_found", message: "No seller registered for that account yet." },
      { status: 404 },
    );
  }

  return NextResponse.json({ seller }, { headers: { "cache-control": "no-store" } });
}
