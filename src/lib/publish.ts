import { query, transaction } from "@/lib/db";
import { assertPublicUrl, fetchUpstream, UnsafeUrlError } from "@/lib/ssrf";
import { sha256Hex } from "@/lib/hash";
import { MCP_MAX_TOOLS } from "@/lib/config";
import {
  parseSpec,
  shapeTools,
  SpecError,
  type DroppedOperation,
  type ParsedSpec,
  type ShapedTool,
} from "@/lib/openapi";
import { toolPayloadBytes, type McpToolDefinition } from "@/lib/mcp-tools";
import type { PriceUnit } from "@/lib/money";

/**
 * Turning a seller's API into a published MCP server.
 *
 * The seller hands over a specification and a price. Everything after that —
 * fetching the document, shaping it into tools an agent can choose between,
 * pricing each one, and putting it behind the payment gateway — happens here,
 * and none of it requires the seller to write, host, or understand a line of
 * MCP.
 *
 * The step worth calling out is `resolveBaseUrl`. OpenAPI's `servers[].url` is
 * allowed to be relative — the Swagger Petstore's is literally `/api/v3` —
 * which is meaningless without knowing where the document was fetched from.
 * Getting this wrong does not fail loudly; it produces a server whose tools
 * all resolve against the wrong host, so it is resolved explicitly and tested.
 */

/* ------------------------------------------------------------------- Types */

export class PublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishPlan {
  title: string;
  description: string;
  version: string;
  openapi: string;
  baseUrl: string;
  specHash: string;
  tools: ShapedTool[];
  dropped: DroppedOperation[];
  truncated: number;
  /** Context cost of the catalogue as an agent will receive it. */
  payloadBytes: number;
}

export interface PlanOptions {
  /** Where the document was fetched from, for resolving a relative server URL. */
  specUrl?: string | null;
  /** Overrides the spec's own server URL entirely. */
  baseUrl?: string | null;
  maxTools?: number;
  includeTags?: string[];
  only?: string[];
}

/* ---------------------------------------------------------------- Base URL */

/**
 * Resolves the URL tools will actually be called against.
 *
 * Precedence: an explicit override, then the spec's own server, then the host
 * the spec was fetched from. A relative server URL is resolved against the
 * spec URL, which is the only thing that gives it meaning.
 */
export function resolveBaseUrl(options: {
  override?: string | null;
  serverUrl?: string | null;
  specUrl?: string | null;
}): string {
  const { override, serverUrl, specUrl } = options;

  const absolute = (value: string): string | null => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };

  if (override && override.trim()) {
    const resolved = absolute(override.trim());
    if (!resolved) {
      throw new PublishError("invalid_base_url", `“${override}” is not an absolute http(s) URL.`);
    }
    return stripTrailingSlash(resolved);
  }

  if (serverUrl && serverUrl.trim()) {
    const direct = absolute(serverUrl.trim());
    if (direct) return stripTrailingSlash(direct);

    // Relative, e.g. "/api/v3". Only the spec's own location can resolve it.
    if (specUrl) {
      try {
        return stripTrailingSlash(new URL(serverUrl.trim(), specUrl).toString());
      } catch {
        // fall through to the spec URL's origin below
      }
    }
  }

  if (specUrl) {
    try {
      const url = new URL(specUrl);
      return stripTrailingSlash(url.origin);
    } catch {
      // fall through
    }
  }

  throw new PublishError(
    "no_base_url",
    "The specification declares no absolute server URL. Supply one explicitly.",
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "") || value;
}

/* -------------------------------------------------------------- Fetching */

export const MAX_SPEC_BYTES = 4_000_000;

/**
 * Downloads a specification.
 *
 * Goes through the same SSRF guard as a paid call, because "fetch this URL for
 * me" is exactly the capability an attacker wants — and here it is offered to
 * anyone who can reach the publish endpoint.
 */
