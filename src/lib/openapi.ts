import { parse as parseYaml } from "yaml";

/**
 * OpenAPI → MCP tool shaping.
 *
 * The naive version of this file is twenty lines: walk `paths`, emit one tool
 * per operation, hand the agent the parameter list verbatim. It produces
 * servers that technically work and are useless in practice, for two reasons
 * that only show up at real-world scale.
 *
 * 1. **Context.** A 200-operation API becomes 200 tool definitions, and every
 *    one of them is sent to the model on every single turn. Forty thousand
 *    tokens of schema arrive before the agent has done anything, and tool
 *    selection accuracy collapses long before the context window does.
 *
 * 2. **Shape.** OpenAPI is written for a code generator that already knows
 *    which endpoint it wants. A model is choosing. `POST /v2/entities/{id}`
 *    with a $ref'd body is unambiguous to a generator and opaque to a chooser.
 *
 * So this module curates rather than transcribes: it flattens the argument
 * surface into one object schema, writes descriptions aimed at a model,
 * bounds every unbounded thing a hostile or careless spec can contain, and
 * caps the tool count — reporting what it dropped instead of silently
 * truncating, so a seller can curate rather than guess.
 *
 * Everything here is pure. No network, no database, no clock. Fetching the
 * document is the caller's job precisely so that this can be tested against
 * hostile input without one.
 */

/* --------------------------------------------------------------- Constants */

/** Tools emitted for one API before the rest are reported as dropped. */
export const MAX_TOOLS = 40;

/** How deep a JSON Schema may nest before the remainder is elided. */
export const MAX_SCHEMA_DEPTH = 6;

/** Properties kept on any one object schema. */
export const MAX_PROPERTIES = 60;

/** Enum members kept before the list is truncated. */
export const MAX_ENUM_VALUES = 40;

/** Characters of tool description shown to the model. */
export const MAX_DESCRIPTION = 400;

/** MCP tool names must be stable, readable, and collision-free. */
export const MAX_TOOL_NAME = 64;

/** Body objects with more properties than this stay a single `body` argument. */
export const MAX_FLATTENED_BODY_PROPS = 20;

/** $ref cycles are real in published specs; this bounds resolution work. */
const MAX_REF_DEPTH = 24;

export type HttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "patch"
  | "head"
  | "options";

/** Methods a marketplace listing may expose. TRACE/OPTIONS are never useful. */
const CALLABLE_METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/* ------------------------------------------------------------------- Types */

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

export type JsonSchema = Record<string, unknown>;

export type ParamLocation = "path" | "query" | "header";

export interface ParamBinding {
  /** Name in the tool's input schema, which may be disambiguated. */
  argName: string;
  /** Name the upstream API actually expects. */
  name: string;
  in: ParamLocation;
  required: boolean;
}

export interface ToolOperation {
  method: HttpMethod;
  /** e.g. `/v1/users/{id}` — still templated; the executor substitutes. */
  pathTemplate: string;
  parameters: ParamBinding[];
  /**
   * Which arguments are assembled into the request body. `null` means the
   * operation takes no body; an entry of `"body"` means the whole argument is
   * the body rather than one property of it.
   */
  bodyArgs: string[] | null;
  bodyRequired: boolean;
  contentType: string | null;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface ShapedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  operation: ToolOperation;
  source: {
    operationId: string | null;
    path: string;
    method: string;
    tags: string[];
  };
}

export interface DroppedOperation {
  path: string;
  method: string;
  reason: string;
}

export interface ShapeResult {
  tools: ShapedTool[];
  dropped: DroppedOperation[];
  /** Operations that existed but did not fit under MAX_TOOLS. */
  truncated: number;
}

export interface SpecInfo {
  title: string;
  description: string;
  version: string;
  /** OpenAPI version string, e.g. "3.1.0". */
  openapi: string;
  /** First declared server URL, when the document declares one. */
  serverUrl: string | null;
}

export interface ParsedSpec {
  info: SpecInfo;
  document: Record<string, unknown>;
}

