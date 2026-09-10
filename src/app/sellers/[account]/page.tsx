import Link from "next/link";
import { notFound } from "next/navigation";
import { getSellerByAccount, listServicesForSeller } from "@/lib/repo";
import { formatAmount, isFreePrice, PRICE_UNIT_LABEL } from "@/lib/money";
import { MIN_DEPOSIT_TINYBARS, hashscanAccount } from "@/lib/config";
import { readDepositUnits, hashscanToken } from "@/lib/tokenized-deposit";
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
  VerificationBadge,
} from "@/components/ui";
import { describeWorld } from "@/lib/world";

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

  /**
   * When this seller's deposit has been tokenized, the bond is the authority
   * on how many units they hold, so read it rather than trusting our own
   * column. Returns null if the relay is unreachable; the panel says so and
   * the page still renders.
   */
  const bond =
    seller.ats_token_id && seller.ats_holder_address
      ? await readDepositUnits(seller.ats_token_id, seller.ats_holder_address)
      : null;

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

      <header className="animate-seat">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[26px] font-[560] tracking-[-0.02em] text-ink">
            {seller.display_name}
          </h1>
          {seller.verification_status === "verified" ? (
            <VerificationBadge credential={seller.world_credential} />
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
            This account has not completed World ID {describeWorld().credential_label}. Verification is
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

      <div className="mt-6 grid min-w-0 items-start gap-5 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
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
                      {isFreePrice(service.price_amount) ? (
                        <Mono className="text-ink">free</Mono>
                      ) : (
                        <>
                          <Mono className="text-ink">
                            {formatAmount(service.price_amount, service.asset_decimals)} ℏ
                          </Mono>
                          <span className="ml-1 text-[11.5px] text-ink-4">
                            /{PRICE_UNIT_LABEL[service.price_unit]}
                          </span>
                        </>
                      )}
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
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-none bg-bg-inset">
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

          {seller.ats_token_id && (
            <Panel className="h-fit overflow-hidden">
              <PanelHeader
                title="Tokenized deposit"
                description="An ERC-1400 security token issued through Hedera's Asset Tokenization Studio."
              />
              <div className="border-b border-line px-4 py-4">
                {bond ? (
                  <>
                    <p className="tnum font-mono text-[22px] font-medium text-ink">
                      {bond.units.toLocaleString()}{" "}
                      <span className="text-[15px] text-ink-3">units</span>
                    </p>
                    <p className="mt-2 text-[12px] text-ink-3">
                      Read from the bond itself over the JSON-RPC relay, not from
                      this database. Disputes move these units with an ERC-1400
                      hold, so the marketplace can pay a wronged buyer and can
                      never take the deposit for itself.
                    </p>
                  </>
                ) : (
                  <p className="text-[12.5px] text-ink-3">
                    The balance could not be read from the relay just now. The
                    bond is unaffected; only this reading failed.
                  </p>
                )}
              </div>
              <KeyValue
                items={[
                  {
                    label: "Bond",
                    value: (
                      <a
                        href={hashscanToken(seller.ats_token_id)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[12.5px] text-accent underline-offset-4 hover:underline"
                      >
                        {seller.ats_token_id}
                      </a>
                    ),
                  },
                  {
                    label: "Holder",
                    value: (
                      <Mono className="text-[11.5px]">
                        {seller.ats_holder_address
                          ? `${seller.ats_holder_address.slice(0, 10)}…${seller.ats_holder_address.slice(-6)}`
                          : "—"}
                      </Mono>
                    ),
                  },
                ]}
              />
            </Panel>
          )}

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
