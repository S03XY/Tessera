import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { registerAgent } from "@/lib/wallet";
import { BASE_URL, treasury, treasuryConfigured } from "@/lib/config";
import { formatAmount } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Registering a buying agent.
 *
 * Returns the token exactly once. It is stored as a SHA-256 digest and cannot
 * be recovered, so a caller who loses it registers again — which is the right
 * trade: a marketplace that can show you your own bearer token can also show
 * it to whoever compromises its database.
 *
 * Caps are set here rather than at call time because they belong to the
 * owner, not the agent. An agent cannot raise its own ceiling.
 */

const Body = z.object({
  label: z.string().min(2).max(60),
  owner_account: z.string().min(3).max(64),
  agent_account: z.string().min(3).max(64).optional(),
  /** Atomic units (tinybars). Omit for no cap. */
  per_call_cap: z.string().regex(/^\d+$/).optional(),
  per_day_cap: z.string().regex(/^\d+$/).optional(),
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

  const { agent, token } = await registerAgent({
    label: input.label.trim(),
    ownerAccount: input.owner_account.trim(),
    agentAccount: (input.agent_account ?? input.owner_account).trim(),
    perCallCap: input.per_call_cap ? BigInt(input.per_call_cap) : null,
    perDayCap: input.per_day_cap ? BigInt(input.per_day_cap) : null,
  });

  return NextResponse.json(
    {
      ok: true,
      agent: {
        id: agent.id,
        label: agent.label,
        owner_account: agent.owner_account,
        balance_atomic: agent.balance,
        per_call_cap: agent.per_call_cap,
        per_day_cap: agent.per_day_cap,
      },
      /** Shown once. Never retrievable again. */
      token,
      funding: treasuryConfigured
        ? {
            send_to: treasury.accountId,
            memo: `agent:${agent.id}`,
            then: `POST ${BASE_URL}/api/agents/fund with the transaction id`,
            note:
              "Transfer HBAR from your own wallet, then submit the transaction id. " +
              "The credit is read back from the mirror node, not taken from your word.",
          }
        : {
            unavailable:
              "This deployment has no treasury account configured, so balances cannot be funded.",
          },
      connect: {
        url: `${BASE_URL}/mcp`,
        header: "Authorization: Bearer <token>",
        claude_desktop: {
          mcpServers: {
            tessera: {
              url: `${BASE_URL}/mcp`,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
      },
      caps: {
        per_call_display: agent.per_call_cap ? `${formatAmount(agent.per_call_cap)} ℏ` : "unlimited",
        per_day_display: agent.per_day_cap ? `${formatAmount(agent.per_day_cap)} ℏ` : "unlimited",
      },
    },
    { status: 201 },
  );
}
