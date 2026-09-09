import Link from "next/link";
import { Suspense } from "react";
import { discoverServices, marketStats } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import {
  Button,
  EmptyState,
  Lamp,
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
    <section className="flex min-h-[min(100vh,860px)] flex-col justify-between border-b border-black/60 px-6 pb-10 pt-14 shadow-[0_1px_0_var(--edge-hi)] sm:px-10 lg:pt-20">
      <div className="mx-auto w-full max-w-[1240px]">
        <Legend>x402 · Hedera testnet</Legend>
      </div>

      <div className="mx-auto flex w-full max-w-[1240px] flex-1 items-center py-14">
        <h1 className="text-[clamp(3rem,9vw,8.5rem)] font-semibold leading-[0.93] tracking-[-0.046em] text-ink">
          APIs that bill
          <br />
          by the call,
          <br />
          {/*
            Emphasis by luminance, not hue. Dropping the counter-clause two
            steps down the ink ladder is the only contrast device a monochrome
            system has, and it does the work a coloured span used to do.
          */}
          <span className="text-ink-4">not by the seat.</span>
        </h1>
      </div>

      <div className="mx-auto w-full max-w-[1240px]">
        <div aria-hidden="true" className="scribe mb-7" />
        <div className="grid gap-x-12 gap-y-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <p className="max-w-xl text-[15px] leading-relaxed text-ink-2">
            Sellers publish metered endpoints. Agents discover them over plain HTTP,
            pay inside the request, and get a response. No signup, no API key, no
            subscription — the{" "}
            <span className="font-mono text-[13.5px] text-ink">402</span> status code
            does the negotiating.
          </p>

          <div className="flex flex-wrap items-center gap-2.5">
            <Link href="/services">
              <Button variant="primary">Browse services</Button>
            </Link>
            <Link href="/agent">
              <Button variant="secondary">Run the buyer agent</Button>
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
    { label: "Active services", value: stats.services.toLocaleString() },
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

/* ---------------------------------------------------------------- Exchange */

/*
 * The whole protocol, at actual size. Four exchanges is the entire product,
 * so it is shown literally rather than described in four feature cards.
 */
const EXCHANGE = [
  { dir: "out", line: "GET /x402/ecb-reference-rates", note: "no credentials" },
  { dir: "in", line: "402 Payment Required", note: "0.0100 ℏ · pay to 0.0.7399100" },
  { dir: "out", line: "X-PAYMENT: eyJzaWciOiJ…", note: "signed Hedera transfer" },
  { dir: "in", line: "200 OK", note: "response + receipt on HCS" },
] as const;

function Exchange() {
  return (
    <MarginSection
      legend="The exchange"
      note="One round trip, two requests. The agent never held an API key."
      className="pt-28"
    >
      <div className="well seat-in-late rounded-none p-1.5">
        <div className="flex items-center justify-between px-3 py-2.5">
          <Legend className="text-[10px]">Transcript</Legend>
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.11em] text-ink-4">
            <Lamp state="on" live />
            live
          </span>
        </div>

        <ol className="space-y-px rounded-none bg-black/45 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
          {EXCHANGE.map((step) => (
            <li
              key={step.line}
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
    title: "Agent requests",
    body: "A plain GET with no credentials attached.",
    code: "GET /x402/ecb-reference-rates",
  },
  {
    n: "02",
    title: "Gateway quotes",
    body: "402 with the price, asset and pay-to account.",
    code: "402 Payment Required",
  },
  {
    n: "03",
    title: "Agent pays",
    body: "Signs a Hedera transfer, retries with X-PAYMENT.",
    code: "X-PAYMENT: <base64>",
  },
  {
    n: "04",
    title: "Gateway settles",
    body: "Blocky402 settles, upstream runs, response returns.",
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
    <MarginSection legend="The payment flow" className="pt-28">
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
  // per_call only: comparing an atomic per_row price against a per_call price
  // would rank a cheap-looking row feed above an actually cheaper call.
  const services = await discoverServices({
    limit: 6,
    unit: "per_call",
    payableOnly: true,
  });

  return (
    <MarginSection
      legend="Rate card"
      note="Ranked by price, then by observed success rate — the order the agent uses."
      className="pt-28"
    >
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Lowest price per call"
          actions={
            <Link href="/services">
              <Button size="sm" variant="ghost">
                All services →
              </Button>
            </Link>
          }
        />
        {services.length === 0 ? (
          <EmptyState
            title="No services listed yet"
            description="Run npm run db:seed to load the demo sellers, or list one from the seller console."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
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
                    <span className="tnum font-mono text-[13px] text-ink">
                      {formatAmount(service.price_amount, service.asset_decimals)}
                    </span>
                    <span className="ml-1 font-mono text-[11px] text-ink-3">ℏ</span>
                  </Td>
                  <Td className="whitespace-nowrap pl-0 font-mono text-[10.5px] uppercase tracking-[0.07em] text-ink-4">
                    /{PRICE_UNIT_LABEL[service.price_unit]}
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
