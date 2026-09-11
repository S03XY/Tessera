import type { McpServer } from "@modelcontextprotocol/server";
import { jsonSchemaStandard } from "@/lib/schema-standard";
import {
  isFreeTool,
  marketplaceTools,
  toolForListing,
  type McpToolDefinition,
  type ToolListing,
} from "@/lib/mcp-tools";
import { payAndCall } from "@/lib/mcp-pay";
import { discoverServices, getServiceBySlug, type ServiceListing } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL, normalizeUnits, quoteFor } from "@/lib/money";
import { spentToday, type AgentAccount } from "@/lib/wallet";
import { BASE_URL, requiredDeposit } from "@/lib/config";
import { bucketFor, quotaStatus } from "@/lib/quota";

/**
 * The MCP surface.
 *
 * Two servers are published from the same building blocks.
 *
 *   /mcp           the whole marketplace behind four fixed tools. The
 *                  catalogue can grow to thousands of listings without an
 *                  agent's context growing at all, because discovery is a tool
 *                  call rather than a tool list.
 *
 *   /mcp/<slug>    one seller's API as ordinary named tools. Better when an
 *                  agent knows what it wants, because the model sees
 *                  `get_forecast(lat, lon)` rather than a slug it must first
 *                  search for.
 *
 * Neither requires a wallet, an SDK, or an integration. That is the whole
 * point: the agent connects to a URL and can buy things.
 */

/* -------------------------------------------------------------- Rendering */

