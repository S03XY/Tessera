import { createMcpHandler } from "mcp-handler";
import { registerListingTools } from "@/lib/mcp-server";
import { getMcpServerBySlug, toolsForMcpServer } from "@/lib/repo";
import { authenticateAgent, parseBearer } from "@/lib/wallet";
import { anonymousKey } from "@/lib/quota";
import type { ToolListing } from "@/lib/mcp-tools";

/**
 * One seller's API, published as an MCP server.
 *
 * The seller gave us a specification. We shaped it into tools, priced each
 * one, and put it here. Nothing was written by the seller for MCP, and no code
 * of theirs runs on our side — the tools are rows in Postgres, assembled into
 * a server on each request.
 *
 * An agent that already knows which provider it wants prefers this over /mcp,
 * because the model sees real named tools rather than a slug it has to search
 * for first.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ slug: string }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { slug } = await context.params;

  const published = await getMcpServerBySlug(slug);
  if (!published || published.status !== "active") {
    return Response.json(
      {
        error: "unknown_server",
        message: `No MCP server is published at “${slug}”.`,
      },
      { status: 404 },
    );
  }

  const [agent, listings] = await Promise.all([
    authenticateAgent(parseBearer(request.headers.get("authorization"))),
    toolsForMcpServer(published.id),
  ]);

  const handler = createMcpHandler(
    (server) => {
      registerListingTools(
        server,
        listings as unknown as ToolListing[],
        agent,
        anonymousKey(
          request.headers.get("x-forwarded-for"),
          request.headers.get("x-real-ip"),
        ),
      );
    },
    {
      serverInfo: { name: `tessera-${published.slug}`, version: "0.1.0" },
      instructions:
        `${published.name}. ${published.description}\n\n` +
        `Every tool here is metered and paid per call, settled on Hedera to the ` +
        `provider. Prices are stated in each tool's description. You are charged ` +
        `only when a call succeeds; a failure is refunded in full.`,
    },
  );

  return handler(request);
}

export { handle as GET, handle as POST, handle as DELETE };
