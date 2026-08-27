import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test-only teardown so the suite can remove listings it created.
 * Disabled unless ALLOW_TEST_ROUTES is set, so it can never exist in a real
 * deployment.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  if (process.env.ALLOW_TEST_ROUTES !== "1") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { slug } = await context.params;
  await query(`DELETE FROM services WHERE slug = $1 AND category = 'test'`, [slug]);
  return NextResponse.json({ deleted: slug });
}
