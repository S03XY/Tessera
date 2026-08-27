import Link from "next/link";
import { Suspense } from "react";
import { discoverServices, marketStats } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import {
  Badge,
  Button,
  EmptyState,
  Mono,
  Panel,
  PanelHeader,
  SkeletonRows,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <>
      <Hero />
      <div className="mx-auto w-full max-w-[1120px] px-5 pb-14 sm:px-8">
        <Handshake />
        <div className="mt-10 grid gap-5 lg:grid-cols-[1fr_320px]">
          <Suspense fallback={<CheapestSkeleton />}>
            <CheapestServices />
          </Suspense>
          <Suspense fallback={<StatsSkeleton />}>
            <MarketPanel />
          </Suspense>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------- Hero */

function Hero() {
  return (
    <section className="border-b border-line bg-bg">
      <div className="mx-auto w-full max-w-[1120px] px-5 py-16 sm:px-8 sm:py-20">
        <div className="max-w-2xl animate-fade-up">
          <Badge tone="accent">x402 · Hedera testnet</Badge>
          <h1 className="mt-4 text-[40px] font-[560] leading-[1.08] tracking-[-0.03em] text-ink sm:text-[46px]">
            APIs that bill by the call,
            <br />
            not by the seat.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-2">
            Sellers publish metered endpoints. Agents discover them over plain HTTP,
            pay inside the request, and get a response. No signup, no API key, no
            subscription — the <Mono className="text-ink">402</Mono> status code does
            the negotiating.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Link href="/services">
              <Button variant="primary">Browse services</Button>
            </Link>
            <Link href="/agent">
              <Button variant="secondary">Run the buyer agent</Button>
            </Link>
            <Link
              href="/docs/agent-api"
              className="ml-1 text-[13px] text-ink-3 underline-offset-4 transition-colors hover:text-ink hover:underline"
            >
              Agent API reference
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- Handshake */

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

function Handshake() {
  return (
    <section className="mt-10">
      <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-3">
        The payment flow
      </h2>
      <ol className="stagger mt-3 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <li key={step.n} className="bg-bg p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-ink-4">{step.n}</span>
              <span className="text-[13px] font-medium text-ink">{step.title}</span>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{step.body}</p>
            <p className="mt-3 truncate rounded border border-line bg-bg-subtle px-2 py-1 font-mono text-[11.5px] text-ink-2">
              {step.code}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------- Cheapest services */

async function CheapestServices() {
  const services = await discoverServices({ limit: 6 });

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Lowest price per call"
        description="Ranked by price, then by observed success rate — the order the agent uses."
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
              <Th align="right">Price</Th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.id} className="transition-colors hover:bg-bg-subtle">
                <Td>
                  <Link
                    href={`/services/${service.slug}`}
                    className="font-medium text-ink underline-offset-4 hover:underline"
                  >
                    {service.name}
                  </Link>
                  <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-3">
                    {service.description}
                  </p>
                </Td>
                <Td>
                  <span className="text-[12.5px]">{service.seller_name}</span>
                </Td>
                <Td align="right">
                  <span className="tnum font-mono text-[12.5px] text-ink">
                    {formatAmount(service.price_amount, service.asset_decimals)} ℏ
                  </span>
                  <span className="ml-1 text-[11.5px] text-ink-4">
                    /{PRICE_UNIT_LABEL[service.price_unit]}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function CheapestSkeleton() {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Lowest price per call" />
      <SkeletonRows rows={6} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ Market */

async function MarketPanel() {
  const stats = await marketStats();

  const items = [
    { label: "Active services", value: stats.services.toLocaleString() },
    { label: "Verified sellers", value: stats.sellers.toLocaleString() },
    { label: "Calls quoted", value: stats.calls.toLocaleString() },
    { label: "Calls delivered", value: stats.settled.toLocaleString() },
    { label: "Settled volume", value: `${formatAmount(stats.volume)} ℏ` },
  ];

  return (
    <Panel className="h-fit overflow-hidden">
      <PanelHeader title="Marketplace" description="Indexed from settled on-chain activity." />
      <dl className="divide-y divide-line">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline justify-between px-4 py-3">
            <dt className="text-[12.5px] text-ink-3">{item.label}</dt>
            <dd className="tnum font-mono text-[13px] text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function StatsSkeleton() {
  return (
    <Panel className="h-fit overflow-hidden">
      <PanelHeader title="Marketplace" />
      <SkeletonRows rows={5} />
    </Panel>
  );
}
