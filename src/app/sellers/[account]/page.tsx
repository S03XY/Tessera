import Link from "next/link";
import { notFound } from "next/navigation";
import { getSellerByAccount, listServicesForSeller } from "@/lib/repo";
import { formatAmount, PRICE_UNIT_LABEL } from "@/lib/money";
import { MIN_DEPOSIT_TINYBARS, hashscanAccount } from "@/lib/config";
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
} from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const seller = await getSellerByAccount(decodeURIComponent(account));
  return { title: seller?.display_name ?? "Seller not found" };
}

export default async function SellerPage({
  params,
}: {
  params: Promise<{ account: string }>;
}) {
  const { account } = await params;
  const seller = await getSellerByAccount(decodeURIComponent(account));
  if (!seller) notFound();

  const services = await listServicesForSeller(seller.id);
  const deposit = BigInt(seller.deposit_amount);
  const short = deposit < MIN_DEPOSIT_TINYBARS;

  const delivered = Number(seller.calls_ok);
  const disputed = Number(seller.calls_disputed);
  const reputation = delivered + disputed > 0 ? delivered / (delivered + disputed) : null;

  return (
    <Page>
      <nav className="mb-5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Link href="/sellers" className="transition-colors hover:text-ink">
          Sellers
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ink-2">{seller.display_name}</span>
      </nav>

      <header className="animate-fade-up">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-[560] tracking-[-0.02em] text-ink">
            {seller.display_name}
          </h1>
          {seller.verification_status === "verified" ? (
            <Badge tone="ok" dot>
              Selfie Check verified
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              unverified
            </Badge>
          )}
        </div>
        <a
          href={hashscanAccount(seller.account_id)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[12.5px] text-accent underline-offset-4 hover:underline"
        >
          {seller.account_id}
        </a>
      </header>

      {seller.verification_status !== "verified" && (
        <div className="mt-5">
          <Callout tone="warn" title="Cannot list services">
            This account has not completed World ID Selfie Check. Verification is
            required before any listing goes live, which is what stops the
            marketplace filling with duplicate sellers.
          </Callout>
        </div>
      )}

      {short && seller.verification_status === "verified" && (
        <div className="mt-5">
          <Callout tone="bad" title="Deposit below the minimum">
            Holding {formatAmount(deposit)} ℏ against a{" "}
            {formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ minimum. The gateway refuses
            new calls to this seller until the deposit is topped up.
          </Callout>
        </div>
      )}

      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[1fr_320px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            title={`${services.length} service${services.length === 1 ? "" : "s"}`}
            description="Listings published by this seller."
          />
          {services.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12.5px] text-ink-3">
              No services listed.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Service</Th>
                  <Th>Status</Th>
                  <Th align="right">Delivered</Th>
                  <Th align="right">Price</Th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id} className="group transition-colors hover:bg-bg-subtle">
                    <Td>
                      <Link
                        href={`/services/${service.slug}`}
                        className="font-medium text-ink underline-offset-4 group-hover:underline"
                      >
                        {service.name}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 max-w-sm text-[12px] text-ink-3">
                        {service.description}
                      </p>
                    </Td>
                    <Td>
                      <StatusBadge status={service.status} />
                    </Td>
                    <Td align="right">
                      <Mono>{Number(service.calls_ok).toLocaleString()}</Mono>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <Mono className="text-ink">
                        {formatAmount(service.price_amount, service.asset_decimals)} ℏ
                      </Mono>
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

        <div className="space-y-5">
          <Panel className="h-fit overflow-hidden">
            <PanelHeader title="Dispute deposit" />
            <div className="border-b border-line px-4 py-4">
              <p className="tnum font-mono text-[22px] font-medium text-ink">
                {formatAmount(deposit)} <span className="text-[15px]">ℏ</span>
              </p>
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-bg-inset">
                <div
                  className={short ? "h-full bg-bad" : "h-full bg-ok"}
                  style={{
                    width: `${Math.min(
                      100,
                      Number((deposit * 100n) / (MIN_DEPOSIT_TINYBARS * 2n)),
                    )}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-[12px] text-ink-3">
                Minimum {formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ. Refunds for upheld
                disputes are paid from this balance.
              </p>
            </div>
            <KeyValue
              items={[
                {
                  label: "Deposit tx",
                  value: <Mono>{seller.deposit_tx ?? "—"}</Mono>,
                },
                {
                  label: "Verified",
                  value: (
                    <Mono>
                      {seller.verified_at
                        ? new Date(seller.verified_at).toLocaleDateString()
                        : "—"}
                    </Mono>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel className="h-fit overflow-hidden">
            <PanelHeader title="Reputation" description="Counted from settled calls." />
            <KeyValue
              items={[
                { label: "Delivered", value: <Mono>{delivered.toLocaleString()}</Mono> },
                {
                  label: "Disputed",
                  value: (
                    <Mono className={disputed > 0 ? "text-warn" : undefined}>
                      {disputed.toLocaleString()}
                    </Mono>
                  ),
                },
                {
                  label: "Refunded",
                  value: <Mono>{Number(seller.calls_refunded).toLocaleString()}</Mono>,
                },
                {
                  label: "Clean rate",
                  value: (
                    <Mono>
                      {reputation === null ? "—" : `${(reputation * 100).toFixed(1)}%`}
                    </Mono>
                  ),
                },
              ]}
            />
          </Panel>
        </div>
      </div>
    </Page>
  );
}
