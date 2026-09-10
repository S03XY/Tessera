"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Legend,
  Mono,
  Spinner,
} from "@/components/ui";
import { formatAmount } from "@/lib/money";

/**
 * Publishing an API as an MCP server, from the browser.
 *
 * The whole product is this screen: a seller pastes a specification, sees the
 * tools an agent would actually get, prices each one — free, paid, or a mix —
 * and gets a URL. Everything else in the app exists to serve what happens here.
 *
 * The preview step is not decoration. Shaping is lossy on purpose: operations
 * are ranked, capped, and sometimes dropped, and a seller who finds that out
 * *after* publishing has been failed by the tool. So the preview writes nothing,
 * shows exactly what was kept, and says plainly what was left behind.
 */

interface PreviewTool {
  name: string;
  title: string;
  description: string;
  method: string;
  path: string;
  arguments: string[];
  required: string[];
  read_only: boolean;
  destructive: boolean;
}

interface Preview {
  api: { title: string; version: string; openapi: string; base_url: string };
  tools: PreviewTool[];
  context: { tool_count: number; payload_bytes: number; approx_tokens: number };
  dropped: { count: number; truncated: number };
}

interface Published {
  server: { slug: string; url: string; tool_count: number; free_tools: number; paid_tools: number };
}

/** Default asking price for a paid tool: 0.0009 ℏ. */
const DEFAULT_PRICE = "90000";