export async function fetchSpec(specUrl: string): Promise<string> {
  let url: URL;
  try {
    url = await assertPublicUrl(specUrl);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new PublishError("unsafe_spec_url", `That URL cannot be fetched: ${err.message}`);
    }
    throw err;
  }

  /**
   * Retried, unlike a paid call.
   *
   * The first TCP connection to an unfamiliar host fails often enough to
   * matter — happy-eyeballs races an unreachable AAAA record and gives up
   * before the A record answers — and losing a seller's publish to that is
   * indefensible when the fetch is idempotent and unpaid.
   *
   * The delivery path deliberately does not do this. Retrying there could
   * settle twice for one quote, so it fails and refunds instead.
   */
  let response;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetchUpstream(url, { method: "GET" });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  if (!response) {
    const cause = (lastError as { cause?: { code?: string } })?.cause?.code;
    throw new PublishError(
      "spec_unreachable",
      `Could not fetch the specification after 3 attempts: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}` +
        `${cause ? ` (${cause})` : ""}`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new PublishError(
      "spec_unreachable",
      `The specification URL returned HTTP ${response.status}.`,
    );
  }

  if (response.body.length > MAX_SPEC_BYTES) {
    throw new PublishError("spec_too_large", "That specification is too large to import.");
  }

  return response.body;
}

/* ------------------------------------------------------------------ Plan */

/**
 * Shapes a specification into a publishable plan without writing anything.
 *
 * Separate from publishing so a seller can see the tools — and what was
 * dropped — before committing. A seller who discovers after publishing that
 * twelve operations silently vanished has been failed by the tool.
 */
export function planFromSpec(specText: string, options: PlanOptions = {}): PublishPlan {
  let parsed: ParsedSpec;
  try {
    parsed = parseSpec(specText);
  } catch (err) {
    if (err instanceof SpecError) throw new PublishError("invalid_spec", err.message);
    throw err;
  }

  const baseUrl = resolveBaseUrl({
    override: options.baseUrl,
    serverUrl: parsed.info.serverUrl,
    specUrl: options.specUrl,
  });

  const shaped = shapeTools(parsed, {
    maxTools: options.maxTools ?? MCP_MAX_TOOLS,
    includeTags: options.includeTags,
    only: options.only,
  });

  if (shaped.tools.length === 0) {
    throw new PublishError(
      "no_tools",
      "No usable operations were found in that specification. Every operation was " +
        "deprecated, filtered out, or could not be shaped.",
    );
  }

  const preview: McpToolDefinition[] = shaped.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));

  return {
    title: parsed.info.title,
    description: parsed.info.description,
    version: parsed.info.version,
    openapi: parsed.info.openapi,
    baseUrl,
    specHash: sha256Hex(specText),
    tools: shaped.tools,
    dropped: shaped.dropped,
    truncated: shaped.truncated,
    payloadBytes: toolPayloadBytes(preview),
  };
}

/* --------------------------------------------------------------- Publish */

export interface PublishInput {
  sellerId: string;
  slug: string;
  name: string;
  description: string;
  plan: PublishPlan;
  specUrl?: string | null;

  /** Price applied to every tool, in atomic units. Zero means free. */
  price: string;
  priceUnit: PriceUnit;
  /** Per-tool overrides, keyed by tool name. "0" makes that tool free. */
  priceOverrides?: Record<string, string>;
  /**
   * Tools to publish free regardless of the default price.
   *
   * Sugar over `priceOverrides`, because "these three are free" is how a
   * seller actually thinks about it — and the mixed server, where looking is
   * free and doing costs, is the shape the marketplace exists to support.
   */
  freeTools?: string[];
  category?: string;

  auth?: {
    mode: "none" | "bearer" | "api_key_header" | "api_key_query";
    /** Name of the environment variable holding the secret. Never the secret. */
    ref?: string | null;
    param?: string | null;
  };

  /** Publish immediately, or leave in draft for the seller to review. */
  activate?: boolean;
}

