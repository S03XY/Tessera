import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/lib/db";
import {
  normaliseSlug,
  planFromSpec,
  publishServer,
  PublishError,
  resolveBaseUrl,
} from "@/lib/publish";
import { getMcpServerBySlug, toolsForMcpServer } from "@/lib/repo";

/**
 * Publishing: shaping a specification into listings, and writing them.
 *
 * The base-URL cases are not hypothetical. The Swagger Petstore declares its
 * server as the relative string "/api/v3", and resolving that wrongly produces
 * a server whose every tool calls the wrong host — without failing loudly.
 */

const PETSTORE = {
  openapi: "3.0.3",
  info: { title: "Pet Store", description: "Pets as a service.", version: "1.0.0" },
  servers: [{ url: "/api/v3" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        tags: ["pets"],
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        summary: "Fetch a pet",
        tags: ["pets"],
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
      },
    },
  },
};

const ABSOLUTE = {
  ...PETSTORE,
  servers: [{ url: "https://api.pets.example/v2" }],
};

const text = (doc: unknown) => JSON.stringify(doc);

let sellerId: string;
const publishedSlugs: string[] = [];

beforeAll(async () => {
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
});

afterAll(async () => {
  for (const slug of publishedSlugs) {
    await query(`DELETE FROM mcp_servers WHERE slug = $1`, [slug]);
  }
});

/* ------------------------------------------------------------- base URLs */

describe("resolveBaseUrl", () => {
  it("resolves a relative server URL against where the spec was fetched from", () => {
    expect(
      resolveBaseUrl({
        serverUrl: "/api/v3",
        specUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
      }),
    ).toBe("https://petstore3.swagger.io/api/v3");
  });

  it("takes an absolute server URL as-is", () => {
    expect(resolveBaseUrl({ serverUrl: "https://api.example.com/v2" })).toBe(
      "https://api.example.com/v2",
    );
  });

  it("lets an explicit override win over the spec", () => {
    expect(
      resolveBaseUrl({
        override: "https://mirror.example.com",
        serverUrl: "https://api.example.com/v2",
      }),
    ).toBe("https://mirror.example.com");
  });

  it("falls back to the spec URL's origin when there is no server block", () => {
    expect(resolveBaseUrl({ specUrl: "https://api.example.com/docs/openapi.json" })).toBe(
      "https://api.example.com",
    );
  });

  it("strips a trailing slash so path joining stays predictable", () => {
    expect(resolveBaseUrl({ serverUrl: "https://api.example.com/v2/" })).toBe(
      "https://api.example.com/v2",
    );
  });

  it("refuses a non-http override", () => {
    expect(() => resolveBaseUrl({ override: "ftp://files.example.com" })).toThrow(
      /not an absolute http/,
    );
    expect(() => resolveBaseUrl({ override: "not a url" })).toThrow(PublishError);
  });

  it("refuses when nothing can supply a base URL", () => {
    expect(() => resolveBaseUrl({})).toThrow(/declares no absolute server URL/);
    expect(() => resolveBaseUrl({ serverUrl: "/api/v3" })).toThrow(PublishError);
  });
});

describe("normaliseSlug", () => {
  it("makes a URL-safe slug from a title", () => {
    expect(normaliseSlug("Pet Store API!")).toBe("pet-store-api");
    expect(normaliseSlug("  weather.gov  ")).toBe("weather-gov");
  });

  it("returns empty for input with nothing usable", () => {
    expect(normaliseSlug("!!!")).toBe("");
  });
});

/* ----------------------------------------------------------------- plans */