export function PublishForm({
  accountId,
  verified,
  funded,
  credentialLabel = "verification",
}: {
  accountId: string;
  verified: boolean;
  funded: boolean;
  credentialLabel?: string;
}) {
  const [specUrl, setSpecUrl] = useState("https://api.weather.gov/openapi.json");
  const [maxTools, setMaxTools] = useState("8");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [published, setPublished] = useState<Published | null>(null);

  /** Price per tool name, in tinybars. "0" means the tool is published free. */
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [publishing, setPublishing] = useState(false);

  const blocked = !accountId || !verified || !funded;

  async function runPreview(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setPreview(null);
    setPublished(null);
    try {
      const response = await fetch("/api/mcp/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spec_url: specUrl.trim(),
          max_tools: Math.max(1, Math.min(40, Number(maxTools) || 8)),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Could not read that specification.");
        return;
      }
      setPreview(body as Preview);
      // Everything starts paid at the default; the seller marks the free ones.
      const seeded: Record<string, string> = {};
      for (const tool of (body as Preview).tools) seeded[tool.name] = DEFAULT_PRICE;
      setPrices(seeded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setLoading(false);
    }
  }

  async function publish() {
    if (!preview) return;
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch("/api/mcp/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          spec_url: specUrl.trim(),
          name: preview.api.title,
          price_amount: DEFAULT_PRICE,
          price_unit: "per_call",
          // An unfinished field is not a price. Anything left blank falls back
          // to the default rather than being rejected by the API's validation.
          price_overrides: Object.fromEntries(
            Object.entries(prices).map(([name, value]) => [
              name,
              value === "" ? DEFAULT_PRICE : value,
            ]),
          ),
          max_tools: preview.tools.length,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Publishing failed.");
        return;
      }
      setPublished(body as Published);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  }

  const freeCount = preview
    ? preview.tools.filter((tool) => (prices[tool.name] ?? DEFAULT_PRICE) === "0").length
    : 0;

  /* ------------------------------------------------------------ published */

  if (published) {
    return (
      <div className="space-y-4">
        <Callout tone="ok" title="Published">
          <span className="block">
            {published.server.tool_count} tools are live —{" "}
            {published.server.free_tools} free, {published.server.paid_tools} paid.
          </span>
        </Callout>

        <div className="well rounded-none p-1.5">
          <div className="px-3 py-2.5">
            <Legend className="text-[10px]">Give an agent this URL</Legend>
          </div>
          <p className="overflow-x-auto whitespace-nowrap rounded-none bg-black/45 px-4 py-3 font-mono text-[13px] text-ink shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
            {published.server.url}
          </p>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <a href={`/mcp-servers`}>
            <Button variant="primary">See it in the catalogue</Button>
          </a>
          <Button
            variant="secondary"
            onClick={() => {
              setPublished(null);
              setPreview(null);
            }}
          >
            Publish another
          </Button>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- preview */

  return (
    <div className="space-y-4">
      <form onSubmit={runPreview} className="space-y-3">
        <Field
          label="OpenAPI specification URL"
          htmlFor="spec-url"
          hint="We fetch it, shape the operations into tools, and show you the result before anything is published."
        >
          <Input
            id="spec-url"
            value={specUrl}
            onChange={(event) => setSpecUrl(event.target.value)}
            placeholder="https://api.example.com/openapi.json"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-end">
          <Field
            label="Tool budget"
            htmlFor="max-tools"
            hint="Fewer, better-named tools are chosen more accurately."
          >
            <Input
              id="max-tools"
              value={maxTools}
              onChange={(event) => setMaxTools(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <div className="pb-0.5">
            <Button type="submit" variant="secondary" disabled={loading || !specUrl.trim()}>
              {loading ? <Spinner /> : null}
              {loading ? "Reading the spec…" : "Preview the tools"}
            </Button>
          </div>
        </div>
      </form>

      {error && (
        <Callout tone="bad" title="That did not work">
          {error}
        </Callout>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="scribe" aria-hidden="true" />

          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-ink">{preview.api.title}</p>
              <p className="mt-1 font-mono text-[11px] text-ink-4">
                OpenAPI {preview.api.openapi} · {preview.api.base_url}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4">
              <Badge>{preview.tools.length} tools</Badge>
              <span>≈{preview.context.approx_tokens.toLocaleString()} tokens of context</span>
            </div>
          </div>

          {preview.dropped.truncated > 0 && (
            <Callout tone="warn" title="Over the tool budget">
              {preview.dropped.truncated} further operation
              {preview.dropped.truncated === 1 ? " was" : "s were"} left out. Raise the
              budget to include more, or publish a second server for the rest — a
              catalogue an agent cannot choose from is worse than a smaller one.
            </Callout>
          )}

          {/* --------------------------------------------------- pricing */}

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2.5">
              <Legend>Price each tool</Legend>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4">
                {freeCount} free · {preview.tools.length - freeCount} paid
              </span>
            </div>

            <p className="mb-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
              There is no restriction here: publish everything free, everything paid, or
              any mix. A free tool needs no account from the agent at all, which makes it
              the thing that gets your server adopted.
            </p>

            <ul className="space-y-px">
              {preview.tools.map((tool) => {
                const price = prices[tool.name] ?? DEFAULT_PRICE;
                const free = price === "0";
                // An empty field is "not priced yet", not "free".
                return (
                  <li
                    key={tool.name}
                    className="grid grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-line py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Mono className="text-ink">{tool.name}</Mono>
                        <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-ink-4">
                          {tool.method} {tool.path}
                        </span>
                        {tool.destructive && <Badge>destructive</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-1 text-[12px] text-ink-4">
                        {tool.description}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={free ? "primary" : "ghost"}
                        onClick={() =>
                          setPrices((p) => ({ ...p, [tool.name]: free ? DEFAULT_PRICE : "0" }))
                        }
                      >
                        {free ? "Free" : "Make free"}
                      </Button>
                      <Input
                        aria-label={`Price for ${tool.name} in tinybars`}
                        className="w-[132px] text-right font-mono text-[12px]"
                        value={price}
                        disabled={free}
                        inputMode="numeric"
                        onChange={(event) => {
                          // An emptied field must stay empty. Coercing it to "0"
                          // marks the tool free, which disables the input, and
                          // the seller can no longer type a price into it.
                          const digits = event.target.value.replace(/[^\d]/g, "");
                          setPrices((p) => ({ ...p, [tool.name]: digits }));
                        }}
                      />
                      <span className="w-[76px] shrink-0 font-mono text-[10.5px] text-ink-4">
                        {free ? "—" : `${formatAmount(price === "" ? "0" : price)} ℏ`}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <Button variant="primary" onClick={publish} disabled={publishing || blocked}>
              {publishing ? <Spinner /> : null}
              {publishing ? "Publishing…" : `Publish ${preview.tools.length} tools`}
            </Button>
            {blocked && (
              <span className="text-[12px] text-ink-4">
                Complete World ID {credentialLabel} and the deposit above first.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
