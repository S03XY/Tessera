import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { fetchSpec, planFromSpec, PublishError } from "@/lib/publish";
import { MCP_MAX_TOOLS } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Shape a specification without publishing it.
 *
 * A seller pasting a URL gets back the exact tools an agent would see, the
 * context they cost, and — importantly — what was dropped and why. Publishing
 * blind and discovering later that a third of the API is missing is the
 * failure mode this endpoint exists to prevent.
 *
 * Writes nothing, so it needs no seller gate.
 */

const Body = z
  .object({
    spec_url: z.string().min(8).max(2000).optional(),
    spec: z.string().min(20).max(4_000_000).optional(),
    base_url: z.string().max(2000).optional(),
    max_tools: z.number().int().min(1).max(200).optional(),
    include_tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  })
  .refine((value) => Boolean(value.spec_url || value.spec), {
    message: "Provide either spec_url or spec.",
  });

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }

  const input = parsed.data;

  try {
    const specText = input.spec ?? (await fetchSpec(input.spec_url as string));

    const plan = planFromSpec(specText, {
      specUrl: input.spec_url ?? null,
      baseUrl: input.base_url ?? null,
      maxTools: input.max_tools ?? MCP_MAX_TOOLS,
      includeTags: input.include_tags,
    });

    return NextResponse.json({
      ok: true,
      api: {
        title: plan.title,
        description: plan.description,
        version: plan.version,
        openapi: plan.openapi,
        base_url: plan.baseUrl,
        spec_hash: plan.specHash,
      },
      tools: plan.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        method: tool.operation.method.toUpperCase(),
        path: tool.operation.pathTemplate,
        arguments: Object.keys(
          (tool.inputSchema.properties as Record<string, unknown>) ?? {},
        ),
        required: (tool.inputSchema.required as string[]) ?? [],
        read_only: tool.annotations.readOnlyHint,
        destructive: tool.annotations.destructiveHint,
      })),
      context: {
        tool_count: plan.tools.length,
        payload_bytes: plan.payloadBytes,
        approx_tokens: Math.round(plan.payloadBytes / 4),
        note:
          "This is what every connected agent carries in its context on every turn. " +
          "Fewer, better-named tools are chosen more accurately than many.",
      },
      dropped: {
        count: plan.dropped.length,
        truncated: plan.truncated,
        operations: plan.dropped.slice(0, 50),
      },
    });
  } catch (err) {
    if (err instanceof PublishError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    return NextResponse.json(
      {
        error: "preview_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
