import Link from "next/link";
import { recentCalls, marketStats } from "@/lib/repo";
import { formatAmount } from "@/lib/money";
import { hashscanTx } from "@/lib/config";
import {
  EmptyState,
  Mono,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  StatusBadge,
  Table,
  Td,
  Th,
  truncateMiddle,
} from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const [calls, stats] = await Promise.all([recentCalls(50), marketStats()]);

  return (
    <Page>
      <PageHeader
        eyebrow="Settlement log"
        title="Activity"
        description="Every quoted, delivered and failed call. Delivered rows carry the Hedera transaction that paid the seller."
      />

      <div className="mb-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          { label: "Calls quoted", value: stats.calls.toLocaleString() },
          { label: "Delivered", value: stats.settled.toLocaleString() },
          {
            label: "Settled volume",
            value: `${formatAmount(stats.volume)} ℏ`,
          },
          { label: "Active services", value: stats.services.toLocaleString() },
        ].map((item) => (
          <div key={item.label} className="bg-bg px-4 py-3">
            <p className="text-[11.5px] uppercase tracking-[0.05em] text-ink-3">{item.label}</p>
            <p className="tnum mt-1 font-mono text-[17px] text-ink">{item.value}</p>
          </div>
        ))}
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader title="Recent calls" description="Newest first, 50 most recent." />
        {calls.length === 0 ? (
          <EmptyState
            title="No calls recorded yet"
            description="Run the buyer agent, or pay a service directly, and settled calls will appear here with their transaction hashes."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th align="right">Units</Th>
                <Th align="right">Paid</Th>
                <Th>Transaction</Th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id} className="group transition-colors hover:bg-bg-subtle">
                  <Td className="whitespace-nowrap">
                    <Link
                      href={`/activity/${call.id}`}
                      className="text-ink-2 underline-offset-4 group-hover:text-ink group-hover:underline"
                    >
                      {new Date(call.created_at).toLocaleString()}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      href={`/services/${call.service_slug}`}
                      className="text-ink underline-offset-4 hover:underline"
                    >
                      {call.service_name}
                    </Link>
                    <p className="mt-0.5 text-[11.5px] text-ink-4">{call.seller_name}</p>
                  </Td>
                  <Td>
                    <StatusBadge status={call.status} />
                  </Td>
                  <Td align="right">
                    <Mono>{call.units ? Number(call.units).toLocaleString() : "—"}</Mono>
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <Mono className="text-ink">
                      {call.paid_amount ? `${formatAmount(call.paid_amount)} ℏ` : "—"}
                    </Mono>
                  </Td>
                  <Td>
                    {call.payment_tx ? (
                      <a
                        href={hashscanTx(call.payment_tx)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[11.5px] text-accent underline-offset-4 hover:underline"
                        title={call.payment_tx}
                      >
                        {truncateMiddle(call.payment_tx, 12, 8)}
                      </a>
                    ) : (
                      <span className="text-[12px] text-ink-4">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