/** A tool result carrying JSON an agent can parse. */
function json(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** A tool result carrying prose, for refusals a model should read and act on. */
function text(message: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: message }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * How an unauthenticated caller is told to get a token.
 *
 * Returned as a tool result rather than a transport-level 401 on purpose: a
 * 401 disconnects the client, while this reaches the model, which can relay it
 * to the person who can act on it.
 */
function needsToken() {
  return text(
    `This call needs a funded agent token, which this connection did not present.\n\n` +
      `Register one at ${BASE_URL}/agent — you will get a token and an account to fund. ` +
      `Then reconnect with:\n\n` +
      `    Authorization: Bearer <your token>\n\n` +
      `Searching and describing listings stay free and need no token.`,
    true,
  );
}

/** Public view of a listing. Never exposes the seller's endpoint URL. */
function listingSummary(service: ServiceListing) {
  const payable =
    service.seller_status === "verified" &&
    BigInt(service.seller_deposit) >= requiredDeposit();

  return {
    slug: service.slug,
    name: service.name,
    description: service.description,
    category: service.category,
    price: {
      free: isFreeTool(service),
      amount_atomic: service.price_amount,
      display: isFreeTool(service)
        ? "free"
        : `${formatAmount(service.price_amount, service.asset_decimals)} ℏ per ${
            PRICE_UNIT_LABEL[service.price_unit]
          }`,
      unit: service.price_unit,
    },
    seller: {
      name: service.seller_name,
      account: service.seller_account,
      verified: service.seller_status === "verified",
      deposit_atomic: service.seller_deposit,
    },
    reliability: {
      calls_ok: Number(service.calls_ok),
      calls_failed: Number(service.calls_failed),
      success_rate: service.success_rate,
    },
    payable,
    kind: service.upstream_kind,
  };
}

/* --------------------------------------------------- The marketplace server */

export function registerMarketplaceTools(
  server: McpServer,
  agent: AgentAccount | null,
  clientKey?: string,
): void {
  const defs = new Map(marketplaceTools().map((tool) => [tool.name, tool]));
  const define = (name: string): McpToolDefinition => {
    const tool = defs.get(name);
    if (!tool) throw new Error(`unknown meta-tool ${name}`);
    return tool;
  };

  /* --------------------------------------------------------- search */

  const search = define("search_services");
  server.registerTool(
    search.name,
    {
      title: search.title,
      description: search.description,
      inputSchema: jsonSchemaStandard(search.inputSchema),
      annotations: search.annotations,
    },
    async (args) => {
      const { query, max_price, category, limit } = args as {
        query: string;
        max_price?: string;
        category?: string;
        limit?: number;
      };

      const results = await discoverServices({
        q: query,
        category,
        maxPrice: max_price,
        limit: Math.min(Math.max(limit ?? 10, 1), 25),
        payableOnly: true,
      });

      if (results.length === 0) {
        return text(
          `Nothing in the catalogue matches “${query}”. Try broader wording — the ` +
            `search reads capability descriptions, not exact names.`,
        );
      }

      return json({
        query,
        matches: results.length,
        note: "Ranked cheapest first, then by observed success rate. Nothing has been charged.",
        results: results.map(listingSummary),
      });
    },
  );

  /* ------------------------------------------------------- describe */

  const describe = define("describe_service");
  server.registerTool(
    describe.name,
    {
      title: describe.title,
      description: describe.description,
      inputSchema: jsonSchemaStandard(describe.inputSchema),
      annotations: describe.annotations,
    },
    async (args) => {
      const { slug } = args as { slug: string };
      const service = await getServiceBySlug(slug);
      if (!service) return text(`No listing is published at “${slug}”.`, true);

      return json({
        ...listingSummary(service),
        arguments: service.input_schema ?? {
          type: "object",
          properties:
            service.price_unit === "per_call"
              ? {}
              : { units: { type: "integer", minimum: 1 } },
        },
        dispute_window_hours: 24,
        direct_url: `${BASE_URL}/x402/${service.slug}`,
        note:
          "Call it with call_service. You are charged only if the provider delivers; " +
          "a failure refunds you in full.",
      });
    },
  );

  /* ----------------------------------------------------------- call */

  const call = define("call_service");
  server.registerTool(
    call.name,
    {
      title: call.title,
      description: call.description,
      inputSchema: jsonSchemaStandard(call.inputSchema),
      annotations: call.annotations,
    },
    async (args) => {
      const {
        slug,
        arguments: callArgs,
        units,
        max_price,
      } = args as {
        slug: string;
        arguments?: Record<string, unknown>;
        units?: number;
        max_price?: string;
      };

      let maxPrice: bigint | null = null;
      if (max_price !== undefined && max_price !== null && `${max_price}`.trim() !== "") {
        try {
          maxPrice = BigInt(`${max_price}`.trim());
        } catch {
          return text(
            `max_price must be an integer number of tinybars, got “${max_price}”.`,
            true,
          );
        }
      }

      // No token check here: payAndCall runs free tools without an agent and
      // refuses paid ones with a message explaining how to get one. Gating at
      // this layer would make the free tier unreachable, which is the whole
      // reason a seller marks a tool free.
      const result = await payAndCall({
        agent,
        slug,
        args: callArgs ?? {},
        units,
        maxPrice,
        clientKey,
      });

      if (!result.ok) {
        return json(
          {
            ok: false,
            error: result.error?.code,
            message: result.error?.message,
            charged: result.refunded ? "refunded in full" : "nothing was charged",
            balance_atomic: result.balance?.toString() ?? null,
            quote_atomic: result.quote?.toString() ?? null,
          },
          true,
        );
      }

      return json({
        ok: true,
        free: result.free,
        service: result.serviceName,
        seller: result.sellerName,
        paid_atomic: result.paid,
        paid_display: result.paid ? `${formatAmount(result.paid)} ℏ` : null,
        units: result.units,
        truncated: result.truncated,
        balance_atomic: result.balance?.toString() ?? null,
        settlement: {
          transaction: result.transaction,
          explorer: result.explorerUrl,
          call_id: result.callId,
        },
        // The response body is returned as a string rather than parsed, so a
        // provider returning non-JSON is still delivered rather than mangled.
        response: result.body,
      });
    },
  );

  /* ----------------------------------------------- spending authority */

  const authority = define("get_spend_authority");
  server.registerTool(
    authority.name,
    {
      title: authority.title,
      description: authority.description,
      inputSchema: jsonSchemaStandard(authority.inputSchema),
      annotations: authority.annotations,
    },
    async () => {
      if (!agent) return needsToken();

      // Everything an agent needs to decide whether it can afford a call
      // before making one, rather than discovering a ceiling by being refused.
      const spent = await spentToday(agent.id);
      const bucket = bucketFor(agent, "");
      const free = await quotaStatus(bucket);

      return json({
        enforced_by: "marketplace",
        paid_calls: {
          per_call_atomic: agent.per_call_cap,
          per_day_atomic: agent.per_day_cap,
          balance_atomic: agent.balance,
          spent_today_atomic: spent.toString(),
        },
        // Free tools are limited too, and by a different thing entirely:
        // not money but how well we know the caller. Funding the agent does
        // not move this — money buys paid tools, not free ones.
        free_calls: {
          tier: free.kind,
          used: free.used,
          limit: free.limit,
          remaining: Math.max(free.limit - free.used, 0),
          resets: "midnight UTC",
        },
      });
    },
  );

  /* -------------------------------------------------------- balance */

  const balance = define("get_balance");
  server.registerTool(
    balance.name,
    {
      title: balance.title,
      description: balance.description,
      inputSchema: jsonSchemaStandard(balance.inputSchema),
      annotations: balance.annotations,
    },
    async () => {
      if (!agent) return needsToken();

      const spent = await spentToday(agent.id);
      return json({
        label: agent.label,
        balance_atomic: agent.balance,
        balance_display: `${formatAmount(agent.balance)} ℏ`,
        spent_today_atomic: spent.toString(),
        caps: {
          per_call_atomic: agent.per_call_cap,
          per_day_atomic: agent.per_day_cap,
        },
        fund_at: `${BASE_URL}/agent`,
      });
    },
  );
}

/* ------------------------------------------------- One seller's API server */

export function registerListingTools(
  server: McpServer,
  listings: ToolListing[],
  agent: AgentAccount | null,
  clientKey?: string,
): void {
  for (const listing of listings) {
    const tool = toolForListing(listing);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: jsonSchemaStandard(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args) => {
        const supplied = (args ?? {}) as Record<string, unknown>;

        // `units` is the marketplace's argument, not the seller's, so it is
        // lifted out before the rest is handed to the provider.
        const units =
          typeof supplied.units === "number" ? (supplied.units as number) : undefined;
        const rest = { ...supplied };
        delete rest.units;

        const result = await payAndCall({
          agent,
          slug: listing.slug,
          args: listing.upstream_kind === "openapi" ? rest : supplied,
          units,
          clientKey,
        });

        if (!result.ok) {
          return json(
            {
              ok: false,
              error: result.error?.code,
              message: result.error?.message,
              charged: result.refunded ? "refunded in full" : "nothing was charged",
              balance_atomic: result.balance?.toString() ?? null,
            },
            true,
          );
        }

        return json({
          ok: true,
          free: result.free,
          paid_atomic: result.paid,
          paid_display: result.paid ? `${formatAmount(result.paid)} ℏ` : null,
          balance_atomic: result.balance?.toString() ?? null,
          settlement: { transaction: result.transaction, explorer: result.explorerUrl },
          response: result.body,
        });
      },
    );
  }
}

/* ------------------------------------------------------------------ Quotes */

/** Price of a listing without calling it, for the catalogue surfaces. */
export function displayQuote(listing: ServiceListing, units?: number): string {
  const resolved = normalizeUnits(units, listing.price_unit);
  const quote = quoteFor(listing.price_amount, resolved);
  return `${formatAmount(quote, listing.asset_decimals)} ℏ`;
}