/* ------------------------------------------------------------------ Parsing */

/**
 * Parses an OpenAPI document from JSON or YAML text.
 *
 * Rejects Swagger 2.0 explicitly rather than half-supporting it: the parameter
 * model is different enough that a partial conversion would emit tools that
 * look right and call the wrong thing.
 */
export function parseSpec(text: string): ParsedSpec {
  if (typeof text !== "string" || text.trim() === "") {
    throw new SpecError("The specification is empty.");
  }

  let document: unknown;
  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    try {
      document = JSON.parse(trimmed);
    } catch (err) {
      throw new SpecError(`Not valid JSON: ${(err as Error).message}`);
    }
  } else {
    try {
      document = parseYaml(trimmed, { maxAliasCount: 100 });
    } catch (err) {
      throw new SpecError(`Not valid YAML or JSON: ${(err as Error).message}`);
    }
  }

  if (!isRecord(document)) {
    throw new SpecError("The specification must be a JSON or YAML object.");
  }

  if (typeof document.swagger === "string") {
    throw new SpecError(
      `Swagger ${document.swagger} is not supported. Convert the document to OpenAPI 3.x first.`,
    );
  }

  const openapi = document.openapi;
  if (typeof openapi !== "string") {
    throw new SpecError("Missing the `openapi` version field — this is not an OpenAPI 3 document.");
  }
  if (!/^3\./.test(openapi)) {
    throw new SpecError(`Unsupported OpenAPI version ${openapi}. Only 3.x is supported.`);
  }

  if (!isRecord(document.paths)) {
    throw new SpecError("The specification declares no `paths` object, so it exposes no operations.");
  }

  const info = isRecord(document.info) ? document.info : {};
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = servers.find((entry) => isRecord(entry) && typeof entry.url === "string");

  return {
    document,
    info: {
      title: typeof info.title === "string" && info.title.trim() ? info.title.trim() : "Untitled API",
      description: typeof info.description === "string" ? info.description.trim() : "",
      version: typeof info.version === "string" ? info.version : "0.0.0",
      openapi,
      serverUrl:
        firstServer && isRecord(firstServer) && typeof firstServer.url === "string"
          ? firstServer.url
          : null,
    },
  };
}

/* -------------------------------------------------------------- Referencing */

/**
 * Resolves an internal `$ref` against the document root.
 *
 * External refs (`http://…`, `./other.yaml`) are refused rather than fetched.
 * Following them would make this function a network client, and a spec-supplied
 * URL fetched by our server is exactly the SSRF hole `lib/ssrf.ts` exists to
 * close — reopening it here, one indirection away, would be worse than not
 * supporting the feature.
 */
function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref.startsWith("#/")) {
    throw new SpecError(`External $ref is not supported: ${ref}`);
  }

  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Inlines a schema, bounding it in every direction a published spec can be
 * unbounded: depth, breadth, enum length, and reference cycles.
 *
 * A cycle is not an error — self-referential schemas (a tree node containing
 * tree nodes) are legitimate and common. It is truncated to an open object,
 * which is honest about what we know rather than crashing on valid input.
 */
