import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as marketplacePost } from "@/app/mcp/route";
import { POST as serverPost } from "@/app/mcp/[slug]/route";
import { query, queryOne } from "@/lib/db";
import { creditDeposit, registerAgent } from "@/lib/wallet";

/**
 * Protocol conformance for the two MCP endpoints.
 *
 * The route handlers are plain `(Request) => Response` functions, so they can
 * be driven directly rather than through a live server. That keeps these tests
 * fast and hermetic; the paid path they front is covered in mcp-pay.test.ts,
 * and the whole stack end to end in the browser run.
 */

const agentIds: string[] = [];
let token: string;
let sellerId: string;
let mcpServerId: string;
const serverSlug = `mcp-endpoint-test-${Date.now()}`;
const toolSlug = `mcp-endpoint-tool-${Date.now()}`;
const freeSlug = `mcp-endpoint-free-${Date.now()}`;

/* ------------------------------------------------------------- MCP client */

interface RpcResult {
  status: number;
  message: Record<string, unknown> | null;
  raw: string;
}

/**
 * Reads a Streamable HTTP response.
 *
 * The handler answers with an SSE frame even for a single reply, so the JSON-RPC
 * message has to be lifted out of `data:` lines rather than parsed directly.
 */
function parseSse(body: string): Record<string, unknown> | null {
  const line = body
    .split("\n")
    .find((entry) => entry.startsWith("data:"));
  if (!line) {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function rpc(
  handler: (req: Request, ctx: never) => Promise<Response>,
  body: unknown,
  options: { token?: string; url?: string; params?: Record<string, string> } = {},
): Promise<RpcResult> {
  const request = new Request(options.url ?? "http://localhost:3000/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const context = options.params
    ? ({ params: Promise.resolve(options.params) } as never)
    : (undefined as never);

  const response = await handler(request, context);
  const raw = await response.text();
  return { status: response.status, message: parseSse(raw), raw };
}

const market = (body: unknown, options?: { token?: string }) =>
  rpc(marketplacePost as never, body, options);

let nextId = 1;
const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: nextId++,
  method: "tools/call",
  params: { name, arguments: args },
});

/** Extracts the text payload of a tool result. */
function resultText(message: Record<string, unknown> | null): string {
  const result = message?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

function isToolError(message: Record<string, unknown> | null): boolean {
  return ((message?.result as { isError?: boolean } | undefined)?.isError ?? false) === true;
}

/* ----------------------------------------------------------------- setup */

beforeAll(async () => {
  const registered = await registerAgent({
    label: "__mcp_endpoint_test__",
    ownerAccount: "0.0.555555",
    agentAccount: "0.0.666666",
    perCallCap: 5_000n,
  });
  agentIds.push(registered.agent.id);
  token = registered.token;
  await creditDeposit({
    agentId: registered.agent.id,
    amount: 250_000n,
    tx: `mcp-endpoint-${registered.agent.id}`,
  });

  const seller = await queryOne<{ id: string }>(
    `SELECT id FROM sellers
      WHERE verification_status = 'verified'
      -- Best funded first, with a deterministic tiebreak.
      --
      -- The seed writes every seller in one transaction, so they share a
      -- single created_at and \`ORDER BY created_at LIMIT 1\` picks an
      -- arbitrary one of the five. One of those five is deliberately
      -- underfunded so the gateway can be seen refusing it — and drawing that
      -- seller makes a paid fixture fail with \`quote_failed\` a fifth of the
      -- time, for a reason nowhere near the thing under test.
      ORDER BY deposit_amount DESC, account_id
      LIMIT 1`,
  );
  if (!seller) throw new Error("No verified seller. Run `npm run db:reset` first.");
  sellerId = seller.id;

  const published = await queryOne<{ id: string }>(
    `INSERT INTO mcp_servers (seller_id, slug, name, description, base_url, status, tool_count)
     VALUES ($1,$2,'Endpoint Test API','A fixture API.','https://api.example.com','active',1)
     RETURNING id`,
    [sellerId, serverSlug],
  );
  mcpServerId = published!.id;

  await query(
    `INSERT INTO services
       (seller_id, slug, name, description, category, endpoint_url, price_amount,
        price_unit, status, upstream_kind, mcp_server_id, tool_name, input_schema,
        mcp_operation, tool_annotations)
     VALUES ($1,$2,'Get Widget','Fetches one widget.','test','https://api.example.com',
             1200,'per_call','active','openapi',$3,'get_widget',$4,$5,$6)`,
    [
      sellerId,
      toolSlug,
      mcpServerId,
      JSON.stringify({
        type: "object",
        properties: { widget_id: { type: "string", description: "Which widget." } },
        required: ["widget_id"],
        additionalProperties: false,
      }),
      JSON.stringify({
        method: "get",
        pathTemplate: "/widgets/{widgetId}",
        parameters: [
          { argName: "widget_id", name: "widgetId", in: "path", required: true },
        ],
        bodyArgs: null,
        bodyRequired: false,
        contentType: null,
      }),
      JSON.stringify({ readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
    ],
  );

  // A free tool on the same server: the mixed free/paid case is the shape the
  // marketplace exists to support, so it belongs in the fixture.
  await query(
    `INSERT INTO services
       (seller_id, slug, name, description, category, endpoint_url, price_amount,
        price_unit, status, upstream_kind, mcp_server_id, tool_name, input_schema,
        mcp_operation, tool_annotations)
     VALUES ($1,$2,'Free Ping','Checks the service is alive.','test','https://api.example.com',
             0,'per_call','active','openapi',$3,'free_ping',$4,$5,$6)`,
    [
      sellerId,
      freeSlug,
      mcpServerId,
      JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
      JSON.stringify({
        method: "get",
        pathTemplate: "/ping",
        parameters: [],
        bodyArgs: null,
        bodyRequired: false,
        contentType: null,
      }),
      JSON.stringify({ readOnlyHint: true, destructiveHint: false, idempotentHint: true }),
    ],
  );
});

afterAll(async () => {
  if (agentIds.length) await query(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [agentIds]);
  await query(`DELETE FROM services WHERE slug = ANY($1::text[])`, [[toolSlug, freeSlug]]);
  await query(`DELETE FROM mcp_servers WHERE slug = $1`, [serverSlug]);
});

/* ------------------------------------------------------------- handshake */

describe("the marketplace endpoint speaks MCP", () => {
  it("answers initialize with its identity and capabilities", async () => {
    const { status, message } = await market({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1" },
      },
    });

    expect(status).toBe(200);
    const result = message?.result as {
      serverInfo: { name: string };
      capabilities: { tools?: unknown };
      protocolVersion: string;
      instructions: string;
    };
    expect(result.serverInfo.name).toBe("tessera-marketplace");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.instructions).toMatch(/charged only when a provider delivers/i);
  });

  it("lists exactly the marketplace tools, in a stable order", async () => {
    const { message } = await market({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (message?.result as { tools: Array<{ name: string }> }).tools;

    expect(tools.map((t) => t.name)).toEqual([
      "search_services",
      "describe_service",
      "call_service",
      "get_spend_authority",
      "get_balance",
    ]);
  });

  it("reports both limits: the paid caps and the free-tool allowance", async () => {
    const { message } = await market(call("get_spend_authority"), { token });
    const payload = JSON.parse(resultText(message)) as {
      enforced_by: string;
      paid_calls: { per_call_atomic: string } | null;
      free_calls: { tier: string; limit: number; remaining: number };
    };
    expect(payload.enforced_by).toMatch(/marketplace/);
    expect(payload.paid_calls?.per_call_atomic).toBe("5000");
    // The free allowance is a separate currency: proof of a person, not money.
    expect(["anonymous", "agent", "human"]).toContain(payload.free_calls.tier);
    expect(payload.free_calls.limit).toBeGreaterThan(0);
  });

  it("advertises the shaped JSON Schema unchanged", async () => {
    const { message } = await market({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const tools = (message?.result as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    }).tools;

    const search = tools.find((t) => t.name === "search_services");
    expect(search?.inputSchema.required).toEqual(["query"]);
    expect(search?.inputSchema.additionalProperties).toBe(false);
  });

  it("keeps the catalogue's context cost fixed and small", async () => {
    const { message } = await market({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const tools = (message?.result as { tools: unknown[] }).tools;
    // Four tools regardless of catalogue size is the design claim; assert the
    // byte cost too, since that is what actually constrains a client.
    expect(JSON.stringify(tools).length).toBeLessThan(8000);
  });

  it("rejects an unknown method with a JSON-RPC error", async () => {
    const { message } = await market({ jsonrpc: "2.0", id: 5, method: "nonsense/method", params: {} });
    expect(message?.error).toBeDefined();
  });

  it("rejects a call to a tool that does not exist", async () => {
    const { message } = await market(call("no_such_tool"));
    expect(message?.error ?? isToolError(message)).toBeTruthy();
  });
});

/* ------------------------------------------------------- free tools work */

describe("discovery is free and needs no token", () => {
  it("searches the catalogue anonymously", async () => {
    const { message } = await market(call("search_services", { query: "forex" }));
    expect(isToolError(message)).toBe(false);

    const payload = JSON.parse(resultText(message)) as {
      matches: number;
      results: Array<{ slug: string; price: { display: string } }>;
    };
    expect(payload.matches).toBeGreaterThan(0);
    expect(payload.results[0].price.display).toMatch(/ℏ per/);
  });

  it("never leaks the seller's endpoint URL", async () => {
    const { message } = await market(call("search_services", { query: "forex" }));
    const raw = resultText(message);
    expect(raw).not.toMatch(/endpoint_url/);
    expect(raw).not.toMatch(/https?:\/\/(?!hashscan)/);
  });

  it("says so plainly when nothing matches", async () => {
    const { message } = await market(
      call("search_services", { query: "zzzz-nothing-matches-this-zzzz" }),
    );
    expect(resultText(message)).toMatch(/Nothing in the catalogue matches/);
  });

  it("describes a listing with its price and arguments", async () => {
    const { message } = await market(call("describe_service", { slug: toolSlug }));
    const payload = JSON.parse(resultText(message)) as {
      slug: string;
      arguments: { required?: string[] };
      direct_url: string;
    };
    expect(payload.slug).toBe(toolSlug);
    expect(payload.arguments.required).toEqual(["widget_id"]);
    expect(payload.direct_url).toContain(`/x402/${toolSlug}`);
  });

  it("refuses to describe a listing that does not exist", async () => {
    const { message } = await market(call("describe_service", { slug: "no-such-slug" }));
    expect(isToolError(message)).toBe(true);
    expect(resultText(message)).toMatch(/No listing is published/);
  });
});

/* ------------------------------------------------------- schema validation */

describe("arguments are validated against the advertised schema", () => {
  it("refuses a search with no query", async () => {
    const { message } = await market(call("search_services", {}));
    expect(message?.error ?? isToolError(message)).toBeTruthy();
  });

  it("refuses an argument the schema does not declare", async () => {
    const { message } = await market(
      call("search_services", { query: "forex", not_a_real_argument: true }),
    );
    expect(message?.error ?? isToolError(message)).toBeTruthy();
  });

  it("coerces a stringified number rather than failing the call", async () => {
    // A model sending "5" for an integer has made a formatting slip; failing
    // the call over it would waste a turn and teach the model nothing.
    const { message } = await market(
      call("search_services", { query: "forex", limit: "5" as unknown as number }),
    );
    expect(isToolError(message)).toBe(false);
  });
});

/* ------------------------------------------------------------------- auth */

describe("spending requires a token", () => {
  it("tells an anonymous caller how to get one instead of dropping the connection", async () => {
    const { status, message } = await market(call("get_balance"));
    expect(status).toBe(200);
    expect(isToolError(message)).toBe(true);
    expect(resultText(message)).toMatch(/needs a funded agent token/);
    expect(resultText(message)).toMatch(/Authorization: Bearer/);
  });

  it("refuses an anonymous call to a PAID tool, and says how to fix it", async () => {
    // The fixture tool costs 1200 tinybars, so this is the paid path.
    const { message } = await market(call("call_service", { slug: toolSlug }));
    expect(isToolError(message)).toBe(true);
    const payload = JSON.parse(resultText(message)) as { error: string; message: string };
    expect(payload.error).toBe("insufficient_balance");
    expect(payload.message).toMatch(/free tools on this server need no token/);
  });

  it("treats a bogus token as anonymous rather than erroring the transport", async () => {
    const { status, message } = await market(call("get_balance"), {
      token: "tsa_not_a_real_token_at_all",
    });
    expect(status).toBe(200);
    expect(resultText(message)).toMatch(/needs a funded agent token/);
  });

  it("reports the balance and caps for a valid token", async () => {
    const { message } = await market(call("get_balance"), { token });
    expect(isToolError(message)).toBe(false);

    const payload = JSON.parse(resultText(message)) as {
      balance_atomic: string;
      caps: { per_call_atomic: string };
    };
    expect(payload.balance_atomic).toBe("250000");
    expect(payload.caps.per_call_atomic).toBe("5000");
  });

  it("refuses a spend above the per-call cap without contacting the seller", async () => {
    // The fixture is priced at 1200 with a 5000 cap, so raise the stakes by
    // asking for a max_price the caller itself will not honour.
    const { message } = await market(
      call("call_service", { slug: toolSlug, max_price: "1" }),
      { token },
    );
    expect(isToolError(message)).toBe(true);
    const payload = JSON.parse(resultText(message)) as { error: string };
    expect(payload.error).toBe("price_above_max");
  });

  it("refuses a malformed max_price", async () => {
    const { message } = await market(
      call("call_service", { slug: toolSlug, max_price: "not-a-number" }),
      { token },
    );
    expect(isToolError(message)).toBe(true);
    expect(resultText(message)).toMatch(/must be an integer number of tinybars/);
  });
});

/* --------------------------------------------------- the per-server endpoint */

describe("a seller's own MCP server", () => {
  const forSlug = (body: unknown, options: { token?: string } = {}) =>
    rpc(serverPost as never, body, {
      ...options,
      url: `http://localhost:3000/mcp/${serverSlug}`,
      params: { slug: serverSlug },
    });

  it("publishes the seller's tools under their own names", async () => {
    const { message } = await forSlug({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const tools = (message?.result as {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    }).tools;

    expect(tools.map((t) => t.name).sort()).toEqual(["free_ping", "get_widget"]);
    expect(tools.find((t) => t.name === "get_widget")!.inputSchema.required).toEqual(["widget_id"]);
  });

  it("states the price in the tool description, where the model will read it", async () => {
    const { message } = await forSlug({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (message?.result as { tools: Array<{ name: string; description: string }> }).tools;
    const widget = tools.find((t) => t.name === "get_widget");
    expect(widget!.description).toMatch(/Costs 0\.000012 ℏ per call/);
  });

  it("identifies itself as the seller's server, not the marketplace", async () => {
    const { message } = await forSlug({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "v", version: "1" } },
    });
    const result = message?.result as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe(`tessera-${serverSlug}`);
  });

  it("404s for a server that is not published", async () => {
    const response = await rpc(serverPost as never, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      url: "http://localhost:3000/mcp/no-such-server",
      params: { slug: "no-such-server" },
    });
    expect(response.status).toBe(404);
    expect(response.raw).toMatch(/unknown_server/);
  });

  it("404s for a suspended server rather than serving its tools", async () => {
    await query(`UPDATE mcp_servers SET status = 'suspended' WHERE slug = $1`, [serverSlug]);
    const response = await forSlug({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(response.status).toBe(404);
    await query(`UPDATE mcp_servers SET status = 'active' WHERE slug = $1`, [serverSlug]);
  });

  it("still refuses a paid tool without a token", async () => {
    const { message } = await forSlug(call("get_widget", { widget_id: "1" }));
    expect(isToolError(message)).toBe(true);
    const payload = JSON.parse(resultText(message)) as { error: string };
    expect(payload.error).toBe("insufficient_balance");
  });

  it("prices a free tool as free in the description the model reads", async () => {
    const { message } = await forSlug({
      jsonrpc: "2.0",
      id: 90,
      method: "tools/list",
      params: {},
    });
    const tools = (message?.result as { tools: Array<{ name: string; description: string }> }).tools;
    const free = tools.find((t) => t.name === "free_ping");
    expect(free?.description).toMatch(/Free — no payment and no account needed/);
    // And the paid one still states its price.
    const paid = tools.find((t) => t.name === "get_widget");
    expect(paid?.description).toMatch(/Costs 0\.000012 ℏ per call/);
  });

  it("validates the seller's own schema", async () => {
    const { message } = await forSlug(call("get_widget", {}), { token });
    expect(message?.error ?? isToolError(message)).toBeTruthy();
  });
});
