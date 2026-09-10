import Link from "next/link";
import { Suspense } from "react";
import { listMcpServers, toolsForMcpServer } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import { BASE_URL } from "@/lib/config";
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Legend,
  MarginSection,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Skeleton,
  SkeletonRows,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The MCP page.
 *
 * The argument is one sentence long and everything here serves it: an agent
 * connects to a URL and can buy things. So the page opens with the URL, not
 * with a description of the URL, and the first thing under it is the config
 * block a reader can paste before they have finished deciding whether to.
 */

export default function McpPage() {
  return (
    <Page>
      <PageHeader
        eyebrow="Model Context Protocol · paid tools"
        title="One URL. Any API. Paid by the call."
        description={
          <>
            Sellers hand us an OpenAPI document. We shape it into tools, price each
            one, and host the MCP server. Agents connect to the address and start
            buying — no SDK, no API key, no wallet of their own.
          </>
        }
        actions={
          <>
            <Link href="/onboarding">
              <Button variant="primary">Publish your API</Button>
            </Link>
            <Link href="/agent">
              <Button variant="secondary">Get an agent token</Button>
            </Link>
          </>
        }
      />

      <Connect />

      <Suspense fallback={<PublishedSkeleton />}>
        <Published />
      </Suspense>

      <Shaping />
      <ForSellers />
      <ForAgents />
    </Page>
  );
}

/* ----------------------------------------------------------------- Connect */

const CLIENT_CONFIG = `{
  "mcpServers": {
    "tessera": { "url": "${BASE_URL}/mcp" }
  }
}`;

/* Only needed once an agent wants to call a PAID tool. */
const CLIENT_CONFIG_PAID = `{
  "mcpServers": {
    "tessera": {
      "url": "${BASE_URL}/mcp",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}`;

function Connect() {
  return (
    <MarginSection
      legend="Connect"
      note="Paste this into any MCP client. The catalogue can grow afterwards without the client changing."
      className="pt-4"
    >
      <div className="well rounded-none p-1.5">
        <div className="flex items-center justify-between px-3 py-2.5">
          <Legend className="text-[10px]">claude_desktop_config.json</Legend>
          <span className="font-mono text-[10px] uppercase tracking-[0.11em] text-ink-4">
            streamable http
          </span>
        </div>
        <pre className="overflow-x-auto rounded-none bg-black/45 p-4 font-mono text-[12.5px] leading-relaxed text-ink-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          {CLIENT_CONFIG}
        </pre>
        <p className="px-3 py-2.5 text-[12px] leading-relaxed text-ink-4">
          No token. Free tools work exactly like this. To call a paid tool, add one
          header:
        </p>
        <pre className="overflow-x-auto rounded-none bg-black/45 p-4 font-mono text-[12.5px] leading-relaxed text-ink-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          {CLIENT_CONFIG_PAID}
        </pre>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          {
            k: "Five tools, fixed",
            v: "search_services, describe_service, call_service, get_spend_authority and get_balance. The catalogue is a tool call, not a tool list, so ten thousand tools cost the same context as ten.",
          },
          {
            k: "Free tools need no account",
            v: "Searching and pricing cost nothing, and a tool the seller published free is callable with no token and no balance at all.",
          },
          {
            k: "Failures are refunded",
            v: "If the seller errors or times out, nothing settles and your balance is returned in full, on the same request.",
          },
        ].map((item) => (
          <div key={item.k} className="seat-in min-w-0">
            <div aria-hidden="true" className="mb-3 h-8 w-[3px] bg-ink" />
            <p className="text-[13px] font-medium text-ink">{item.k}</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">{item.v}</p>
          </div>
        ))}
      </div>
    </MarginSection>
  );
}

/* --------------------------------------------------------------- Published */

