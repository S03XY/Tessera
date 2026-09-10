import { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import { sha256Hex } from "@/lib/hash";
import type { JsonSchema } from "@/lib/openapi";

/**
 * Raw JSON Schema, as a Standard Schema.
 *
 * `registerTool` wants a Standard Schema — an object exposing both a validator
 * and a JSON Schema conversion. Zod satisfies that, and every MCP example
 * reaches for `z.object({...})`.
 *
 * This marketplace cannot. Its tool schemas come from sellers' OpenAPI
 * documents at runtime, so there is no compile-time zod to write. Converting
 * JSON Schema into zod and back would be lossy in both directions and would
 * make the schema an agent sees differ from the one the seller published.
 *
 * So the schema stays exactly as shaped and gets a Standard Schema wrapper
 * instead. Validation is Ajv — the SDK's own bundled copy, so no version of it
 * is added to this project — with `coerceTypes` on, because a model that sends
 * `"5"` for an integer has made a formatting slip rather than an error, and
 * failing the call over it wastes a turn and teaches the model nothing.
 */

export interface StandardSchemaJson {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { value: Record<string, unknown>; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> };
    readonly jsonSchema: {
      readonly input: () => Record<string, unknown>;
      readonly output: () => Record<string, unknown>;
    };
  };
}

/**
 * Compiled validators, keyed by a digest of the schema.
 *
 * A stateless handler rebuilds its tool list on every request, so without a
 * cache a forty-tool server would recompile forty schemas per call. The digest
 * rather than the object identity is the key precisely because those objects
 * are new on each request, having just come out of Postgres.
 */
const MAX_CACHED = 500;
const cache = new Map<string, ReturnType<InstanceType<typeof Ajv>["compile"]>>();

const ajv = new Ajv({
  allErrors: true,
  // Seller-supplied schemas contain keywords Ajv does not know (OpenAPI's
  // `nullable`, vendor extensions). Strict mode would throw on those and take
  // a whole listing offline over a cosmetic annotation.
  strict: false,
  coerceTypes: true,
  useDefaults: true,
});

function compile(schema: JsonSchema) {
  const key = sha256Hex(JSON.stringify(schema));
  const hit = cache.get(key);
  if (hit) return hit;

  let validator;
  try {
    validator = ajv.compile(schema as object);
  } catch {
    // An uncompilable schema must not take down tools/list. Accept anything
    // and let buildUpstreamRequest — the actual security boundary — refuse
    // what it cannot safely place on the wire.
    validator = Object.assign(() => true, { errors: null }) as unknown as ReturnType<
      InstanceType<typeof Ajv>["compile"]
    >;
  }

  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, validator);
  return validator;
}

/** Wraps a JSON Schema so `registerTool` will accept it. */
export function jsonSchemaStandard(schema: JsonSchema): StandardSchemaJson {
  const validator = compile(schema);
  const frozen = schema as Record<string, unknown>;

  return {
    "~standard": {
      version: 1,
      vendor: "tessera",
      validate(value: unknown) {
        if (value === undefined || value === null) value = {};
        if (typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Arguments must be an object." }] };
        }

        // Ajv coerces in place, so the caller's object would be mutated.
        // A tool call's arguments belong to the SDK; copy before touching.
        const candidate = { ...(value as Record<string, unknown>) };

        if (validator(candidate)) {
          return { value: candidate };
        }

        const issues = (validator.errors ?? []).map((error) => ({
          message: `${error.instancePath || "arguments"} ${error.message ?? "is invalid"}`.trim(),
          path: error.instancePath
            ? error.instancePath.split("/").filter(Boolean)
            : undefined,
        }));

        return {
          issues: issues.length ? issues : [{ message: "Arguments did not match the schema." }],
        };
      },
      jsonSchema: {
        input: () => frozen,
        output: () => frozen,
      },
    },
  };
}