describe("planFromSpec", () => {
  it("shapes a spec into tools with a resolved base URL", () => {
    const plan = planFromSpec(text(PETSTORE), {
      specUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
    });

    expect(plan.title).toBe("Pet Store");
    expect(plan.baseUrl).toBe("https://petstore3.swagger.io/api/v3");
    expect(plan.tools.map((t) => t.name).sort()).toEqual(["get_pet", "list_pets"]);
    expect(plan.specHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the context cost of the catalogue", () => {
    const plan = planFromSpec(text(ABSOLUTE));
    expect(plan.payloadBytes).toBeGreaterThan(0);
    expect(plan.payloadBytes).toBeLessThan(5000);
  });

  it("honours a tool budget and reports the overflow", () => {
    const plan = planFromSpec(text(ABSOLUTE), { maxTools: 1 });
    expect(plan.tools).toHaveLength(1);
    expect(plan.truncated).toBe(1);
  });

  it("honours a tag filter", () => {
    const plan = planFromSpec(text(ABSOLUTE), { includeTags: ["pets"] });
    expect(plan.tools).toHaveLength(2);
  });

  it("refuses a spec it cannot parse", () => {
    expect(() => planFromSpec("not json or yaml: [")).toThrow(PublishError);
    expect(() => planFromSpec(text({ swagger: "2.0", paths: {} }))).toThrow(/Swagger 2\.0/);
  });

  it("refuses a spec that yields no usable tools", () => {
    expect(() =>
      planFromSpec(
        text({
          openapi: "3.0.0",
          info: { title: "Empty", version: "1" },
          servers: [{ url: "https://api.example.com" }],
          paths: { "/gone": { get: { deprecated: true, operationId: "gone" } } },
        }),
      ),
    ).toThrow(/No usable operations/);
  });

  it("refuses a spec whose server URL cannot be resolved", () => {
    expect(() => planFromSpec(text(PETSTORE))).toThrow(/declares no absolute server URL/);
  });
});

/* --------------------------------------------------------------- writing */

describe("publishServer", () => {
  it("writes a server and one listing per tool, in one transaction", async () => {
    const slug = `publish-test-${Date.now()}`;
    publishedSlugs.push(slug);

    const plan = planFromSpec(text(ABSOLUTE));
    const result = await publishServer(
      {
        sellerId,
        slug,
        name: "Pet Store",
        description: "Pets as a service.",
        plan,
        price: "50000",
        priceUnit: "per_call",
      },
      "https://tessera.test",
    );

    expect(result.toolCount).toBe(2);
    expect(result.url).toBe(`https://tessera.test/mcp/${slug}`);

    const server = await getMcpServerBySlug(slug);
    expect(server?.status).toBe("active");
    expect(server?.base_url).toBe("https://api.pets.example/v2");
    expect(server?.tool_count).toBe(2);

    const tools = await toolsForMcpServer(server!.id);
    expect(tools.map((t) => t.tool_name).sort()).toEqual(["get_pet", "list_pets"]);
    expect(tools[0].upstream_kind).toBe("openapi");
    expect(tools[0].price_amount).toBe("50000");

    // The operation blob round-trips through jsonb intact.
    const withPath = tools.find((t) => t.tool_name === "get_pet");
    expect(withPath?.mcp_operation?.pathTemplate).toBe("/pets/{petId}");
    expect(withPath?.mcp_operation?.parameters[0]).toEqual({
      argName: "pet_id",
      name: "petId",
      in: "path",
      required: true,
    });
    expect(withPath?.input_schema?.required).toEqual(["pet_id"]);
  });

  it("applies a per-tool price override", async () => {
    const slug = `publish-override-${Date.now()}`;
    publishedSlugs.push(slug);

    const plan = planFromSpec(text(ABSOLUTE));
    await publishServer(
      {
        sellerId,
        slug,
        name: "Pet Store",
        description: "",
        plan,
        price: "1000",
        priceUnit: "per_call",
        priceOverrides: { get_pet: "9999" },
      },
      "https://tessera.test",
    );

    const server = await getMcpServerBySlug(slug);
    const tools = await toolsForMcpServer(server!.id);
    const byName = Object.fromEntries(tools.map((t) => [t.tool_name, t.price_amount]));
    expect(byName.get_pet).toBe("9999");
    expect(byName.list_pets).toBe("1000");
  });

  it("can publish as a draft, invisible to agents", async () => {
    const slug = `publish-draft-${Date.now()}`;
    publishedSlugs.push(slug);

    const plan = planFromSpec(text(ABSOLUTE));
    await publishServer(
      {
        sellerId,
        slug,
        name: "Draft API",
        description: "",
        plan,
        price: "1000",
        priceUnit: "per_call",
        activate: false,
      },
      "https://tessera.test",
    );

    const server = await getMcpServerBySlug(slug);
    expect(server?.status).toBe("draft");
    // Draft tools are not listed to agents.
    expect(await toolsForMcpServer(server!.id)).toHaveLength(0);
    expect(await toolsForMcpServer(server!.id, { includeInactive: true })).toHaveLength(2);
  });

  it("refuses a slug that is already taken", async () => {
    const slug = `publish-dup-${Date.now()}`;
    publishedSlugs.push(slug);
    const plan = planFromSpec(text(ABSOLUTE));

    await publishServer(
      { sellerId, slug, name: "First", description: "", plan, price: "1000", priceUnit: "per_call" },
      "https://tessera.test",
    );

    await expect(
      publishServer(
        { sellerId, slug, name: "Second", description: "", plan, price: "1000", priceUnit: "per_call" },
        "https://tessera.test",
      ),
    ).rejects.toThrow(/already published/);
  });

  it("refuses an unusable slug", async () => {
    const plan = planFromSpec(text(ABSOLUTE));
    await expect(
      publishServer(
        { sellerId, slug: "!!!", name: "x", description: "", plan, price: "1000", priceUnit: "per_call" },
        "https://tessera.test",
      ),
    ).rejects.toThrow(/URL-safe name/);
  });

  it("writes nothing at all when one tool's price is invalid", async () => {
    const slug = `publish-atomic-${Date.now()}`;
    const plan = planFromSpec(text(ABSOLUTE));

    await expect(
      publishServer(
        {
          sellerId,
          slug,
          name: "Atomic",
          description: "",
          plan,
          price: "1000",
          priceUnit: "per_call",
          priceOverrides: { get_pet: "not-a-number" },
        },
        "https://tessera.test",
      ),
    ).rejects.toThrow(/whole number of tinybars/);

    // The transaction rolled back: no server, and no orphan listings.
    expect(await getMcpServerBySlug(slug)).toBeNull();
    const orphans = await query(`SELECT id FROM services WHERE slug LIKE $1`, [`${slug}-%`]);
    expect(orphans).toHaveLength(0);
  });

  it("indexes tool names as keywords so agents can find them by capability", async () => {
    const slug = `publish-keywords-${Date.now()}`;
    publishedSlugs.push(slug);
    const plan = planFromSpec(text(ABSOLUTE));

    await publishServer(
      { sellerId, slug, name: "Kw", description: "", plan, price: "1000", priceUnit: "per_call" },
      "https://tessera.test",
    );

    const server = await getMcpServerBySlug(slug);
    const tools = await toolsForMcpServer(server!.id);
    const pets = tools.find((t) => t.tool_name === "list_pets");
    expect(pets?.keywords).toContain("pets");
    expect(pets?.keywords).toContain("list");
  });
});