async function Published() {
  const servers = await listMcpServers();

  const withTools = await Promise.all(
    servers.map(async (server) => ({
      server,
      tools: await toolsForMcpServer(server.id),
    })),
  );

  return (
    <MarginSection
      legend="Published servers"
      note="Each was generated from the seller's own specification. None of them wrote a line of MCP."
      className="pt-28"
    >
      {withTools.length === 0 ? (
        <EmptyState
          title="No MCP servers published yet"
          description="Publish an API and its tools appear here, callable by any agent."
          action={
            <Link href="/onboarding">
              <Button variant="secondary">Publish an API</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          {withTools.map(({ server, tools }) => (
            <Panel key={server.id}>
              <PanelHeader
                title={server.name}
                actions={
                  <span className="font-mono text-[11px] text-ink-4">
                    {tools.length} tool{tools.length === 1 ? "" : "s"}
                  </span>
                }
              />
              <div className="px-4 pb-4 pt-3">
                <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
                  {server.description}
                </p>

                <p className="well mt-3.5 overflow-x-auto whitespace-nowrap rounded-none px-3 py-2 font-mono text-[12px] text-ink">
                  {BASE_URL}/mcp/{server.slug}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4">
                  <Badge>{server.seller_name}</Badge>
                  {server.spec_version && <span>v{server.spec_version}</span>}
                  {server.spec_hash && <span>sha {server.spec_hash.slice(0, 8)}</span>}
                </div>

                {tools.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <Table>
                      <thead>
                        <tr>
                          <Th>Tool</Th>
                          <Th>Does</Th>
                          <Th align="right">Price</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {tools.map((tool) => (
                          <tr key={tool.id}>
                            <Td>
                              <span className="font-mono text-[12px] text-ink">
                                {tool.tool_name}
                              </span>
                            </Td>
                            <Td>
                              <span className="line-clamp-1 text-[12px] text-ink-3">
                                {tool.description}
                              </span>
                            </Td>
                            <Td align="right">
                              <span className="font-mono text-[12px] text-ink-2">
                                {formatAmount(tool.price_amount, tool.asset_decimals)} ℏ
                                <span className="text-ink-4">
                                  {" "}
                                  / {PRICE_UNIT_LABEL[tool.price_unit]}
                                </span>
                              </span>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </MarginSection>
  );
}

function PublishedSkeleton() {
  return (
    <MarginSection legend="Published servers" className="pt-28">
      <Panel>
        <div className="p-4">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="mt-3 h-3 w-full max-w-xl opacity-60" />
          <SkeletonRows rows={4} className="mt-5" />
        </div>
      </Panel>
    </MarginSection>
  );
}

/* ----------------------------------------------------------------- Shaping */

/*
 * The one claim on this page that is not obvious, so it gets its own section:
 * converting an API to MCP is easy and converting it *well* is the product.
 */
const SHAPING = [
  {
    n: "01",
    title: "Curate, don't transcribe",
    body:
      "A 200-operation API becomes 200 tool definitions, sent to the model on every " +
      "turn. Tool selection collapses long before the context window does. We rank " +
      "operations, cap the set, and tell the seller exactly what was left out.",
  },
  {
    n: "02",
    title: "Flatten the arguments",
    body:
      "OpenAPI splits arguments across path, query, header and body. A model asked " +
      "to fill four nested objects fills them wrong. Tools take one flat object; " +
      "the split is remembered on our side.",
  },
  {
    n: "03",
    title: "Write for a model",
    body:
      "Descriptions are aimed at something choosing between tools, not at someone " +
      "reading reference docs — and each one states its own price, so cost is " +
      "visible at the moment of the decision.",
  },
  {
    n: "04",
    title: "Bound everything",
    body:
      "Recursive schemas, 400-value enums, thirty-level nesting: all legal, all " +
      "ruinous. Every dimension a published document can be unbounded in is capped " +
      "before an agent ever sees it.",
  },
];

function Shaping() {
  return (
    <MarginSection
      legend="The shaping step"
      note="Generating an MCP server from a spec is a weekend project. Generating one an agent can actually use is the work."
      className="pt-28"
    >
      <ol className="grid gap-x-6 gap-y-9 sm:grid-cols-2">
        {SHAPING.map((item) => (
          <li key={item.n} className="seat-in min-w-0">
            <div aria-hidden="true" className="mb-4 h-11 w-[3px] bg-ink" />
            <div className="scribe flex items-baseline gap-3 pb-2.5">
              <span className="engraved font-mono text-[20px] font-semibold tracking-[-0.02em] text-ink-4">
                {item.n}
              </span>
              <span className="text-[13px] font-medium text-ink">{item.title}</span>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{item.body}</p>
          </li>
        ))}
      </ol>
    </MarginSection>
  );
}

/* --------------------------------------------------------------- Audiences */

function ForSellers() {
  return (
    <MarginSection
      legend="If you have an API"
      note="Three fields and a price. You keep hosting it; we never see your traffic except the calls we paid you for."
      className="pt-28"
    >
      <div className="well rounded-none p-1.5">
        <div className="px-3 py-2.5">
          <Legend className="text-[10px]">POST /api/mcp/publish</Legend>
        </div>
        <pre className="overflow-x-auto rounded-none bg-black/45 p-4 font-mono text-[12.5px] leading-relaxed text-ink-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
{`{
  "account_id":   "0.0.10247727",
  "spec_url":     "https://api.example.com/openapi.json",
  "price_amount": "90000",
  "price_unit":   "per_call"
}`}
        </pre>
      </div>

      <Callout tone="neutral" title="What you get back">
        A hosted MCP server at <span className="font-mono text-[12px]">/mcp/your-api</span>,
        one priced listing per tool, and payment per call settled to your Hedera
        account. Preview the shaping first with{" "}
        <span className="font-mono text-[12px]">POST /api/mcp/preview</span> — it writes
        nothing and shows you the tools, their context cost, and every operation that
        did not make the cut.
      </Callout>

      <p className="mt-5 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
        The same gate as any other listing applies: prove you are a distinct human with
        World ID, and put a refundable dispute deposit at risk. A buyer who is sold a
        broken response can claim against it, and an upheld claim is paid out of that
        deposit. Publishing forty tools does not dilute the guarantee — every one of
        them is backed by it.
      </p>
    </MarginSection>
  );
}

function ForAgents() {
  return (
    <MarginSection
      legend="If you are an agent"
      note="Register once, fund a balance, spend under caps your owner sets and can revoke."
      className="pt-28"
    >
      <div className="well rounded-none p-1.5">
        <div className="px-3 py-2.5">
          <Legend className="text-[10px]">A session, end to end</Legend>
        </div>
        <ol className="space-y-px rounded-none bg-black/45 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          {[
            { dir: "out", line: "search_services({ query: \"weather alerts\" })", note: "free" },
            { dir: "in", line: "10 listings, cheapest first, with prices", note: "no charge" },
            { dir: "out", line: "call_service({ slug, max_price: \"500000\" })", note: "ceiling set" },
            { dir: "in", line: "200 + data + settlement tx", note: "0.0009 ℏ settled" },
          ].map((step) => (
            <li key={step.line} className="flex min-w-0 items-baseline gap-3 px-3 py-3">
              <span
                aria-hidden="true"
                className={
                  step.dir === "out"
                    ? "w-3 shrink-0 font-mono text-[12px] text-ink-4"
                    : "w-3 shrink-0 font-mono text-[12px] text-ink"
                }
              >
                {step.dir === "out" ? "▸" : "◂"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">
                {step.line}
              </span>
              <span className="hidden shrink-0 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4 sm:block">
                {step.note}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <Callout tone="accent" title="Why you do not need a wallet">
        No MCP client can sign a Hedera transfer, and handing one a private key would be
        worse than the problem. Instead you fund a balance from your own wallet in a
        transaction anyone can check, and the marketplace signs each call against it —
        bounded by a per-call cap, a daily cap, and a free-tool allowance keyed to the human
        revoke in one transaction without our cooperation. Every movement is written to
        an append-only ledger you can replay against your own balance at{" "}
        <span className="font-mono text-[12px]">GET /api/agents/me</span>.
      </Callout>
    </MarginSection>
  );
}
