import { describe, expect, it } from "vitest";
import {
  annotationsFor,
  extractOperations,
  inlineSchema,
  MAX_ENUM_VALUES,
  MAX_SCHEMA_DEPTH,
  parseSpec,
  shapeTools,
  SpecError,
  toolNameFor,
  type ParsedSpec,
} from "@/lib/openapi";

/* ------------------------------------------------------------------ fixtures */

/** A small, well-formed spec covering params, a body, and a $ref. */
const PETS = {
  openapi: "3.0.3",
  info: { title: "Pet Store", description: "Pets, as a service.", version: "1.2.0" },
  servers: [{ url: "https://api.pets.example/v1" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        description: "Returns every pet, newest first.",
        tags: ["pets"],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" }, description: "How many." },
          { name: "status", in: "query", required: true, schema: { type: "string", enum: ["available", "sold"] } },
        ],
      },
      post: {
        operationId: "createPet",
        summary: "Add a pet",
        tags: ["pets"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  tag: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getPetById",
        summary: "Fetch one pet",
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
      },
      delete: { operationId: "deletePet", summary: "Remove a pet" },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
};

function spec(document: unknown): ParsedSpec {
  return parseSpec(JSON.stringify(document));
}

/** Builds a spec with `count` distinct GET operations. */
function manyOperations(count: number) {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    paths[`/thing${i}`] = {
      get: { operationId: `getThing${i}`, summary: `Thing ${i}` },
    };
  }
  return { openapi: "3.0.0", info: { title: "Many", version: "1" }, paths };
}

/* -------------------------------------------------------------- parseSpec + */

describe("parseSpec — accepts valid documents", () => {
  it("parses JSON and lifts the info block", () => {
    const parsed = spec(PETS);
    expect(parsed.info.title).toBe("Pet Store");
    expect(parsed.info.version).toBe("1.2.0");
    expect(parsed.info.openapi).toBe("3.0.3");
    expect(parsed.info.serverUrl).toBe("https://api.pets.example/v1");
  });

  it("parses YAML as readily as JSON", () => {
    const parsed = parseSpec(`
openapi: 3.1.0
info:
  title: Yaml API
  version: "2.0"
servers:
  - url: https://api.yaml.example
paths:
  /ping:
    get:
      operationId: ping
      summary: Health check
`);
    expect(parsed.info.title).toBe("Yaml API");
    expect(parsed.info.openapi).toBe("3.1.0");
    expect(shapeTools(parsed).tools[0].name).toBe("ping");
  });

  it("tolerates a document with no servers block", () => {
    const parsed = spec({ ...PETS, servers: undefined });
    expect(parsed.info.serverUrl).toBeNull();
  });

  it("falls back to a title when info is absent", () => {
    const parsed = spec({ openapi: "3.0.0", paths: {} });
    expect(parsed.info.title).toBe("Untitled API");
  });
});

describe("parseSpec — refuses what it cannot honestly convert", () => {
  it("refuses an empty document", () => {
    expect(() => parseSpec("")).toThrow(SpecError);
    expect(() => parseSpec("   ")).toThrow(/empty/i);
  });

  it("refuses malformed JSON with the parser's reason", () => {
    expect(() => parseSpec('{"openapi": "3.0.0",}')).toThrow(SpecError);
  });

  it("refuses Swagger 2.0 rather than half-converting it", () => {
    expect(() => parseSpec(JSON.stringify({ swagger: "2.0", paths: {} }))).toThrow(/Swagger 2\.0/);
  });

  it("refuses a document with no openapi version", () => {
    expect(() => parseSpec(JSON.stringify({ paths: {} }))).toThrow(/not an OpenAPI 3 document/);
  });

  it("refuses OpenAPI 4 and other future majors", () => {
    expect(() => parseSpec(JSON.stringify({ openapi: "4.0.0", paths: {} }))).toThrow(
      /Unsupported OpenAPI version 4\.0\.0/,
    );
  });

  it("refuses a document with no paths object", () => {
    expect(() => parseSpec(JSON.stringify({ openapi: "3.0.0" }))).toThrow(/no `paths`/);
  });

  it("refuses a scalar masquerading as a document", () => {
    expect(() => parseSpec("42")).toThrow(/must be a JSON or YAML object/);
  });
});

/* ------------------------------------------------------------ extraction */

