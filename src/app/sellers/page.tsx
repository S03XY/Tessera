import Link from "next/link";
import { listSellers } from "@/lib/repo";
import { formatAmount } from "@/lib/money";
import { MIN_DEPOSIT_TINYBARS, hashscanAccount } from "@/lib/config";
import {
  Badge,
  EmptyState,
  Mono,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Table,
  Td,
  Th,
  VerificationBadge,
  VerifiedTick,
} from "@/components/ui";
import { describeWorld } from "@/lib/world";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sellers" };

export default async function SellersPage() {
  const sellers = await listSellers();

  return (
    <Page>
      <PageHeader
        eyebrow="Supply side"
        title="Sellers"
        description={`Every seller passes World ID ${describeWorld().credential_label} and posts a refundable deposit before listing. The deposit is what a successful dispute is paid from.`}
      />

      <Panel className="overflow-hidden">
        <PanelHeader
          title={`${sellers.length} seller${sellers.length === 1 ? "" : "s"}`}
          description={`Minimum deposit to keep listings live: ${formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ.`}
        />
        {sellers.length === 0 ? (
          <EmptyState title="No sellers registered yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Seller</Th>
                <Th>Verification</Th>
                <Th align="right">Deposit</Th>
                <Th align="right">Services</Th>
                <Th align="right">Delivered</Th>
                <Th align="right">Disputed</Th>
              </tr>
            </thead>
            <tbody>
              {sellers.map((seller) => {
                const deposit = BigInt(seller.deposit_amount);
                const short = deposit < MIN_DEPOSIT_TINYBARS;
                return (
                  <tr key={seller.id} className="group transition-colors hover:bg-bg-subtle">
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/sellers/${seller.account_id}`}
                          className="font-medium text-ink underline-offset-4 group-hover:underline"
                        >
                          {seller.display_name}
                        </Link>
                        {seller.verification_status === "verified" && <VerifiedTick />}
                      </div>
                      <a
                        href={hashscanAccount(seller.account_id)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 block font-mono text-[11.5px] text-ink-4 hover:text-accent"
                      >
                        {seller.account_id}
                      </a>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {seller.verification_status === "verified" ? (
                        <VerificationBadge credential={seller.world_credential} />
                      ) : (
                        <Badge tone="warn" dot>
                          unverified
                        </Badge>
                      )}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <Mono className={short ? "text-bad" : "text-ink"}>
                        {formatAmount(seller.deposit_amount)} ℏ
                      </Mono>
                      {short && (
                        <p className="mt-0.5 text-[11px] text-bad">below minimum</p>
                      )}
                    </Td>
                    <Td align="right">
                      <Mono>{seller.service_count}</Mono>
                    </Td>
                    <Td align="right">
                      <Mono>{Number(seller.calls_ok).toLocaleString()}</Mono>
                    </Td>
                    <Td align="right">
                      <Mono className={Number(seller.calls_disputed) > 0 ? "text-warn" : undefined}>
                        {Number(seller.calls_disputed).toLocaleString()}
                      </Mono>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
