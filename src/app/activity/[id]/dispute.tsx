"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Field,
  Panel,
  PanelHeader,
  Select,
  Textarea,
} from "@/components/ui";
import { formatAmount } from "@/lib/money";

const REASONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "no_response",
    label: "Empty response",
    hint: "Paid, but the body came back empty. Checked automatically against the recorded receipt.",
  },
  {
    value: "timeout",
    label: "Upstream failed",
    hint: "Upstream did not return a success status. Checked automatically.",
  },
  {
    value: "malformed",
    label: "Malformed response",
    hint: "Body was not parseable as the advertised format. Needs review.",
  },
  {
    value: "wrong_data",
    label: "Incorrect data",
    hint: "Response parsed but the values were wrong. Needs review.",
  },
  { value: "other", label: "Other", hint: "Describe the problem in the evidence field." },
];

interface Claim {
  id: string;
  status: string;
  reason: string;
  resolution: string | null;
  payout_amount: string | null;
  payout_tx: string | null;
}

export function DisputePanel({
  callId,
  existing,
  disputable,
  reason,
}: {
  callId: string;
  existing: Claim | null;
  disputable: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState("no_response");
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim | null>(existing);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/calls/${callId}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: selected, evidence: evidence.trim() || undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? `Claim failed with ${response.status}.`);
        return;
      }
      setClaim(body);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (claim) {
    const upheld = claim.status === "upheld";
    return (
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Dispute"
          actions={
            <Badge tone={upheld ? "ok" : claim.status === "rejected" ? "bad" : "warn"} dot>
              {claim.status}
            </Badge>
          }
        />
        <div className="space-y-3 p-4">
          <p className="text-[12.5px] text-ink-2">
            Filed as <span className="font-medium text-ink">{claim.reason.replace(/_/g, " ")}</span>
            {claim.resolution && <> — {claim.resolution}</>}
          </p>
          {upheld && claim.payout_amount && (
            <Callout tone="ok" title={`Refunded ${formatAmount(claim.payout_amount)} ℏ`}>
              Paid back to the buyer out of the seller&apos;s deposit
              {claim.payout_tx ? (
                <>
                  {" "}
                  as <span className="break-all font-mono">{claim.payout_tx}</span>.
                </>
              ) : (
                <>
                  . No transfer was broadcast because the marketplace operator key
                  is not configured; the deposit ledger was still debited.
                </>
              )}
            </Callout>
          )}
          {claim.status === "open" && (
            <Callout tone="warn">
              This reason needs review. A resolver will uphold or reject it, and an
              upheld claim refunds from the seller&apos;s deposit.
            </Callout>
          )}
        </div>
      </Panel>
    );
  }

  if (!disputable) {
    return (
      <Panel className="overflow-hidden">
        <PanelHeader title="Dispute" />
        <p className="px-4 py-4 text-[12.5px] leading-relaxed text-ink-3">
          {reason ?? "This call cannot be disputed."}
        </p>
      </Panel>
    );
  }

  const hint = REASONS.find((option) => option.value === selected)?.hint;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Dispute this call"
        description="An upheld claim refunds you out of the seller's deposit."
      />
      <form onSubmit={submit} className="space-y-3.5 p-4">
        <Field label="Reason" htmlFor="reason" hint={hint}>
          <Select
            id="reason"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {REASONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Evidence"
          htmlFor="evidence"
          hint="Optional. What you expected and what you received."
        >
          <Textarea
            id="evidence"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            maxLength={2000}
            placeholder="The response contained yesterday's rate rather than today's."
          />
        </Field>

        {error && <Callout tone="bad">{error}</Callout>}

        <Button type="submit" variant="danger" loading={submitting}>
          {submitting ? "Filing…" : "File claim"}
        </Button>
      </form>
    </Panel>
  );
}