describe("extractOperations", () => {
  it("finds every callable method across every path", () => {
    const operations = extractOperations(spec(PETS).document);
    expect(operations).toHaveLength(4);
    expect(operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      "delete /pets/{petId}",
      "get /pets",
      "get /pets/{petId}",
      "post /pets",
    ]);
  });

  it("carries path-level parameters down to each method", () => {
    const operations = extractOperations(spec(PETS).document);
    const byId = operations.find((o) => o.path === "/pets/{petId}" && o.method === "get");
    expect(byId?.pathLevelParameters).toHaveLength(1);
  });

  it("ignores non-method keys such as summary and servers", () => {
    const operations = extractOperations(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: { "/a": { summary: "not a method", servers: [], get: { operationId: "a" } } },
      }).document,
    );
    expect(operations).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- tool names */

describe("toolNameFor", () => {
  it("normalises a camelCase operationId to snake_case", () => {
    expect(toolNameFor("get", "/x", "getPetById")).toBe("get_pet_by_id");
    expect(toolNameFor("get", "/x", "ListAllUsers")).toBe("list_all_users");
    expect(toolNameFor("get", "/x", "search-items.v2")).toBe("search_items_v2");
  });

  it("derives a readable name from the path when there is no operationId", () => {
    expect(toolNameFor("get", "/v1/users/{id}")).toBe("get_users_by_id");
    expect(toolNameFor("post", "/orders")).toBe("post_orders");
    expect(toolNameFor("get", "/v2/accounts/{accountId}/balance")).toBe(
      "get_accounts_by_account_id_balance",
    );
  });

  it("drops version prefixes, which mean nothing to a model choosing a tool", () => {
    expect(toolNameFor("get", "/v1/ping")).toBe("get_ping");
    expect(toolNameFor("get", "/v99/ping")).toBe("get_ping");
  });

  it("never returns an empty name", () => {
    expect(toolNameFor("get", "/")).toBe("get");
    expect(toolNameFor("get", "/", "   ")).toBe("get");
    expect(toolNameFor("get", "///")).toBe("get");
  });

  it("bounds the name length", () => {
    const name = toolNameFor("get", "/x", "a".repeat(400));
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

/* ----------------------------------------------------------- annotations */

describe("annotationsFor", () => {
  it("marks GET read-only and idempotent", () => {
    expect(annotationsFor("get")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("marks DELETE destructive and idempotent but not read-only", () => {
    expect(annotationsFor("delete")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("marks POST neither read-only nor idempotent", () => {
    expect(annotationsFor("post")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

/* --------------------------------------------------------- inlineSchema */

describe("inlineSchema — resolution", () => {
  const root = {
    components: {
      schemas: {
        Pet: { type: "object", properties: { id: { type: "string" } } },
        Node: {
          type: "object",
          properties: { value: { type: "string" }, child: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
  };

  it("inlines an internal $ref", () => {
    const schema = inlineSchema({ $ref: "#/components/schemas/Pet" }, root);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(["id"]);
  });

  it("truncates a self-referential schema instead of recursing forever", () => {
    const schema = inlineSchema({ $ref: "#/components/schemas/Node" }, root);
    const child = (schema.properties as Record<string, Record<string, unknown>>).child;
    expect(child.description).toMatch(/Recursive/);
  });

  it("reports an unresolved reference rather than throwing", () => {
    const schema = inlineSchema({ $ref: "#/components/schemas/Missing" }, root);
    expect(schema.description).toMatch(/Unresolved reference/);
  });

  it("refuses an external reference", () => {
    expect(() => inlineSchema({ $ref: "https://evil.example/schema.json" }, root)).toThrow(
      /External \$ref is not supported/,
    );
    expect(() => inlineSchema({ $ref: "./other.yaml#/Thing" }, root)).toThrow(SpecError);
  });

  it("merges allOf into a single object", () => {
    const schema = inlineSchema(
      {
        allOf: [
          { type: "object", required: ["a"], properties: { a: { type: "string" } } },
          { type: "object", required: ["b"], properties: { b: { type: "number" } } },
        ],
      },
      root,
    );
    expect(Object.keys(schema.properties as object).sort()).toEqual(["a", "b"]);
    expect(schema.required).toEqual(["a", "b"]);
  });
});

describe("inlineSchema — bounds hostile input", () => {
  it("elides beyond the depth limit", () => {
    // Build a chain deeper than the limit.
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_SCHEMA_DEPTH + 4; i += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    const schema = inlineSchema(deep, {});

    let cursor: Record<string, unknown> = schema;
    let depth = 0;
    while (cursor.properties) {
      cursor = (cursor.properties as Record<string, Record<string, unknown>>).next;
      if (!cursor) break;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_SCHEMA_DEPTH + 1);
  });

  it("truncates an oversized enum and says so", () => {
    const values = Array.from({ length: MAX_ENUM_VALUES + 25 }, (_, i) => `v${i}`);
    const schema = inlineSchema({ type: "string", enum: values }, {});
    expect(schema.enum).toHaveLength(MAX_ENUM_VALUES);
    expect(schema.description).toMatch(/25 further values omitted/);
  });

  it("returns an empty schema for a non-object", () => {
    expect(inlineSchema(null, {})).toEqual({});
    expect(inlineSchema("string", {})).toEqual({});
    expect(inlineSchema([1, 2], {})).toEqual({});
  });

  it("bounds a union to a handful of branches", () => {
    const branches = Array.from({ length: 12 }, (_, i) => ({ type: "object", title: `b${i}` }));
    const schema = inlineSchema({ oneOf: branches }, {});
    expect((schema.oneOf as unknown[]).length).toBeLessThanOrEqual(4);
  });
});

/* ------------------------------------------------------------- shapeTools */

describe("shapeTools — the happy path", () => {
  const result = shapeTools(spec(PETS));
  const byName = (name: string) => result.tools.find((tool) => tool.name === name);

  it("emits one tool per operation", () => {
    expect(result.tools).toHaveLength(4);
    expect(result.truncated).toBe(0);
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "create_pet",
      "delete_pet",
      "get_pet_by_id",
      "list_pets",
    ]);
  });

  it("flattens query parameters into one argument object", () => {
    const tool = byName("list_pets");
    const properties = tool?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["limit", "status"]);
    expect(tool?.inputSchema.required).toEqual(["status"]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  });

  it("binds each argument to its wire location", () => {
    const tool = byName("list_pets");
    expect(tool?.operation.parameters).toEqual([
      { argName: "limit", name: "limit", in: "query", required: false },
      { argName: "status", name: "status", in: "query", required: true },
    ]);
  });

  it("treats a path parameter as required even when the spec forgets to", () => {
    const tool = byName("get_pet_by_id");
    expect(tool?.operation.parameters[0]).toEqual({
      argName: "pet_id",
      name: "petId",
      in: "path",
      required: true,
    });
    expect(tool?.inputSchema.required).toEqual(["pet_id"]);
    expect(tool?.operation.pathTemplate).toBe("/pets/{petId}");
  });

  it("flattens a small request body into named arguments", () => {
    const tool = byName("create_pet");
    expect(tool?.operation.bodyArgs).toEqual(["name", "tag"]);
    expect(tool?.operation.contentType).toBe("application/json");
    expect(tool?.operation.bodyRequired).toBe(true);
    expect(tool?.inputSchema.required).toEqual(["name"]);
  });

  it("carries annotations and provenance", () => {
    expect(byName("delete_pet")?.annotations.destructiveHint).toBe(true);
    expect(byName("list_pets")?.annotations.readOnlyHint).toBe(true);
    expect(byName("list_pets")?.source).toEqual({
      operationId: "listPets",
      path: "/pets",
      method: "get",
      tags: ["pets"],
    });
  });

  it("writes a description even when the spec supplies none", () => {
    const tool = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: { "/widgets": { get: {} } },
      }),
    ).tools[0];
    expect(tool.description).toBe("Retrieves /widgets.");
  });
});

describe("shapeTools — curation and budget", () => {
  it("drops deprecated operations and says why", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/new": { get: { operationId: "current" } },
          "/old": { get: { operationId: "legacy", deprecated: true } },
        },
      }),
    );
    expect(result.tools.map((t) => t.name)).toEqual(["current"]);
    expect(result.dropped).toContainEqual({ path: "/old", method: "get", reason: "deprecated" });
  });

  it("caps the tool count and reports the overflow rather than hiding it", () => {
    const result = shapeTools(spec(manyOperations(50)), { maxTools: 10 });
    expect(result.tools).toHaveLength(10);
    expect(result.truncated).toBe(40);
    expect(result.dropped.filter((d) => d.reason === "over the tool budget")).toHaveLength(40);
  });

  it("prefers documented reads over undocumented writes under a tight budget", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/search": { get: { operationId: "search", summary: "Search everything", description: "Full text." } },
          "/admin/internal/purge/{id}": { delete: { operationId: "purge" } },
        },
      }),
      { maxTools: 1 },
    );
    expect(result.tools.map((t) => t.name)).toEqual(["search"]);
  });

  it("filters by tag when asked", () => {
    const result = shapeTools(spec(PETS), { includeTags: ["pets"] });
    // Only the two operations carrying the tag survive.
    expect(result.tools.map((t) => t.name).sort()).toEqual(["create_pet", "list_pets"]);
    expect(result.dropped.some((d) => d.reason === "tag not selected")).toBe(true);
  });

  it("restricts to an explicit allow-list", () => {
    const result = shapeTools(spec(PETS), { only: ["list_pets"] });
    expect(result.tools.map((t) => t.name)).toEqual(["list_pets"]);
  });

  it("clamps an absurd tool budget instead of trusting it", () => {
    expect(shapeTools(spec(PETS), { maxTools: -5 }).tools).toHaveLength(1);
    expect(shapeTools(spec(PETS), { maxTools: Number.NaN }).tools).toHaveLength(1);
  });
});

describe("shapeTools — hostile and awkward specs", () => {
  it("disambiguates two operations that want the same name", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/a": { get: { operationId: "fetch" } },
          "/b": { get: { operationId: "Fetch" } },
        },
      }),
    );
    expect(result.tools.map((t) => t.name).sort()).toEqual(["fetch", "fetch_2"]);
  });

  it("disambiguates the same parameter name in two locations", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/items/{id}": {
            get: {
              operationId: "getItem",
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                { name: "id", in: "query", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
    );
    const bindings = result.tools[0].operation.parameters;
    expect(bindings.map((b) => b.argName).sort()).toEqual(["id", "query_id"]);
    // Both still point at the upstream name "id".
    expect(bindings.every((b) => b.name === "id")).toBe(true);
  });

  it("never lets a tool argument set a header the marketplace owns", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/x": {
            get: {
              operationId: "x",
              parameters: [
                { name: "Authorization", in: "header", schema: { type: "string" } },
                { name: "X-Payment", in: "header", schema: { type: "string" } },
                { name: "X-Trace-Id", in: "header", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
    );
    const args = Object.keys(result.tools[0].inputSchema.properties as object);
    expect(args).toEqual(["x_trace_id"]);
  });

  it("keeps a wide request body whole rather than flattening 40 arguments", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) properties[`field${i}`] = { type: "string" };

    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/wide": {
            post: {
              operationId: "wide",
              requestBody: {
                required: true,
                content: { "application/json": { schema: { type: "object", properties } } },
              },
            },
          },
        },
      }),
    );
    expect(result.tools[0].operation.bodyArgs).toEqual(["body"]);
    expect(result.tools[0].inputSchema.required).toEqual(["body"]);
  });

  it("drops an operation whose schema cannot be shaped, keeping the rest", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/good": { get: { operationId: "good" } },
          "/bad": {
            get: {
              operationId: "bad",
              parameters: [{ name: "q", in: "query", schema: { $ref: "https://evil.example/s.json" } }],
            },
          },
        },
      }),
    );
    expect(result.tools.map((t) => t.name)).toEqual(["good"]);
    expect(result.dropped.some((d) => d.path === "/bad")).toBe(true);
  });

  it("survives a spec whose paths are all junk", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: { "/a": null, "/b": "nonsense", "/c": [], "/d": {} },
      }),
    );
    expect(result.tools).toHaveLength(0);
    expect(result.truncated).toBe(0);
  });

  it("sanitises argument names that are not valid identifiers", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/x": {
            get: {
              operationId: "x",
              parameters: [
                { name: "filter[status]", in: "query", schema: { type: "string" } },
                { name: "2fa", in: "query", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
    );
    const args = Object.keys(result.tools[0].inputSchema.properties as object).sort();
    expect(args).toEqual(["filter_status", "p_2fa"]);
    // The upstream names are preserved for the wire.
    expect(result.tools[0].operation.parameters.map((p) => p.name).sort()).toEqual([
      "2fa",
      "filter[status]",
    ]);
  });

  it("ignores a parameter with no name or an unknown location", () => {
    const result = shapeTools(
      spec({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {
          "/x": {
            get: {
              operationId: "x",
              parameters: [
                { in: "query", schema: { type: "string" } },
                { name: "c", in: "cookie", schema: { type: "string" } },
                { name: "ok", in: "query", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
    );
    expect(Object.keys(result.tools[0].inputSchema.properties as object)).toEqual(["ok"]);
  });
});