export interface PublishResult {
  serverId: string;
  slug: string;
  toolCount: number;
  freeCount: number;
  url: string;
  tools: Array<{ name: string; slug: string; price: string; free: boolean }>;
}

/**
 * Writes the server and its tools.
 *
 * One transaction: a half-published server whose tools resolve to nothing is
 * worse than a failed publish, because an agent can connect to it.
 */
export async function publishServer(input: PublishInput, baseUrl: string): Promise<PublishResult> {
  const slug = normaliseSlug(input.slug);
  if (!slug) throw new PublishError("invalid_slug", "The server needs a URL-safe name.");

  const status = input.activate === false ? "draft" : "active";
  const category = (input.category ?? "api").trim() || "api";

  const existing = await query<{ id: string }>(`SELECT id FROM mcp_servers WHERE slug = $1`, [
    slug,
  ]);
  if (existing.length > 0) {
    throw new PublishError("slug_taken", `An MCP server is already published at “${slug}”.`);
  }

  const result = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO mcp_servers
         (seller_id, slug, name, description, spec_url, spec_hash, spec_version,
          base_url, auth_mode, auth_ref, auth_param, status, tool_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        input.sellerId,
        slug,
        input.name,
        input.description,
        input.specUrl ?? null,
        input.plan.specHash,
        input.plan.version,
        input.plan.baseUrl,
        input.auth?.mode ?? "none",
        input.auth?.ref ?? null,
        input.auth?.param ?? null,
        status,
        input.plan.tools.length,
      ],
    );

    const serverId = inserted.rows[0].id;
    const tools: PublishResult["tools"] = [];

    const free = new Set(input.freeTools ?? []);

    for (const tool of input.plan.tools) {
      const price = free.has(tool.name)
        ? "0"
        : (input.priceOverrides?.[tool.name] ?? input.price);
      // Zero is allowed and meaningful: it publishes the tool free. Negative
      // and non-numeric are still refused.
      if (!/^\d+$/.test(price)) {
        throw new PublishError(
          "invalid_price",
          `Price for “${tool.name}” must be a whole number of tinybars, or 0 for free.`,
        );
      }

      const toolSlug = `${slug}-${tool.name}`.replace(/_/g, "-").slice(0, 80);

      await client.query(
        `INSERT INTO services
           (seller_id, slug, name, description, category, endpoint_url, endpoint_method,
            price_amount, price_unit, status, upstream_kind, mcp_server_id, tool_name,
            input_schema, mcp_operation, tool_annotations, keywords)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'openapi',$11,$12,$13,$14,$15,$16)`,
        [
          input.sellerId,
          toolSlug,
          tool.title,
          tool.description,
          category,
          // Display only: the executor builds the real URL from the operation.
          `${input.plan.baseUrl}${tool.operation.pathTemplate}`,
          tool.operation.method.toUpperCase() === "GET" ? "GET" : "POST",
          price,
          input.priceUnit,
          status,
          serverId,
          tool.name,
          JSON.stringify(tool.inputSchema),
          JSON.stringify(tool.operation),
          JSON.stringify(tool.annotations),
          keywordsFor(tool),
        ],
      );

      tools.push({ name: tool.name, slug: toolSlug, price, free: price === "0" });
    }

    return { serverId, tools };
  });

  return {
    serverId: result.serverId,
    slug,
    toolCount: result.tools.length,
    freeCount: result.tools.filter((t) => t.free).length,
    url: `${baseUrl}/mcp/${slug}`,
    tools: result.tools,
  };
}

/**
 * Search terms for a tool.
 *
 * An agent searching the marketplace asks in its own words, so the tool's tags
 * and the words of its name are both worth indexing — `get_forecast` should be
 * findable by "forecast" without the seller thinking to add the keyword.
 */
function keywordsFor(tool: ShapedTool): string[] {
  const words = tool.name.split("_").filter((word) => word.length > 2);
  return [...new Set([...tool.source.tags, ...words])].slice(0, 12);
}

export function normaliseSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
