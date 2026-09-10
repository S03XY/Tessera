import { NextResponse } from "next/server";
import { runWorldChecks } from "@/lib/world-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Whether this deployment's World ID setup actually works.
 *
 * Exists so nobody has to read a terminal — or hand their signing key to
 * someone else — to find out which part of the Developer Portal setup is
 * missing. The checks probe World's own endpoints and return only their
 * verdicts; the signing key is used to sign a throwaway challenge and never
 * leaves the server.
 */
export async function GET() {
  const report = await runWorldChecks();
  return NextResponse.json(report, {
    // Every field is deployment configuration rather than user data, but it is
    // still operator-facing: never let a proxy hold on to it.
    headers: { "cache-control": "no-store" },
  });
}
