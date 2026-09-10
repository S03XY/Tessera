import { describe, expect, it } from "vitest";
import {
  buildUpstreamRequest,
  marketplaceTools,
  priceSentence,
  sanitiseToolName,
  toolForListing,
  toolPayloadBytes,
  ToolArgumentError,
  type ToolListing,
} from "@/lib/mcp-tools";
import type { ToolOperation } from "@/lib/openapi";

/* ----------------------------------------------------------------- helpers */

function listing(overrides: Partial<ToolListing> = {}): ToolListing {
  return {
    slug: "gold-spot",
    name: "Gold Spot Price",
    description: "Live gold spot price in USD.",
    category: "markets",
    price_amount: "90000",
    price_unit: "per_call",
    asset_decimals: 8,
    tool_name: null,
    input_schema: null,
    mcp_operation: null,
    tool_annotations: null,
    endpoint_method: "GET",
    upstream_kind: "http",
    ...overrides,
  };
}

function operation(overrides: Partial<ToolOperation> = {}): ToolOperation {
  return {
    method: "get",
    pathTemplate: "/pets",
    parameters: [],
    bodyArgs: null,
    bodyRequired: false,
    contentType: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------- pricing */

describe("priceSentence", () => {
  it("states the price in whole units, not atomic ones", () => {
    expect(priceSentence(listing())).toBe(
      "Costs 0.0009 ℏ per call, charged only if the call succeeds.",
    );
  });

  it("names the metered unit", () => {
    expect(priceSentence(listing({ price_unit: "per_row", price_amount: "100" }))).toMatch(
      /per row/,
    );
    expect(priceSentence(listing({ price_unit: "per_token" }))).toMatch(/per token/);
  });
});

/* --------------------------------------------------------- tool definitions */

describe("toolForListing", () => {
  it("names a plain listing from its slug and appends the price", () => {
    const tool = toolForListing(listing());
    expect(tool.name).toBe("gold_spot");
    expect(tool.description).toBe(
      "Live gold spot price in USD. Costs 0.0009 ℏ per call, charged only if the call succeeds.",
    );
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it("gives a per-call GET listing no arguments at all", () => {
    const tool = toolForListing(listing());
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("offers a unit budget only for metered listings", () => {
    const metered = toolForListing(listing({ price_unit: "per_row" }));
    expect(Object.keys(metered.inputSchema.properties as object)).toEqual(["units"]);

    const flat = toolForListing(listing({ price_unit: "per_call" }));
    expect(Object.keys(flat.inputSchema.properties as object)).toEqual([]);
  });

  it("offers a body argument for a POST listing and marks it not read-only", () => {
    const tool = toolForListing(listing({ endpoint_method: "POST" }));
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["body"]);
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it("uses the shaped schema for an openapi-backed listing", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const tool = toolForListing(
      listing({
        upstream_kind: "openapi",
        tool_name: "search_docs",
        input_schema: schema,
        tool_annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }),
    );
    expect(tool.name).toBe("search_docs");
    expect(tool.inputSchema).toBe(schema);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it("falls back to safe annotations when a listing stores none", () => {
    const tool = toolForListing(
      listing({ upstream_kind: "openapi", tool_name: "t", input_schema: { type: "object" } }),
    );
    expect(tool.annotations?.destructiveHint).toBe(false);
  });
});

describe("sanitiseToolName", () => {
  it("produces a legal name from an arbitrary slug", () => {
    expect(sanitiseToolName("gold-spot")).toBe("gold_spot");
    expect(sanitiseToolName("ACME::Feed v2")).toBe("acme_feed_v2");
  });

  it("never starts with a digit and never returns empty", () => {
    expect(sanitiseToolName("2fa-check")).toBe("t_2fa_check");
    expect(sanitiseToolName("---")).toBe("service");
  });
});

/* ------------------------------------------------------- request building */

describe("buildUpstreamRequest — assembling a legitimate call", () => {
  it("builds a bare GET", () => {
    const request = buildUpstreamRequest("https://api.example.com", operation(), {});
    expect(request).toEqual({
      url: "https://api.example.com/pets",
      method: "GET",
      headers: {},
      body: null,
    });
  });

  it("substitutes a path parameter and preserves the base path prefix", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com/api/v3",
      operation({
        pathTemplate: "/pets/{petId}",
        parameters: [{ argName: "pet_id", name: "petId", in: "path", required: true }],
      }),
      { pet_id: "42" },
    );
    expect(request.url).toBe("https://api.example.com/api/v3/pets/42");
  });

  it("tolerates a trailing slash on the base URL", () => {
    const request = buildUpstreamRequest("https://api.example.com/v1/", operation(), {});
    expect(request.url).toBe("https://api.example.com/v1/pets");
  });

  it("appends query parameters under their upstream names", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        parameters: [
          { argName: "max_results", name: "maxResults", in: "query", required: false },
          { argName: "status", name: "status", in: "query", required: true },
        ],
      }),
      { max_results: 10, status: "available" },
    );
    const url = new URL(request.url);
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("status")).toBe("available");
  });

  it("repeats an array query parameter rather than joining it", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        parameters: [{ argName: "tags", name: "tags", in: "query", required: false }],
      }),
      { tags: ["a", "b"] },
    );
    expect(new URL(request.url).searchParams.getAll("tags")).toEqual(["a", "b"]);
  });

  it("omits an absent optional parameter instead of sending empty", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        parameters: [{ argName: "limit", name: "limit", in: "query", required: false }],
      }),
      {},
    );
    expect(request.url).toBe("https://api.example.com/pets");
  });

  it("sets a permitted header", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        parameters: [{ argName: "x_trace_id", name: "X-Trace-Id", in: "header", required: false }],
      }),
      { x_trace_id: "abc123" },
    );
    expect(request.headers).toEqual({ "X-Trace-Id": "abc123" });
  });

  it("assembles a flattened body and sets the content type", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        method: "post",
        bodyArgs: ["name", "tag"],
        bodyRequired: true,
        contentType: "application/json",
      }),
      { name: "Rex", tag: "dog" },
    );
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body as string)).toEqual({ name: "Rex", tag: "dog" });
    expect(request.headers["content-type"]).toBe("application/json");
  });

  it("sends a whole-body argument as the body itself", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({ method: "post", bodyArgs: ["body"], bodyRequired: true }),
      { body: { nested: { deep: true } } },
    );
    expect(JSON.parse(request.body as string)).toEqual({ nested: { deep: true } });
  });

  it("omits absent optional body fields", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({ method: "post", bodyArgs: ["name", "tag"], bodyRequired: true }),
      { name: "Rex" },
    );
    expect(JSON.parse(request.body as string)).toEqual({ name: "Rex" });
  });
});