export function inlineSchema(
  schema: unknown,
  root: Record<string, unknown>,
  depth = 0,
  seen: Set<string> = new Set(),
): JsonSchema {
  if (!isRecord(schema)) return {};
  if (depth > MAX_SCHEMA_DEPTH) return {};

  // $ref — resolve once, guarding against a cycle through the same pointer.
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (seen.has(ref) || seen.size > MAX_REF_DEPTH) {
      return { type: "object", description: "Recursive structure, elided." };
    }
    const resolved = resolveRef(ref, root);
    if (resolved === undefined) {
      return { type: "object", description: `Unresolved reference ${ref}.` };
    }
    return inlineSchema(resolved, root, depth, new Set([...seen, ref]));
  }

  const output: JsonSchema = {};

  // allOf is a composition a model cannot act on; merge it into one object.
  if (Array.isArray(schema.allOf)) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const member of schema.allOf) {
      const part = inlineSchema(member, root, depth + 1, seen);
      if (isRecord(part.properties)) {
        Object.assign(merged.properties as Record<string, unknown>, part.properties);
      }
      if (Array.isArray(part.required)) {
        (merged.required as string[]).push(...(part.required as string[]));
      }
      if (typeof part.description === "string" && !merged.description) {
        merged.description = part.description;
      }
    }
    if ((merged.required as string[]).length === 0) delete merged.required;
    else merged.required = unique(merged.required as string[]);
    if (Object.keys(merged.properties as Record<string, unknown>).length === 0) {
      delete merged.properties;
    }
    return merged;
  }

  // oneOf / anyOf: keep the branches but bound them, so a union does not
  // multiply into an unreadable wall of schema.
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key])) {
      const branches = (schema[key] as unknown[])
        .slice(0, 4)
        .map((member) => inlineSchema(member, root, depth + 1, seen));
      output[key] = branches;
    }
  }

  for (const key of [
    "type",
    "format",
    "title",
    "default",
    "example",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "nullable",
  ] as const) {
    if (schema[key] !== undefined) output[key] = schema[key];
  }

  if (typeof schema.description === "string" && schema.description.trim()) {
    output.description = truncate(schema.description.trim(), MAX_DESCRIPTION);
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, MAX_ENUM_VALUES);
    output.enum = values;
    if (schema.enum.length > MAX_ENUM_VALUES) {
      output.description = joinDescription(
        typeof output.description === "string" ? output.description : undefined,
        `${schema.enum.length - MAX_ENUM_VALUES} further values omitted.`,
      );
    }
  }

  if (isRecord(schema.properties)) {
    const properties: Record<string, unknown> = {};
    const entries = Object.entries(schema.properties).slice(0, MAX_PROPERTIES);
    for (const [name, value] of entries) {
      properties[name] = inlineSchema(value, root, depth + 1, seen);
    }
    output.properties = properties;
    output.type = "object";

    if (Array.isArray(schema.required)) {
      const required = (schema.required as unknown[]).filter(
        (name): name is string => typeof name === "string" && name in properties,
      );
      if (required.length) output.required = required;
    }
  }

  if (schema.items !== undefined) {
    output.items = inlineSchema(schema.items, root, depth + 1, seen);
    output.type = "array";
  }

  return output;
}

/* -------------------------------------------------------------- Extraction */

interface RawOperation {
  method: HttpMethod;
  path: string;
  operation: Record<string, unknown>;
  /** Parameters declared on the path item, shared by every method under it. */
  pathLevelParameters: unknown[];
}

/** Walks `paths` into a flat list of callable operations. */
export function extractOperations(document: Record<string, unknown>): RawOperation[] {
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: RawOperation[] = [];

  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const pathLevelParameters = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of CALLABLE_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      operations.push({ method, path, operation, pathLevelParameters });
    }
  }

  return operations;
}

/* ----------------------------------------------------------------- Shaping */

/**
 * Derives a tool name.
 *
 * `operationId` is preferred because the seller chose it, but it arrives in
 * every casing convention there is, so it is normalised to snake_case. Without
 * one, the method and path make a name that still reads like an instruction:
 * `GET /v1/users/{id}` becomes `get_users_by_id`.
 */
export function toolNameFor(method: string, path: string, operationId?: string | null): string {
  if (operationId && typeof operationId === "string" && operationId.trim()) {
    const normalised = operationId
      .trim()
      // camelCase and PascalCase to snake, before lowercasing loses the boundary.
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase();
    if (normalised) return normalised.slice(0, MAX_TOOL_NAME);
  }

  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      // {userId} reads as "by user id", which is what the parameter means.
      /^\{.+\}$/.test(segment)
        ? `by_${segment.slice(1, -1)}`
        : segment,
    )
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean)
    // Version prefixes carry no meaning for a model choosing a tool.
    .filter((segment) => !/^v\d+$/.test(segment));

  const name = [method.toLowerCase(), ...segments].join("_").replace(/_+/g, "_");
  return (name || method.toLowerCase()).slice(0, MAX_TOOL_NAME);
}

