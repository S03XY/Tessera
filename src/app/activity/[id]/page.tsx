import Link from "next/link";
import { notFound } from "next/navigation";
import { getCallById } from "@/lib/repo";
import { disputeWindow, getClaimForCall } from "@/lib/claims";
import { DisputePanel } from "./dispute";
import { query } from "@/lib/db";
import { formatAmount } from "@/lib/money";
import { hashscanTx, hashscanTopic, hashscanAccount, receiptsConfigured } from "@/lib/config";
import {
  Badge,
  Callout,
  KeyValue,
  Mono,
  Page,
  Panel,
  PanelHeader,
  StatusBadge,
} from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Call receipt" };

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const call = await getCallById(id);
  if (!call) notFound();

  const outbox = await query<{
    status: string;
    attempts: number;
    hcs_receipt_id: string | null;
    topic_id: string | null;
    last_error: string | null;
  }>(
    `SELECT status, attempts, hcs_receipt_id, topic_id, last_error
       FROM receipt_outbox WHERE kind = 'call' AND ref_id = $1`,
    [call.id],
  );
  const receipt = outbox[0] ?? null;

  const [claim, window] = await Promise.all([
    getClaimForCall(call.id),
    disputeWindow(call.id),
  ]);

  return (
    <Page>
      <nav className="mb-5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Link href="/activity" className="transition-colors hover:text-ink">
          Activity
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono text-ink-2">{call.id.slice(0, 8)}</span>
      </nav>

      <header className="animate-fade-up flex flex-wrap items-center gap-2.5">
        <h1 className="text-[24px] font-[560] tracking-[-0.02em] text-ink">Call receipt</h1>
        <StatusBadge status={call.status} />
      </header>
      <p className="mt-1.5 text-[13.5px] text-ink-2">
        <Link
          href={`/services/${call.service_slug}`}
          className="text-ink underline-offset-4 hover:underline"
        >
          {call.service_name}
        </Link>{" "}
        from {call.seller_name}
      </p>

      {call.status === "failed" && call.error && (
        <div className="mt-5">
          <Callout tone="bad" title="Delivery failed — no payment was settled">
            {call.error}
          </Callout>
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <Panel className="h-fit overflow-hidden">
          <PanelHeader title="Payment" />
          <KeyValue
            items={[
              {
                label: "Quoted",
                value: <Mono>{formatAmount(call.quoted_amount)} ℏ</Mono>,
              },
              {
                label: "Paid",
                value: (
                  <Mono className="text-ink">
                    {call.paid_amount ? `${formatAmount(call.paid_amount)} ℏ` : "—"}
                  </Mono>
                ),
              },
              {
                label: "Units billed",
                value: <Mono>{call.units ? Number(call.units).toLocaleString() : "—"}</Mono>,
              },
              {
                label: "Payer",
                value: call.payer_account ? (
                  <a
                    href={hashscanAccount(call.payer_account)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[12px] text-accent underline-offset-4 hover:underline"
                  >
                    {call.payer_account}
                  </a>
                ) : (
                  <Mono>—</Mono>
                ),
              },
              {
                label: "Transaction",
                value: call.payment_tx ? (
                  <a
                    href={hashscanTx(call.payment_tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-[12px] text-accent underline-offset-4 hover:underline"
                  >
                    {call.payment_tx}
                  </a>
                ) : (
                  <Mono>—</Mono>
                ),
              },
            ]}
          />
        </Panel>

        <Panel className="h-fit overflow-hidden">
          <PanelHeader title="Delivery" />
          <KeyValue
            items={[
              { label: "HTTP status", value: <Mono>{call.http_status ?? "—"}</Mono> },
              {
                label: "Latency",
                value: <Mono>{call.latency_ms ? `${call.latency_ms} ms` : "—"}</Mono>,
              },
              {
                label: "Requested",
                value: <Mono>{new Date(call.created_at).toLocaleString()}</Mono>,
              },
              {
                label: "Delivered",
                value: (
                  <Mono>
                    {call.delivered_at ? new Date(call.delivered_at).toLocaleString() : "—"}
                  </Mono>
                ),
              },
            ]}
          />
        </Panel>

        <Panel className="h-fit overflow-hidden lg:col-span-2">
          <PanelHeader
            title="Integrity hashes"
            description="Only these digests go on-chain. The request and response bodies stay in the read model."
          />
          <div className="space-y-3 p-4">
            <HashRow label="Request hash" value={call.request_hash} />
            <HashRow label="Response hash" value={call.response_hash} />
          </div>
        </Panel>

        <Panel className="h-fit overflow-hidden lg:col-span-2">
          <PanelHeader
            title="Consensus receipt"
            description="Written to a Hedera Consensus Service topic after delivery."
            actions={
              call.hcs_receipt_id ? (
                <Badge tone="ok" dot>
                  on topic
                </Badge>
              ) : receipt?.status === "pending" ? (
                <Badge tone="warn" dot>
                  queued
                </Badge>
              ) : (
                <Badge tone="neutral">not written</Badge>
              )
            }
          />
          <div className="p-4">
            {call.hcs_receipt_id ? (
              <p className="text-[12.5px] text-ink-2">
                Receipt{" "}
                <span className="font-mono text-ink">{call.hcs_receipt_id}</span>
                {receipt?.topic_id && (
                  <>
                    {" · "}
                    <a
                      href={hashscanTopic(receipt.topic_id)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline-offset-4 hover:underline"
                    >
                      view topic on HashScan
                    </a>
                  </>
                )}
              </p>
            ) : !receiptsConfigured ? (
              <Callout tone="neutral">
                No HCS topic is configured, so receipts queue instead of being
                written. Set <span className="font-mono">HEDERA_OPERATOR_ID</span>,{" "}
                <span className="font-mono">HEDERA_OPERATOR_KEY</span> and{" "}
                <span className="font-mono">HEDERA_RECEIPT_TOPIC_ID</span> to enable
                them.
              </Callout>
            ) : receipt?.last_error ? (
              <Callout tone="bad" title={`Failed after ${receipt.attempts} attempt(s)`}>
                {receipt.last_error}
              </Callout>
            ) : (
              <p className="text-[12.5px] text-ink-3">
                Queued for the next receipt drain.
              </p>
            )}
          </div>
        </Panel>

        <div className="lg:col-span-2">
          <DisputePanel
            callId={call.id}
            existing={
              claim
                ? {
                    id: claim.id,
                    status: claim.status,
                    reason: claim.reason,
                    resolution: claim.resolution,
                    payout_amount: claim.payout_amount,
                    payout_tx: claim.payout_tx,
                  }
                : null
            }
            disputable={window.disputable}
            reason={window.reason}
          />
        </div>
      </div>
    </Page>
  );
}

function HashRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="mb-1 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
        {label}
      </p>
      <p className="break-all rounded-md border border-line bg-bg-subtle px-2.5 py-2 font-mono text-[11.5px] text-ink-2">
        {value ?? "—"}
      </p>
    </div>
  );
}
