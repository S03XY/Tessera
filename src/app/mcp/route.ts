import { createMcpHandler } from "mcp-handler";
import { registerMarketplaceTools } from "@/lib/mcp-server";
import { authenticateAgent, parseBearer, type AgentAccount } from "@/lib/wallet";
import { anonymousKey } from "@/lib/quota";

/**
 * The marketplace as one MCP server.
 *
 * This is the URL the whole idea reduces to. An agent adds it once and can
 * then find and pay for any API in the catalogue — including ones listed after
 * it connected — without an integration, an SDK, or a wallet of its own.
 *
 * Authentication is deliberately optional. A connection with no token can
 * still search and describe, because a catalogue an agent cannot browse before
 * signing up is a catalogue it will not sign up for. Spending is what needs a
 * token, and the tools that spend say so in a message the model can act on
 * rather than a 401 that drops the connection.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function agentFor(request: Request): Promise<AgentAccount | null> {
  return authenticateAgent(parseBearer(request.headers.get("authorization")));
}

async function handle(request: Request): Promise<Response> {
  // The agent is resolved per request because the handler is stateless: there
  // is no session to hang an identity on, which is exactly what makes this
  // scale on ordinary serverless infrastructure.
  const agent = await agentFor(request);

  // Only consulted for the free-tool allowance, and only when there is no
  // agent — a token, or a proven human behind one, is a far better key than a
  // network address. Hashed inside `anonymousKey`; the raw address is not kept.
  const clientKey = anonymousKey(
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
  );

  const handler = createMcpHandler(
    (server) => {
      registerMarketplaceTools(server, agent, clientKey);
    },
    {
      serverInfo: { name: "tessera-marketplace", version: "0.1.0" },
      instructions:
        "Tessera is a marketplace of paid APIs that settle per call on Hedera. " +
        "Search for a capability, check the price, then call it. You are charged " +
        "only when a provider delivers; a failed call is refunded in full. " +
        "Searching and describing are always free.",
    },
  );

  return handler(request);
}

export { handle as GET, handle as POST, handle as DELETE };