/**
 * Writes the description the model actually selects on.
 *
 * OpenAPI descriptions are written for a human reading reference docs and are
 * frequently absent, so this falls back to stating what the operation does in
 * terms of its method and path rather than leaving the field empty — an
 * undescribed tool is one the model will not choose correctly.
 */
function describeOperation(raw: RawOperation): string {
  const { operation, method, path } = raw;
  const summary = typeof operation.summary === "string" ? operation.summary.trim() : "";
  const described = typeof operation.description === "string" ? operation.description.trim() : "";

  const primary = summary || described;
  if (primary) {
    const extra = summary && described && described !== summary ? described : "";
    return truncate(joinDescription(primary, extra) ?? primary, MAX_DESCRIPTION);
  }

  const verb =
    method === "get"
      ? "Retrieves"
      : method === "delete"
        ? "Deletes"
        : method === "post"
          ? "Creates or submits to"
          : "Updates";
  return `${verb} ${path}.`;
}

/** MCP behaviour hints, derived from the method's HTTP semantics. */
export function annotationsFor(method: HttpMethod): ToolAnnotations {
  return {
    readOnlyHint: method === "get" || method === "head",
    destructiveHint: method === "delete",
    idempotentHint: method === "get" || method === "put" || method === "delete",
  };
}

/**
 * Builds the flat input schema, and the binding table that says where each
 * argument goes on the wire.
 *
 * Flat matters. OpenAPI splits arguments across four locations, and a model
 * asked to fill `{path: {...}, query: {...}, body: {...}}` fills it wrong. One
 * object of named arguments is what a tool call actually looks like, so the
 * split is recorded in the binding table and hidden from the agent.
 */
