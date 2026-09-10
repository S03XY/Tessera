import Link from "next/link";
import { Suspense } from "react";
import { discoverServices, marketStats } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import { BASE_URL } from "@/lib/config";
import { HeroPlate } from "@/components/hero-plate";
import {
  Button,
  EmptyState,
  Legend,
  MarginSection,
  MarqueeBand,
  Panel,
  PanelHeader,
  Readout,
  Skeleton,
  SkeletonRows,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <>
      <Statement />
      <Suspense fallback={<ReadoutStripSkeleton />}>
        <ReadoutStrip />
      </Suspense>
      <div className="mx-auto w-full max-w-[1240px] px-6 sm:px-10">
        <Wire />
        <Exchange />
        <Stations />
      </div>

      {/* The band is the section break; it needs the full width to work. */}
      <MarqueeBand className="mt-28" />

      <div className="mx-auto w-full max-w-[1240px] px-6 pb-28 sm:px-10">
        <Suspense fallback={<RateCardSkeleton />}>
          <RateCard />
        </Suspense>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- Statement */

/*
 * The opening screen is a title page, not a hero: one sentence at display
 * scale, its supporting copy and its actions pinned to the bottom edge of the
 * viewport. Nothing is centred and nothing is boxed — the type and two rules
 * carry the whole composition.
 */
function Statement() {
  return (
    <section className="relative isolate flex min-h-[min(100vh,860px)] flex-col justify-between border-b border-black/60 px-6 pb-10 pt-14 shadow-[0_1px_0_var(--edge-hi)] sm:px-10 lg:pt-20">
      <HeroPlate />

      <div className="relative z-10 mx-auto w-full max-w-[1240px]">
        <Legend>x402 · Hedera testnet</Legend>
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-[1240px] flex-1 items-center py-14">
        <h1 id="statement-h1" className="text-[clamp(3rem,9vw,8.5rem)] font-semibold leading-[0.93] tracking-[-0.046em] text-ink">
          Any API.
          <br />
          An MCP server.
          <br />
          {/*
            Emphasis by luminance, not hue. Dropping the counter-clause two
            steps down the ink ladder is the only contrast device a monochrome
            system has, and it does the work a coloured span used to do.
          */}
          <span className="text-ink-4">Priced per tool.</span>
        </h1>
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[1240px]">
        <div aria-hidden="true" className="scribe mb-7" />
        <div className="grid gap-x-12 gap-y-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <p className="max-w-xl text-[15px] leading-relaxed text-ink-2">
            Upload an API. We shape it into{" "}
            <span className="font-mono text-[13.5px] text-ink">MCP</span> tools and host the
            server. You price each tool on its own — free, paid, or a mix — and agents
            connect to the address and call it. Free tools need no account at all; paid
            ones settle on Hedera inside the request.
          </p>

          <div className="flex flex-wrap items-center gap-2.5">
            <Link href="/mcp-servers">
              <Button variant="primary">Connect over MCP</Button>
            </Link>
            <Link href="/onboarding">
              <Button variant="secondary">Publish your API</Button>
            </Link>
            <Link
              href="/docs/agent-api"
              className="ml-1 font-mono text-[11px] uppercase tracking-[0.11em] text-ink-3 transition-colors hover:text-ink"
            >
              Agent API ↗
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- Readout strip */

/*
 * The gauge cluster, full-bleed and hard against the statement above it.
 * These five figures were a sidebar panel competing with the price list for
 * the same column; as a strip they read as instrumentation.
 */
async function ReadoutStrip() {
  const stats = await marketStats();

  const items = [
    { label: "Callable tools", value: stats.services.toLocaleString() },
    { label: "Verified sellers", value: stats.sellers.toLocaleString() },
    { label: "Calls quoted", value: stats.calls.toLocaleString() },
    { label: "Calls delivered", value: stats.settled.toLocaleString() },
    { label: "Settled volume", value: formatAmount(stats.volume), suffix: "ℏ" },
  ];

  return (
    <section
      aria-label="Marketplace totals"
      className="border-b border-black/60 bg-bg px-6 shadow-[inset_0_1px_0_var(--edge-hi),0_1px_0_var(--edge-hi)] sm:px-10"
    >
      <dl className="mx-auto grid w-full max-w-[1240px] grid-cols-2 divide-x divide-y divide-line md:grid-cols-3 md:divide-y-0 lg:grid-cols-5">
        {items.map((item) => (
          <Readout
            key={item.label}
            label={item.label}
            value={item.value}
            suffix={item.suffix}
            className="first:pl-0 last:pr-0"
          />
        ))}
      </dl>
    </section>
  );
}

function ReadoutStripSkeleton() {
  return (
    <section className="border-b border-black/60 bg-bg px-6 shadow-[inset_0_1px_0_var(--edge-hi),0_1px_0_var(--edge-hi)] sm:px-10">
      <div className="mx-auto grid w-full max-w-[1240px] grid-cols-2 divide-x divide-y divide-line md:grid-cols-3 md:divide-y-0 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="px-4 py-3.5 first:pl-0 last:pr-0">
            <Skeleton className="h-[19px] w-20" />
            <Skeleton className="mt-2.5 h-2.5 w-24 opacity-60" />
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- Wire */

/*
 * The MCP argument, made concrete before it is made.
 *
 * The claim — an agent connects to one address and can buy anything in the
 * catalogue — is easy to write and easy to disbelieve. So the section leads
 * with the config block rather than the sentence, and puts the four tools
 * immediately under it: the entire surface an agent has to learn, at actual
 * size, next to the thing you paste to get it.
 */
const MCP_TOOLS = [
  { name: "search_services", note: "free" },
  { name: "describe_service", note: "free" },
  { name: "call_service", note: "priced per tool" },
  { name: "get_spend_authority", note: "free" },
  { name: "get_balance", note: "free" },
] as const;

function Wire() {
  return (
    <MarginSection
      legend="One connection"
      note="Add the address once. Tools published afterwards are callable without the client changing."
      className="pt-28"
    >
      {/*
        min-w-0 on both tracks and on the panel itself: a grid item defaults to
        min-width:auto, so the monospaced config block below sets the column's
        width from its longest line and pushes the whole document sideways on a
        narrow screen. The <pre> scrolls; without this, the page does.
      */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <div className="well seat-in-late min-w-0 rounded-none p-1.5">
          <div className="flex items-center justify-between px-3 py-2.5">
            <Legend className="text-[10px]">Any MCP client</Legend>
            <span className="font-mono text-[10px] uppercase tracking-[0.11em] text-ink-4">
              streamable http
            </span>
          </div>
          <pre className="overflow-x-auto rounded-none bg-black/45 p-4 font-mono text-[12.5px] leading-relaxed text-ink-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
{`{
  "mcpServers": {
    "tessera": { "url": "${BASE_URL}/mcp" }
  }
}`}
          </pre>
        </div>

        <div className="seat-in min-w-0">
          <Legend className="mb-3">The whole surface</Legend>
          <ul className="space-y-px">
            {MCP_TOOLS.map((tool) => (
              <li
                key={tool.name}
                className="flex items-baseline justify-between gap-3 border-b border-line py-2.5 last:border-0"
              >
                <span className="truncate font-mono text-[12.5px] text-ink">
                  {tool.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.09em] text-ink-4">
                  {tool.note}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
            Five tools, whatever the catalogue&nbsp;holds. Discovery is a call, not a
            list, so a thousand tools cost an agent no more context than&nbsp;ten.
          </p>
        </div>
      </div>
    </MarginSection>
  );
}

/* ---------------------------------------------------------------- Exchange */

/*
 * The whole protocol, at actual size. Four exchanges is the entire product,
 * so it is shown literally rather than described in four feature cards.
 */
const EXCHANGE = [
  { dir: "out", line: "tools/call  weather_now", note: "free tool · no account" },
  { dir: "in", line: "200 OK", note: "delivered, nothing charged" },
  { dir: "out", line: "tools/call  ecb_reference_rates", note: "paid tool" },
  { dir: "in", line: "402 Payment Required", note: "0.0012 ℏ · pay to the seller" },
  { dir: "out", line: "X-PAYMENT: eyJzaWciOiJ…", note: "signed Hedera transfer" },
  { dir: "in", line: "200 OK", note: "settled + receipt on HCS" },
] as const;

function Exchange() {
  return (
    <MarginSection
      legend="One session"
      note="The same server, two tools. Only one of them costs anything, and the agent never held an API key."
      className="pt-28"
    >
      <div className="well seat-in-late rounded-none p-1.5">
        <div className="flex items-center justify-between px-3 py-2.5">
          <Legend className="text-[10px]">Transcript</Legend>
          <span className="font-mono text-[10px] uppercase tracking-[0.11em] text-ink-4">
            example
          </span>
        </div>

        <ol className="space-y-px rounded-none bg-black/45 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          {EXCHANGE.map((step, index) => (
            <li
              // Two steps legitimately read "200 OK", so the line is not a key.
              key={`${index}-${step.line}`}
              className="flex min-w-0 items-baseline gap-3 px-3 py-3"
            >
              {/*
                Direction is carried by the glyph, not by colour: ▸ leaves,
                ◂ returns. Two shapes are enough and they survive greyscale.
              */}
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
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-ink">
                {step.line}
              </span>
              <span className="hidden shrink-0 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4 sm:block">
                {step.note}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </MarginSection>
  );
}

/* ---------------------------------------------------------------- Stations */

const STEPS = [
  {
    n: "01",
    title: "Upload a spec",
    body: "An OpenAPI URL is all we need. Nothing of yours has to change.",
    code: "POST /api/mcp/publish",
  },
  {
    n: "02",
    title: "We shape the tools",
    body: "Operations become named, argument-flattened tools an agent can choose between.",
    code: "64 operations → 10 tools",
  },
  {
    n: "03",
    title: "You price each one",
    body: "Free, paid, or a mix. There is no restriction either way.",
    code: "free  ·  0.0009 ℏ / call",
  },
  {
    n: "04",
    title: "Agents connect and pay",
    body: "Free tools answer immediately. Paid ones settle to you on Hedera.",
    code: "200 OK  +  receipt",
  },
];

/*
 * Four stations on a rail. The numerals are cut oversized into the panel and
 * the code strips are recessed, so each step reads as a labelled station
 * rather than as a card in a grid of cards.
 */
function Stations() {
  return (
    <MarginSection legend="From API to paid tools" className="pt-28">
      <ol className="grid gap-x-6 gap-y-9 sm:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((step) => (
          <li key={step.n} className="seat-in min-w-0">
            {/*
              A phase marker: a short bright bar standing over each station.
              Four of them across the row give the section a beat that four
              equal cards never had.
            */}
            <div aria-hidden="true" className="mb-4 h-11 w-[3px] bg-ink" />
            <div className="scribe flex items-baseline gap-3 pb-2.5">
              <span className="engraved font-mono text-[20px] font-semibold tracking-[-0.02em] text-ink-4">
                {step.n}
              </span>
              <span className="text-[13px] font-medium text-ink">{step.title}</span>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">{step.body}</p>
            <p className="well mt-3.5 truncate rounded-none px-2 py-1.5 font-mono text-[11px] text-ink-2">
              {step.code}
            </p>
          </li>
        ))}
      </ol>
    </MarginSection>
  );
}

/* --------------------------------------------------------------- Rate card */

async function RateCard() {
  // Ordered by price ascending, so the free tools lead — which is the honest
  // shape of the catalogue rather than a merchandising decision.
  const services = await discoverServices({ limit: 7, payableOnly: true });

  return (
    <MarginSection
      legend="The catalogue"
      note="Free tools first, then cheapest — the order an agent optimising for cost actually sees."
      className="pt-28"
    >
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Tools an agent can call today"
          actions={
            <Link href="/services">
              <Button size="sm" variant="ghost">
                All tools →
              </Button>
            </Link>
          }
        />
        {services.length === 0 ? (
          <EmptyState
            title="No tools published yet"
            description="Publish an API to turn it into MCP tools, or run npm run db:seed to load the demo servers."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Seller</Th>
                <Th align="right" className="pr-1.5">
                  Price
                </Th>
                <Th className="pl-0" />
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.id} className="lit">
                  <Td>
                    <Link
                      href={`/services/${service.slug}`}
                      className="font-medium text-ink underline-offset-4 hover:underline"
                    >
                      {service.name}
                    </Link>
                    <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-4">
                      {service.description}
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap text-[12.5px]">
                    {service.seller_name}
                  </Td>
                  <Td align="right" className="whitespace-nowrap pr-1.5">
                    {BigInt(service.price_amount) === 0n ? (
                      <span className="font-mono text-[11px] uppercase tracking-[0.09em] text-ink">
                        free
                      </span>
                    ) : (
                      <>
                        <span className="tnum font-mono text-[13px] text-ink">
                          {formatAmount(service.price_amount, service.asset_decimals)}
                        </span>
                        <span className="ml-1 font-mono text-[11px] text-ink-3">ℏ</span>
                      </>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap pl-0 font-mono text-[10.5px] uppercase tracking-[0.07em] text-ink-4">
                    {BigInt(service.price_amount) === 0n
                      ? ""
                      : `/${PRICE_UNIT_LABEL[service.price_unit]}`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </MarginSection>
  );
}

function RateCardSkeleton() {
  return (
    <MarginSection legend="Rate card" className="pt-28">
      <Panel className="overflow-hidden">
        <PanelHeader title="Lowest price per call" />
        <SkeletonRows rows={6} />
      </Panel>
    </MarginSection>
  );
}
