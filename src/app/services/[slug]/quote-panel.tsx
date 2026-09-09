"use client";

import { useState } from "react";
import { Button, Callout, IndeterminateBar, Panel, PanelHeader, cx } from "@/components/ui";
import { formatAmount } from "@/lib/money";

interface Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface QuoteResult {
  status: number;
  accepts: Accept[];
  resource: { url: string; serviceName?: string };
  error?: string;
}

/**
 * Live 402 handshake. Hits the real gateway, which hits the real facilitator
 * for the fee payer, so what is rendered here is the actual quote an agent
 * would receive — not a mock-up of one.
 */
export function QuotePanel({
  slug,
  priceUnit,
  priceAmount,
  decimals,
  payable,
}: {
  slug: string;
  priceUnit: "per_call" | "per_token" | "per_row";
  priceAmount: string;
  decimals: number;
  payable: boolean;
}) {
  const metered = priceUnit !== "per_call";
  const [units, setUnits] = useState(metered ? "50" : "1");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function requestQuote() {
    setState("loading");
    setMessage(null);
    setQuote(null);

    try {
      const url = new URL(`/x402/${slug}`, window.location.origin);
      if (metered) url.searchParams.set("units", units);

      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();

      if (response.status === 402 && Array.isArray(body.accepts)) {
        setQuote({ status: response.status, ...body });
        setState("done");
        return;
      }

      setMessage(body.message ?? `Gateway returned ${response.status}.`);
      setState("error");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Request failed.");
      setState("error");
    }
  }

  const accept = quote?.accepts?.[0];
  const expected = metered
    ? (BigInt(priceAmount) * BigInt(Number(units) || 1)).toString()
    : priceAmount;

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Request a quote"
        description="Sends an unpaid request and shows the 402 the gateway answers with."
      />

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {metered && (
            <div className="w-40">
              <label
                htmlFor="units"
                className="mb-1.5 block text-[12.5px] font-medium text-ink"
              >
                {priceUnit === "per_token" ? "Token budget" : "Row budget"}
              </label>
              <input
                id="units"
                type="number"
                min={1}
                max={100000}
                value={units}
                onChange={(event) => setUnits(event.target.value)}
                className="h-9 w-full rounded-none border border-line-2 bg-bg px-2.5 text-[13px] text-ink transition-colors hover:border-line-3 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/12"
              />
            </div>
          )}

          <Button
            variant="primary"
            onClick={requestQuote}
            loading={state === "loading"}
            disabled={!payable}
          >
            {state === "loading" ? "Requesting…" : "Request quote"}
          </Button>

          {metered && (
            <p className="pb-2 text-[12px] text-ink-3">
              Expect{" "}
              <span className="tnum font-mono text-ink-2">
                {formatAmount(expected, decimals)} ℏ
              </span>{" "}
              for {Number(units) || 1}{" "}
              {priceUnit === "per_token" ? "tokens" : "rows"}
            </p>
          )}
        </div>

        {!payable && (
          <Callout tone="warn">
            Quotes are disabled because this listing is not currently payable.
          </Callout>
        )}

        {state === "loading" && (
          <div className="space-y-2">
            <IndeterminateBar />
            <div className="space-y-1.5">
              <Step label="GET /x402/{slug}" active />
              <Step label="Gateway checks listing, seller and deposit" active />
              <Step label="Facilitator returns the Hedera fee payer" active />
            </div>
          </div>
        )}

        {state === "error" && message && <Callout tone="bad">{message}</Callout>}

        {state === "done" && accept && (
          <div className="animate-seat space-y-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 font-mono text-[11.5px] font-medium text-warn">
                <TickIcon />
                402 Payment Required
              </span>
              <span className="text-[12px] text-ink-3">
                the gateway is quoting, not refusing
              </span>
            </div>

            <div className="overflow-hidden rounded-none border border-line">
              <dl className="divide-y divide-line text-[12.5px]">
                <Row label="Amount">
                  <span className="tnum font-mono text-ink">
                    {formatAmount(accept.amount, decimals)} ℏ
                  </span>
                  <span className="ml-2 font-mono text-[11.5px] text-ink-4">
                    ({Number(accept.amount).toLocaleString()} tinybars)
                  </span>
                </Row>
                <Row label="Pay to">
                  <span className="font-mono text-ink-2">{accept.payTo}</span>
                </Row>
                <Row label="Asset">
                  <span className="font-mono text-ink-2">
                    {accept.asset === "0.0.0" ? "HBAR (0.0.0)" : accept.asset}
                  </span>
                </Row>
                <Row label="Network">
                  <span className="font-mono text-ink-2">{accept.network}</span>
                </Row>
                <Row label="Scheme">
                  <span className="font-mono text-ink-2">{accept.scheme}</span>
                </Row>
                {typeof accept.extra?.feePayer === "string" && (
                  <Row label="Fee payer">
                    <span className="font-mono text-ink-2">
                      {accept.extra.feePayer as string}
                    </span>
                    <span className="ml-2 text-[11.5px] text-ink-4">
                      facilitator covers gas
                    </span>
                  </Row>
                )}
                <Row label="Expires in">
                  <span className="font-mono text-ink-2">
                    {accept.maxTimeoutSeconds}s
                  </span>
                </Row>
              </dl>
            </div>

            <Callout tone="neutral" title="What an agent does next">
              Signs a Hedera transfer for exactly this amount to{" "}
              <span className="font-mono">{accept.payTo}</span>, base64-encodes the
              signed transaction into an <span className="font-mono">X-PAYMENT</span>{" "}
              header, and repeats the request. The gateway verifies with the
              facilitator, calls the upstream API, settles, and returns the data.
            </Callout>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 bg-bg px-3 py-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Step({ label, active }: { label: string; active: boolean }) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 text-[12px]",
        active ? "text-ink-2" : "text-ink-4",
      )}
    >
      {/* Only the step actually running is lit; the rest sit dark. */}
      <span
        aria-hidden="true"
        className={cx(
          "size-1.5 shrink-0 rounded-full",
          active
            ? "animate-lamp bg-ink shadow-[0_0_5px_rgba(255,255,255,0.55)]"
            : "bg-ink-4/50",
        )}
      />
      {label}
    </div>
  );
}

function TickIcon() {
  return (
    <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
      <path
        d="M2.5 6.2 4.8 8.5 9.5 3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-tick"
      />
    </svg>
  );
}
