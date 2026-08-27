import Link from "next/link";
import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/repo";
import { query } from "@/lib/db";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import { BASE_URL, MIN_DEPOSIT_TINYBARS, hashscanAccount } from "@/lib/config";
import {
  Badge,
  Callout,
  KeyValue,
  Mono,
  Page,
  Panel,
  PanelHeader,
  StatusBadge,
  Table,
  Td,
  Th,
  VerifiedTick,
} from "@/components/ui";
import { QuotePanel } from "./quote-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const service = await getServiceBySlug(slug);
  return { title: service?.name ?? "Service not found" };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const service = await getServiceBySlug(slug);
  if (!service) notFound();

  const underfunded = BigInt(service.seller_deposit) < MIN_DEPOSIT_TINYBARS;
  const payable = service.status === "active" && service.seller_status === "verified" && !underfunded;

  const calls = await query<{
    id: string;
    status: string;
    paid_amount: string | null;
    units: string | null;
    latency_ms: number | null;
    payment_tx: string | null;
    created_at: string;
  }>(
    `SELECT id, status, paid_amount, units, latency_ms, payment_tx, created_at
       FROM calls WHERE service_id = $1 ORDER BY created_at DESC LIMIT 8`,
    [service.id],
  );

  return (
    <Page>
      {/* Breadcrumb ---------------------------------------------------- */}
      <nav className="mb-5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Link href="/services" className="transition-colors hover:text-ink">
          Services
        </Link>
        <span aria-hidden>/</span>
        <Link
          href={`/services?category=${service.category}`}
          className="transition-colors hover:text-ink"
        >
          {service.category}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ink-2">{service.name}</span>
      </nav>

      <header className="animate-fade-up">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-[560] tracking-[-0.02em] text-ink">
            {service.name}
          </h1>
          <StatusBadge status={service.status} />
          <Badge tone="neutral">per {PRICE_UNIT_LABEL[service.price_unit]}</Badge>
        </div>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {service.description}
        </p>
        <p className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
          Sold by
          <Link
            href={`/sellers/${service.seller_account}`}
            className="text-ink-2 underline-offset-4 hover:text-ink hover:underline"
          >
            {service.seller_name}
          </Link>
          {service.seller_status === "verified" && <VerifiedTick />}
        </p>
      </header>

      {!payable && (
        <div className="mt-5">
          <Callout tone="warn" title="This listing cannot currently be paid">
            {service.status !== "active"
              ? `The service is ${service.status}.`
              : service.seller_status !== "verified"
                ? "The seller has not completed World ID verification."
                : "The seller's dispute deposit has fallen below the marketplace minimum, so the gateway refuses new calls."}
          </Callout>
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_380px]">
        {/* Left column ------------------------------------------------- */}
        <div className="space-y-5">
          <QuotePanel
            slug={service.slug}
            priceUnit={service.price_unit}
            priceAmount={service.price_amount}
            decimals={service.asset_decimals}
            payable={payable}
          />

          <Panel className="overflow-hidden">
            <PanelHeader
              title="Recent calls"
              description="Every settled call, indexed from the receipt written at delivery."
            />
            {calls.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12.5px] text-ink-3">
                No calls yet. Be the first buyer.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Status</Th>
                    <Th align="right">Units</Th>
                    <Th align="right">Paid</Th>
                    <Th align="right">Latency</Th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <tr key={call.id} className="transition-colors hover:bg-bg-subtle">
                      <Td>
                        <Link
                          href={`/activity/${call.id}`}
                          className="text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                        >
                          {new Date(call.created_at).toLocaleString()}
                        </Link>
                      </Td>
                      <Td>
                        <StatusBadge status={call.status} />
                      </Td>
                      <Td align="right">
                        <Mono>{call.units ? Number(call.units).toLocaleString() : "—"}</Mono>
                      </Td>
                      <Td align="right">
                        <Mono>
                          {call.paid_amount
                            ? `${formatAmount(call.paid_amount, service.asset_decimals)} ℏ`
                            : "—"}
                        </Mono>
                      </Td>
                      <Td align="right">
                        <Mono>{call.latency_ms ? `${call.latency_ms} ms` : "—"}</Mono>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        {/* Right column ------------------------------------------------ */}
        <div className="space-y-5">
          <Panel className="overflow-hidden">
            <div className="border-b border-line px-4 py-4">
              <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
                Price
              </p>
              <p className="mt-1.5 flex items-baseline gap-1.5">
                <span className="tnum font-mono text-[24px] font-medium tracking-tight text-ink">
                  {formatAmount(service.price_amount, service.asset_decimals)}
                </span>
                <span className="text-[15px] text-ink-2">ℏ</span>
                <span className="text-[13px] text-ink-3">
                  / {PRICE_UNIT_LABEL[service.price_unit]}
                </span>
              </p>
              {service.price_unit !== "per_call" && (
                <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                  Metered. The quote is price × the units you request, and the
                  response is trimmed to what you paid for.
                </p>
              )}
            </div>

            <KeyValue
              items={[
                { label: "Asset", value: <Mono>HBAR ({service.asset})</Mono> },
                {
                  label: "Pay to",
                  value: (
                    <a
                      href={hashscanAccount(service.seller_account)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[12px] text-accent underline-offset-4 hover:underline"
                    >
                      {service.seller_account}
                    </a>
                  ),
                },
                { label: "Network", value: <Mono>hedera:testnet</Mono> },
                { label: "Scheme", value: <Mono>exact (x402 v2)</Mono> },
                { label: "Category", value: service.category },
                {
                  label: "Calls delivered",
                  value: <Mono>{Number(service.calls_ok).toLocaleString()}</Mono>,
                },
                {
                  label: "Success rate",
                  value: (
                    <Mono>
                      {service.success_rate === null
                        ? "—"
                        : `${(service.success_rate * 100).toFixed(0)}%`}
                    </Mono>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader title="Call it yourself" />
            <div className="space-y-3 p-4">
              <div>
                <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
                  Paid endpoint
                </p>
                <pre className="whitespace-pre-wrap break-all rounded-md border border-line bg-bg-subtle px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
                  {`${BASE_URL}/x402/${service.slug}`}
                </pre>
              </div>
              <div>
                <p className="mb-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
                  Get the quote
                </p>
                <pre className="whitespace-pre-wrap break-all rounded-md border border-line bg-bg-subtle px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
                  {`curl -i ${BASE_URL}/x402/${service.slug}${
                    service.price_unit === "per_call" ? "" : "?units=50"
                  }`}
                </pre>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-3">
                The 402 response carries everything needed to pay. See the{" "}
                <Link href="/docs/agent-api" className="text-accent underline-offset-4 hover:underline">
                  agent API reference
                </Link>{" "}
                for the full handshake.
              </p>
            </div>
          </Panel>

          {service.keywords?.length > 0 && (
            <Panel className="overflow-hidden">
              <PanelHeader
                title="Discovery keywords"
                description="Synonyms the seller declared so agents can find this."
              />
              <div className="flex flex-wrap gap-1.5 p-4">
                {service.keywords.map((keyword) => (
                  <Link
                    key={keyword}
                    href={`/services?q=${encodeURIComponent(keyword)}`}
                    className="rounded-full border border-line-2 bg-bg-subtle px-2 py-0.5 text-[11.5px] text-ink-2 transition-colors hover:border-line-3 hover:text-ink"
                  >
                    {keyword}
                  </Link>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </Page>
  );
}
