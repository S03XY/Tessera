import type { JsonSchema, ToolOperation, ToolAnnotations } from "@/lib/openapi";
import { formatAmount, PRICE_UNIT_LABEL, type PriceUnit } from "@/lib/money";

/**
 * Marketplace listings, expressed as MCP tools.
 *
 * Two things happen here and it is worth keeping them apart.
 *
 * `buildUpstreamRequest` is the security boundary: it turns arguments a model
 * invented into exactly one HTTP request. Every value it interpolates is
 * attacker-influenced — a model can be talked into passing anything — so the
 * function assumes hostility and encodes accordingly. `lib/ssrf.ts` still
 * checks the host afterwards; this stops a *well-hosted* URL from being bent
 * into a different path, method or header than the listing declared.
 *
 * The rest is presentation: what the agent reads when deciding whether to
 * spend money. Price belongs in the description rather than in a separate
 * catalogue call, because a tool the model can see but cannot price is one it
 * will either avoid entirely or call without regard to cost.
 */

/* ------------------------------------------------------------------- Types */

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations & { title?: string };
}

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/** The listing fields the MCP layer needs. A subset of ServiceListing. */
export interface ToolListing {
  slug: string;
  name: string;
  description: string;
  category: string;
  price_amount: string;
  price_unit: PriceUnit;
  asset_decimals: number;
  tool_name: string | null;
  input_schema: JsonSchema | null;
  mcp_operation: ToolOperation | null;
  tool_annotations: ToolAnnotations | null;
  endpoint_method: "GET" | "POST";
  upstream_kind: "http" | "graph_subgraph" | "openapi";
  seller_name?: string;
  success_rate?: number | null;
}

/* --------------------------------------------------------------- Pricing */

/**
 * The price sentence appended to every tool description.
 *
 * Stated in whole ℏ rather than tinybars: a model comparing `90000` against
 * `120000` is comparing integers it has no scale for, and will not reliably
 * notice that one is 33% dearer.
 */
export function isFreeTool(listing: Pick<ToolListing, "price_amount">): boolean {
  try {
    return BigInt(listing.price_amount) === 0n;
  } catch {
    return false;
  }
}

export function priceSentence(listing: ToolListing): string {
  // Free is stated first and plainly. A model deciding between tools should
  // never have to infer that "0.0000 ℏ" means it can just call the thing.
  if (isFreeTool(listing)) {
    return "Free — no payment and no account needed.";
  }
  const amount = formatAmount(listing.price_amount, listing.asset_decimals);
  const unit = PRICE_UNIT_LABEL[listing.price_unit];
  return `Costs ${amount} ℏ per ${unit}, charged only if the call succeeds.`;
}

/* ------------------------------------------------------- Tool definitions */

/**
 * Builds the tool an agent sees for one listing.
 *
 * An openapi-backed listing already carries a shaped schema. Anything else —
 * a plain HTTP listing, a subgraph query — has no arguments beyond the unit
 * budget, so it gets a schema saying exactly that rather than an empty object
 * the model has to guess about.
 */
export function toolForListing(listing: ToolListing): McpToolDefinition {
  const name = listing.tool_name ?? sanitiseToolName(listing.slug);
  const description = [listing.description.trim(), priceSentence(listing)]
    .filter(Boolean)
    .join(" ");

  if (listing.upstream_kind === "openapi" && listing.input_schema) {
    return {
      name,
      title: listing.name,
      description,
      inputSchema: listing.input_schema,
      annotations: {
        ...(listing.tool_annotations ?? {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        }),
        title: listing.name,
      },
    };
  }

  const properties: Record<string, JsonSchema> = {};

  if (listing.price_unit !== "per_call") {
    properties.units = {
      type: "integer",
      minimum: 1,
      description:
        `How many ${PRICE_UNIT_LABEL[listing.price_unit]}s to pay for. The response is ` +
        `held to this budget, so asking for fewer costs less.`,
    };
  }

  if (listing.endpoint_method === "POST") {
    properties.body = {
      type: "object",
      description: "JSON body forwarded to the provider.",
      additionalProperties: true,
    };
  }

  return {
    name,
    title: listing.name,
    description,
    inputSchema: { type: "object", properties, additionalProperties: false },
    annotations: {
      readOnlyHint: listing.endpoint_method === "GET",
      destructiveHint: false,
      idempotentHint: listing.endpoint_method === "GET",
      title: listing.name,
    },
  };
}

/* ------------------------------------------------------ Request building */

/** Values a query string or path segment can legitimately carry. */
function serialiseScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // An object in a query slot is a spec smell, but JSON is the least
  // surprising encoding and beats "[object Object]" reaching the seller.
  return JSON.stringify(value);
}