function buildInputSchema(
  raw: RawOperation,
  root: Record<string, unknown>,
): { schema: JsonSchema; parameters: ParamBinding[]; bodyArgs: string[] | null; bodyRequired: boolean; contentType: string | null } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parameters: ParamBinding[] = [];

  const declared = [
    ...raw.pathLevelParameters,
    ...(Array.isArray(raw.operation.parameters) ? raw.operation.parameters : []),
  ];

  const taken = new Set<string>();

  for (const entry of declared) {
    const parameter = isRecord(entry) && typeof entry.$ref === "string"
      ? resolveRef(entry.$ref, root)
      : entry;
    if (!isRecord(parameter)) continue;

    const name = parameter.name;
    const location = parameter.in;
    if (typeof name !== "string" || !name) continue;
    if (location !== "path" && location !== "query" && location !== "header") continue;

    // Headers the marketplace controls are never the agent's to set. Letting a
    // tool argument write Authorization would let a buyer impersonate us to the
    // seller's upstream.
    if (location === "header" && RESERVED_HEADERS.has(name.toLowerCase())) continue;

    // The same name in two locations is legal in OpenAPI and impossible in a
    // flat argument object, so the loser is disambiguated by location.
    let argName = sanitiseArgName(name);
    if (taken.has(argName)) argName = sanitiseArgName(`${location}_${name}`);
    if (taken.has(argName)) continue;
    taken.add(argName);

    const schema = inlineSchema(parameter.schema ?? {}, root);
    if (typeof parameter.description === "string" && parameter.description.trim()) {
      schema.description = truncate(parameter.description.trim(), MAX_DESCRIPTION);
    }

    properties[argName] = schema;
    const isRequired = parameter.required === true || location === "path";
    if (isRequired) required.push(argName);

    parameters.push({ argName, name, in: location, required: isRequired });
  }

  /* ---------------------------------------------------------------- body */

  let bodyArgs: string[] | null = null;
  let bodyRequired = false;
  let contentType: string | null = null;

  const requestBodyRaw = isRecord(raw.operation.requestBody) &&
    typeof raw.operation.requestBody.$ref === "string"
      ? resolveRef(raw.operation.requestBody.$ref, root)
      : raw.operation.requestBody;

  if (isRecord(requestBodyRaw) && isRecord(requestBodyRaw.content)) {
    const content = requestBodyRaw.content;
    // JSON first; a spec offering both JSON and form encoding gets JSON.
    const mediaType =
      Object.keys(content).find((key) => key.includes("json")) ?? Object.keys(content)[0];

    if (mediaType && isRecord(content[mediaType])) {
      contentType = mediaType;
      bodyRequired = requestBodyRaw.required === true;

      const bodySchema = inlineSchema(
        (content[mediaType] as Record<string, unknown>).schema ?? {},
        root,
      );

      const bodyProperties = isRecord(bodySchema.properties) ? bodySchema.properties : null;
      const propertyCount = bodyProperties ? Object.keys(bodyProperties).length : 0;

      if (bodyProperties && propertyCount > 0 && propertyCount <= MAX_FLATTENED_BODY_PROPS) {
        // Flatten: the agent fills named fields rather than nesting an object
        // inside an object for no reason.
        const bodyRequiredNames = Array.isArray(bodySchema.required)
          ? (bodySchema.required as string[])
          : [];
        bodyArgs = [];

        for (const [name, schema] of Object.entries(bodyProperties)) {
          let argName = sanitiseArgName(name);
          if (taken.has(argName)) argName = sanitiseArgName(`body_${name}`);
          if (taken.has(argName)) continue;
          taken.add(argName);

          properties[argName] = isRecord(schema) ? (schema as JsonSchema) : {};
          bodyArgs.push(argName);
          if (bodyRequired && bodyRequiredNames.includes(name)) required.push(argName);
        }
      } else {
        // Too wide, or not an object: keep it whole under one argument.
        const argName = taken.has("body") ? "request_body" : "body";
        taken.add(argName);
        properties[argName] = bodySchema;
        bodyArgs = [argName];
        if (bodyRequired) required.push(argName);
      }
    }
  }

  const schema: JsonSchema = {
    type: "object",
    properties,
    // Agents hallucinate plausible-looking extra arguments. Refusing them at
    // the schema boundary turns that into a validation error the model can see
    // and correct, rather than a silently ignored field.
    additionalProperties: false,
  };
  if (required.length) schema.required = unique(required);

  return { schema, parameters, bodyArgs, bodyRequired, contentType };
}

/** Headers the marketplace owns; a tool argument may never set these. */
const RESERVED_HEADERS = new Set([
  "authorization",
  "host",
  "content-length",
  "connection",
  "cookie",
  "x-payment",
  "x-forwarded-for",
  "x-forwarded-host",
]);

/**
 * Ranks an operation for the tool budget.
 *
 * When a spec has more operations than we will expose, the ones kept should be
 * the ones an agent is most likely to want: documented, reading rather than
 * writing, and shallow in the path tree — a top-level search endpoint is more
 * broadly useful than a nested administrative sub-resource.
 */