describe("buildUpstreamRequest — refuses hostile arguments", () => {
  const withPath = operation({
    pathTemplate: "/pets/{petId}",
    parameters: [{ argName: "pet_id", name: "petId", in: "path", required: true }],
  });

  it("percent-encodes a traversal attempt rather than resolving it", () => {
    const request = buildUpstreamRequest("https://api.example.com/v1", withPath, {
      pet_id: "../../admin/keys",
    });
    expect(request.url).toBe("https://api.example.com/v1/pets/..%2F..%2Fadmin%2Fkeys");
    expect(request.url).not.toContain("/admin/keys");
  });

  it("cannot be redirected to another host through a path argument", () => {
    const request = buildUpstreamRequest("https://api.example.com", withPath, {
      pet_id: "https://evil.example/steal",
    });
    expect(new URL(request.url).origin).toBe("https://api.example.com");
  });

  it("cannot smuggle a query string through a path argument", () => {
    const request = buildUpstreamRequest("https://api.example.com", withPath, {
      pet_id: "1?admin=true",
    });
    expect(new URL(request.url).searchParams.get("admin")).toBeNull();
  });

  it("cannot smuggle a fragment through a path argument", () => {
    const request = buildUpstreamRequest("https://api.example.com", withPath, {
      pet_id: "1#fragment",
    });
    expect(new URL(request.url).hash).toBe("");
  });

  it("refuses a missing required path argument", () => {
    expect(() => buildUpstreamRequest("https://api.example.com", withPath, {})).toThrow(
      ToolArgumentError,
    );
    expect(() => buildUpstreamRequest("https://api.example.com", withPath, {})).toThrow(
      /Missing required path argument/,
    );
  });

  it("refuses an empty string for a required path argument", () => {
    expect(() =>
      buildUpstreamRequest("https://api.example.com", withPath, { pet_id: "" }),
    ).toThrow(/Missing required path argument/);
  });

  it("refuses a missing required query argument", () => {
    expect(() =>
      buildUpstreamRequest(
        "https://api.example.com",
        operation({
          parameters: [{ argName: "status", name: "status", in: "query", required: true }],
        }),
        {},
      ),
    ).toThrow(/Missing required argument “status”/);
  });

  it("refuses a template slot that was never bound", () => {
    expect(() =>
      buildUpstreamRequest(
        "https://api.example.com",
        operation({ pathTemplate: "/pets/{petId}" }),
        {},
      ),
    ).toThrow(/was never supplied/);
  });

  it("refuses a binding whose template slot does not exist", () => {
    expect(() =>
      buildUpstreamRequest(
        "https://api.example.com",
        operation({
          pathTemplate: "/pets",
          parameters: [{ argName: "pet_id", name: "petId", in: "path", required: true }],
        }),
        { pet_id: "1" },
      ),
    ).toThrow(/does not use it/);
  });

  it("refuses header injection through CR or LF", () => {
    const op = operation({
      parameters: [{ argName: "trace", name: "X-Trace", in: "header", required: false }],
    });
    expect(() =>
      buildUpstreamRequest("https://api.example.com", op, {
        trace: "ok\r\nX-Admin: true",
      }),
    ).toThrow(/may not contain a line break/);
    expect(() =>
      buildUpstreamRequest("https://api.example.com", op, { trace: "ok\nInjected: 1" }),
    ).toThrow(ToolArgumentError);
  });

  it("silently drops a header the marketplace owns, even if the operation names one", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com",
      operation({
        parameters: [
          { argName: "auth", name: "Authorization", in: "header", required: false },
          { argName: "pay", name: "X-Payment", in: "header", required: false },
          { argName: "ok", name: "X-Ok", in: "header", required: false },
        ],
      }),
      { auth: "Bearer stolen", pay: "forged", ok: "yes" },
    );
    expect(request.headers).toEqual({ "X-Ok": "yes" });
  });

  it("refuses an unusable base URL", () => {
    expect(() => buildUpstreamRequest("not a url", operation(), {})).toThrow(
      /unusable base URL/,
    );
    // A relative server URL from a spec is exactly this case.
    expect(() => buildUpstreamRequest("/api/v3", operation(), {})).toThrow(ToolArgumentError);
  });

  it("keeps a query argument from overwriting the path", () => {
    const request = buildUpstreamRequest(
      "https://api.example.com/base",
      operation({
        pathTemplate: "/x",
        parameters: [{ argName: "q", name: "q", in: "query", required: false }],
      }),
      { q: "../../etc/passwd" },
    );
    expect(new URL(request.url).pathname).toBe("/base/x");
  });
});

/* ---------------------------------------------------------- meta-tools */

describe("marketplaceTools", () => {
  const tools = marketplaceTools();

  it("exposes discovery, inspection, purchase, authority and balance", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "search_services",
      "describe_service",
      "call_service",
      "get_spend_authority",
      "get_balance",
    ]);
  });

  it("marks only the spending tool as not read-only", () => {
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writes.map((t) => t.name)).toEqual(["call_service"]);
  });

  it("requires a query to search and a slug to call", () => {
    expect((tools[0].inputSchema as { required: string[] }).required).toEqual(["query"]);
    expect((tools[2].inputSchema as { required: string[] }).required).toEqual(["slug"]);
  });

  it("closes every meta-tool to unknown arguments", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("stays small enough to sit in every agent's context", () => {
    // The whole point of the marketplace endpoint is that it costs a fixed,
    // small amount of context no matter how large the catalogue grows.
    expect(toolPayloadBytes(tools)).toBeLessThan(6000);
  });
});