/**
 * Turns validated tool arguments into one upstream HTTP request.
 *
 * Rules that are load-bearing rather than stylistic:
 *
 *  - every path value is percent-encoded, so `../` in an argument becomes
 *    `..%2F` and cannot climb out of the declared path;
 *  - the final URL is required to stay on the base URL's origin *and* under
 *    its path prefix, which catches a template or base that disagree;
 *  - headers the marketplace owns are dropped even if a binding names one,
 *    because the shaper's filter and this one guard different inputs — a
 *    stored operation blob could predate a change to that list.
 */
export function buildUpstreamRequest(
  baseUrl: string,
  operation: ToolOperation,
  args: Record<string, unknown>,
): UpstreamRequest {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ToolArgumentError(`The listing has an unusable base URL: ${baseUrl}`);
  }

  /* ---------------------------------------------------------------- path */

  let path = operation.pathTemplate;
  const pathBindings = operation.parameters.filter((p) => p.in === "path");

  for (const binding of pathBindings) {
    const value = args[binding.argName];
    if (value === undefined || value === null || value === "") {
      throw new ToolArgumentError(`Missing required path argument “${binding.argName}”.`);
    }
    const encoded = encodeURIComponent(serialiseScalar(value));
    const token = `{${binding.name}}`;
    if (!path.includes(token)) {
      throw new ToolArgumentError(
        `The operation declares path parameter “${binding.name}” but its template does not use it.`,
      );
    }
    path = path.split(token).join(encoded);
  }

  // A template with an unfilled slot would send a literal "{id}" upstream.
  const unfilled = path.match(/\{[^}]+\}/);
  if (unfilled) {
    throw new ToolArgumentError(`Path parameter ${unfilled[0]} was never supplied.`);
  }

  // Join base path and operation path without doubling or dropping a slash.
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}${path.startsWith("/") ? "" : "/"}${path}`, base.origin);

  if (url.origin !== base.origin) {
    throw new ToolArgumentError("The assembled URL left the listing's origin.");
  }
  if (basePath && !url.pathname.startsWith(basePath)) {
    throw new ToolArgumentError("The assembled URL escaped the listing's base path.");
  }

  /* --------------------------------------------------------------- query */

  for (const binding of operation.parameters) {
    if (binding.in !== "query") continue;
    const value = args[binding.argName];
    if (value === undefined || value === null) {
      if (binding.required) {
        throw new ToolArgumentError(`Missing required argument “${binding.argName}”.`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const member of value) url.searchParams.append(binding.name, serialiseScalar(member));
    } else {
      url.searchParams.append(binding.name, serialiseScalar(value));
    }
  }

  /* -------------------------------------------------------------- headers */

  const headers: Record<string, string> = {};

  for (const binding of operation.parameters) {
    if (binding.in !== "header") continue;
    const value = args[binding.argName];
    if (value === undefined || value === null) {
      if (binding.required) {
        throw new ToolArgumentError(`Missing required header argument “${binding.argName}”.`);
      }
      continue;
    }
    if (RESERVED_HEADERS.has(binding.name.toLowerCase())) continue;

    const serialised = serialiseScalar(value);
    // CR/LF in a header value is request splitting. Refuse rather than strip:
    // a caller sending one is not doing anything legitimate.
    if (/[\r\n]/.test(serialised)) {
      throw new ToolArgumentError(`Header “${binding.name}” may not contain a line break.`);
    }
    headers[binding.name] = serialised;
  }

  /* ----------------------------------------------------------------- body */

  let body: string | null = null;

  if (operation.bodyArgs?.length) {
    const contentType = operation.contentType ?? "application/json";

    if (operation.bodyArgs.length === 1 && isWholeBodyArg(operation, operation.bodyArgs[0])) {
      const value = args[operation.bodyArgs[0]];
      if (value === undefined || value === null) {
        if (operation.bodyRequired) {
          throw new ToolArgumentError(`Missing required argument “${operation.bodyArgs[0]}”.`);
        }
      } else {
        body = JSON.stringify(value);
      }
    } else {
      const payload: Record<string, unknown> = {};
      for (const argName of operation.bodyArgs) {
        const value = args[argName];
        if (value !== undefined) payload[argName] = value;
      }
      if (Object.keys(payload).length > 0 || operation.bodyRequired) {
        body = JSON.stringify(payload);
      }
    }

    if (body !== null) headers["content-type"] = contentType;
  }

  return { url: url.toString(), method: operation.method.toUpperCase(), headers, body };
}

/**
 * Whether a single body argument carries the whole body rather than one of its
 * flattened properties. The shaper names that argument `body` or
 * `request_body`; anything else is a property that happens to be alone.
 */
function isWholeBodyArg(operation: ToolOperation, argName: string): boolean {
  if (argName !== "body" && argName !== "request_body") return false;
  // A flattened property genuinely called "body" would also be bound as a
  // parameter somewhere; a whole-body arg never is.
  return !operation.parameters.some((p) => p.argName === argName);
}

const RESERVED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "cookie",
  "x-payment",
  "x-forwarded-for",
  "x-forwarded-host",
  "transfer-encoding",
]);

/* ------------------------------------------------------- Upstream credentials */

export type UpstreamAuthMode = "none" | "bearer" | "api_key_header" | "api_key_query";

/**
 * Attaches the seller's own credential to an outbound request.
 *
 * The secret is passed in rather than read here, because it lives in an
 * environment variable named by `mcp_servers.auth_ref` and never in the
 * database. A dump of the marketplace's tables therefore contains no working
 * key for any seller's upstream — only the name of the slot one would go in.
 *
 * A missing secret is not an error at this layer. The upstream will answer 401
 * and the buyer will not be charged, which is a better failure than refusing a
 * call the seller may have deliberately left unauthenticated.
 */
export function applyUpstreamAuth(
  request: UpstreamRequest,
  auth: { mode: UpstreamAuthMode | null; param: string | null },
  secret: string | null,
): UpstreamRequest {
  if (!auth.mode || auth.mode === "none" || !secret) return request;

  if (auth.mode === "bearer") {
    return { ...request, headers: { ...request.headers, authorization: `Bearer ${secret}` } };
  }

  if (auth.mode === "api_key_header") {
    const header = auth.param?.trim() || "x-api-key";
    // A configured header name is operator-controlled, but a newline in it
    // would still split the request, so it is refused rather than trusted.
    if (/[\r\n]/.test(header) || /[\r\n]/.test(secret)) return request;
    return { ...request, headers: { ...request.headers, [header]: secret } };
  }

  // api_key_query
  const name = auth.param?.trim() || "api_key";
  const url = new URL(request.url);
  url.searchParams.set(name, secret);
  return { ...request, url: url.toString() };
}

/* -------------------------------------------------- Marketplace meta-tools */

/**
 * The tools on the marketplace-wide endpoint.
 *
 * This is the shape that makes the whole idea work: an agent connects to one
 * URL and can find and buy from a catalogue that changes without it ever
 * reconnecting. A per-seller endpoint is the special case; this is the general
 * one.
 */
export function marketplaceTools(): McpToolDefinition[] {
  return [
    {
      name: "search_services",
      title: "Search the marketplace",
      description:
        "Find paid APIs by capability, in your own words — “gold price”, “company " +
        "filings”, “weather forecast”. Returns each match with its price per call, " +
        "the seller, and their observed success rate. Searching is free; you are " +
        "only charged when you call a service.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The capability you need, described plainly.",
          },
          max_price: {
            type: "string",
            description:
              "Optional ceiling in tinybars (1 ℏ = 100000000). Listings dearer than " +
              "this are excluded.",
          },
          category: { type: "string", description: "Optional category filter." },
          limit: { type: "integer", minimum: 1, maximum: 25, description: "Default 10." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "describe_service",
      title: "Inspect a listing",
      description:
        "Read the full detail of one listing before spending on it: its exact price, " +
        "arguments, seller, dispute deposit and delivery record. Free.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The listing slug from search_services." },
        },
        required: ["slug"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "call_service",
      title: "Call a paid service",
      description:
        "Pay for and call one listing. The payment settles on Hedera to the seller " +
        "before the response is returned, and is drawn from your prepaid balance. " +
        "If the provider fails, nothing is charged. Check the price with " +
        "describe_service first if cost matters.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "The listing to call." },
          arguments: {
            type: "object",
            description: "Arguments for the listing, as described by describe_service.",
            additionalProperties: true,
          },
          units: {
            type: "integer",
            minimum: 1,
            description: "Unit budget for metered listings. Ignored for per-call pricing.",
          },
          max_price: {
            type: "string",
            description:
              "Refuse the call if the quote exceeds this many tinybars. Strongly " +
              "recommended: it is the only thing that stops a price change between " +
              "your search and your call.",
          },
        },
        required: ["slug"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    {
      name: "get_spend_authority",
      title: "Check what you are allowed to spend",
      description:
        "Read every limit that governs this agent: the per-call and daily caps on " +
        "paid tools, and the separate daily allowance for free ones. The free " +
        "allowance is not raised by paying or by registering another agent — it is " +
        "keyed to the human behind the agent — so call this when anything is refused " +
        "to find out which limit stopped it and how to lift it. Free.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "get_balance",
      title: "Check your balance",
      description:
        "Your remaining prepaid balance, spend caps, and what you have spent today. " +
        "Call this when a payment is refused to find out which limit stopped it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ];
}

/* ------------------------------------------------------------------ Helpers */

/** Slug → a name that satisfies the MCP tool-name grammar. */
export function sanitiseToolName(slug: string): string {
  const cleaned = slug
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return (/^\d/.test(cleaned) ? `t_${cleaned}` : cleaned || "service").slice(0, 64);
}

/**
 * Total size of a tool list as the model will receive it.
 *
 * Exposed because the context cost of a catalogue is a product constraint, not
 * an implementation detail: a server that quietly grows past a client's budget
 * degrades every agent using it, and the seller should be told before that
 * happens rather than after.
 */
export function toolPayloadBytes(tools: McpToolDefinition[]): number {
  return JSON.stringify(tools).length;
}