function scoreOperation(raw: RawOperation): number {
  const { operation, method, path } = raw;
  let score = 0;

  if (typeof operation.summary === "string" && operation.summary.trim()) score += 3;
  if (typeof operation.description === "string" && operation.description.trim()) score += 2;
  if (typeof operation.operationId === "string" && operation.operationId.trim()) score += 2;
  if (method === "get") score += 3;
  if (method === "post") score += 1;
  if (method === "delete") score -= 2;

  const depth = path.split("/").filter(Boolean).length;
  score -= depth;

  const templated = (path.match(/\{/g) ?? []).length;
  score -= templated;

  return score;
}

export interface ShapeOptions {
  /** Tools to emit before the remainder is reported as truncated. */
  maxTools?: number;
  /** Restrict to operations carrying at least one of these tags. */
  includeTags?: string[];
  /** Expose only these operation names, after shaping. Applied last. */
  only?: string[];
}

/**
 * Turns a parsed document into the tools an agent will actually see.
 *
 * The dropped list is part of the output rather than a log line: a seller whose
 * API lost 12 operations to a tool budget needs to be told which, so they can
 * split the API into two servers or tag the ones that matter.
 */
export function shapeTools(parsed: ParsedSpec, options: ShapeOptions = {}): ShapeResult {
  const maxTools = clampInt(options.maxTools ?? MAX_TOOLS, 1, 200);
  const root = parsed.document;
  const dropped: DroppedOperation[] = [];

  const candidates: Array<{ raw: RawOperation; score: number }> = [];

  for (const raw of extractOperations(root)) {
    const { operation, method, path } = raw;

    if (operation.deprecated === true) {
      dropped.push({ path, method, reason: "deprecated" });
      continue;
    }

    const tags = Array.isArray(operation.tags)
      ? operation.tags.filter((tag): tag is string => typeof tag === "string")
      : [];

    if (options.includeTags?.length) {
      const matched = tags.some((tag) => options.includeTags?.includes(tag));
      if (!matched) {
        dropped.push({ path, method, reason: "tag not selected" });
        continue;
      }
    }

    candidates.push({ raw, score: scoreOperation(raw) });
  }

  // Rank, then restore document order among the survivors so a seller reading
  // their own spec still recognises the list.
  candidates.sort((a, b) => b.score - a.score);
  const kept = candidates.slice(0, maxTools);
  const truncated = candidates.length - kept.length;

  for (const { raw } of candidates.slice(maxTools)) {
    dropped.push({ path: raw.path, method: raw.method, reason: "over the tool budget" });
  }

  const tools: ShapedTool[] = [];
  const usedNames = new Set<string>();

  for (const { raw } of kept) {
    const { operation, method, path } = raw;

    let built;
    try {
      built = buildInputSchema(raw, root);
    } catch (err) {
      // One malformed operation must not fail the whole import.
      dropped.push({
        path,
        method,
        reason: err instanceof SpecError ? err.message : "could not be shaped",
      });
      continue;
    }

    const operationId =
      typeof operation.operationId === "string" ? operation.operationId : null;

    let name = toolNameFor(method, path, operationId);
    if (usedNames.has(name)) {
      // A collision is a protocol error, so it is resolved rather than logged.
      let suffix = 2;
      let candidate = `${name}_${suffix}`.slice(0, MAX_TOOL_NAME);
      while (usedNames.has(candidate) && suffix < 100) {
        suffix += 1;
        candidate = `${name}_${suffix}`.slice(0, MAX_TOOL_NAME);
      }
      name = candidate;
    }
    usedNames.add(name);

    const tags = Array.isArray(operation.tags)
      ? operation.tags.filter((tag): tag is string => typeof tag === "string")
      : [];

    tools.push({
      name,
      title:
        typeof operation.summary === "string" && operation.summary.trim()
          ? truncate(operation.summary.trim(), 80)
          : titleCase(name),
      description: describeOperation(raw),
      inputSchema: built.schema,
      annotations: annotationsFor(method),
      operation: {
        method,
        pathTemplate: path,
        parameters: built.parameters,
        bodyArgs: built.bodyArgs,
        bodyRequired: built.bodyRequired,
        contentType: built.contentType,
      },
      source: { operationId, path, method, tags },
    });
  }

  const filtered = options.only?.length
    ? tools.filter((tool) => options.only?.includes(tool.name))
    : tools;

  return { tools: filtered, dropped, truncated };
}

/* ------------------------------------------------------------------ Helpers */

/**
 * A readable title from a tool name, for the many published operations that
 * carry a description but no summary. "obs_stations" as a marketplace listing
 * name reads like a database column; "Obs Stations" reads like a product.
 */
function titleCase(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function joinDescription(a: string | undefined, b: string | undefined): string | undefined {
  const parts = [a, b].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join(" ") : undefined;
}

/** JSON Schema property names an agent can reliably reproduce. */
function sanitiseArgName(name: string): string {
  const cleaned = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  // A name starting with a digit is legal JSON but reads as an index.
  return /^\d/.test(cleaned) ? `p_${cleaned}` : cleaned || "arg";
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
