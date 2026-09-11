"use client";

import { useCallback, useState } from "react";
import { PublishForm } from "./publish";
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Panel,
  PanelHeader,
  cx,
} from "@/components/ui";

interface Status {
  account_id: string;
  display_name: string;
  verification_status: string;
  deposit_amount: string;
  service_count: string;
}

type StepState = "todo" | "active" | "done";

export function OnboardingFlow({
  setupView,
  chainConfigured,
  treasury,
  minimumDeposit,
  minimumLabel,
}: {
  /** True on `?setup=1`: show the operator's diagnostics rather than a seller's view. */
  setupView: boolean;
  chainConfigured: boolean;
  treasury: string;
  minimumDeposit: string;
  minimumLabel: string;
}) {
  const [accountId, setAccountId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const registered = status?.verification_status === "verified";
  const funded = status ? BigInt(status.deposit_amount) >= BigInt(minimumDeposit) : false;

  const refresh = useCallback(
    async (account = accountId) => {
      if (!account.trim()) return;
      setChecking(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/sellers/status?account_id=${encodeURIComponent(account.trim())}`,
          { cache: "no-store" },
        );
        const body = await response.json();
        setStatus(response.ok ? body.seller : null);
        if (!response.ok && response.status !== 404) {
          setError(body.message ?? "Could not load status.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load status.");
      } finally {
        setChecking(false);
      }
    },
    [accountId],
  );

  /**
   * Registration is idempotent on the account id, so a seller who submits
   * twice updates their display name rather than colliding — and the status
   * refresh afterwards is what advances the step, so the panel always reflects
   * what the server stored rather than what this form hoped it would.
   */
  const register = useCallback(async () => {
    if (!accountId.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      const response = await fetch("/api/sellers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: accountId.trim(),
          display_name: displayName.trim() || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) setError(body.message ?? "Could not register this account.");
      else await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register this account.");
    } finally {
      setRegistering(false);
    }
  }, [accountId, displayName, refresh]);

  return (
    <div className="space-y-4">
      <Step
        index={1}
        title="Identify the seller account"
        state={accountId.trim() ? "done" : "active"}
        description="The Hedera account that will receive payments and hold the dispute deposit."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void refresh();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="w-52">
            <Field label="Account id" htmlFor="account">
              <Input
                id="account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                placeholder="0.0.12345"
              />
            </Field>
          </div>
          <div className="min-w-[200px] flex-1">
            <Field label="Display name" htmlFor="display">
              <Input
                id="display"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Northwind APIs"
              />
            </Field>
          </div>
          <Button type="submit" loading={checking} className="mb-[1px]">
            Check status
          </Button>
        </form>
        {error && (
          <div className="mt-3">
            <Callout tone="bad">{error}</Callout>
          </div>
        )}
        {status && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <span>{status.display_name}</span>
            <Badge tone={registered ? "ok" : "warn"} dot>
              {status.verification_status}
            </Badge>
            <Badge tone={funded ? "ok" : "warn"}>
              deposit {status.deposit_amount === "0" ? "none" : `${status.deposit_amount} tinybars`}
            </Badge>
          </div>
        )}
      </Step>

      <Step
        index={2}
        title="Register the seller account"
        state={registered ? "done" : accountId.trim() ? "active" : "todo"}
        description="Records who payouts go to. Registration on its own lists nothing — the deposit in the next step is the gate."
      >
        {registered ? (
          <Callout tone="ok" title="Registered">
            {status?.display_name} is registered. Post the dispute deposit below
            to make listings callable.
          </Callout>
        ) : (
          <Button
            onClick={() => void register()}
            loading={registering}
            disabled={!accountId.trim()}
          >
            Register this account
          </Button>
        )}
      </Step>

      <Step
        index={3}
        title="Post the dispute deposit"
        state={funded ? "done" : registered ? "active" : "todo"}
        description={`At least ${minimumLabel} held against refunds. An upheld dispute is paid out of this balance.`}
      >
        {!chainConfigured ? (
          setupView ? (
            <Callout tone="warn" title="No treasury configured">
              Set <span className="font-mono">HEDERA_OPERATOR_ID</span> and{" "}
              <span className="font-mono">HEDERA_OPERATOR_KEY</span> so deposits
              can be verified against the mirror node.
            </Callout>
          ) : (
            <Callout tone="warn" title="Deposits are unavailable">
              This marketplace cannot confirm deposits at the moment, so
              listings are paused. Try again shortly.
            </Callout>
          )
        ) : (
          <DepositForm
            accountId={accountId.trim()}
            treasury={treasury}
            minimumLabel={minimumLabel}
            disabled={!registered}
            onDeposited={() => refresh()}
          />
        )}
      </Step>

      <Step
        index={4}
        title="Publish your API as an MCP server"
        state={funded ? "active" : "todo"}
        description="Paste a specification. We shape it into tools, you price each one free or paid, and agents get a URL. Only reachable once both steps above are green — the API refuses a publish from an unregistered or underfunded account."
        last
      >
        <PublishForm
          accountId={accountId.trim()}
          registered={registered}
          funded={funded}
        />
      </Step>
    </div>
  );
}

/* ------------------------------------------------------------------- Step */

function Step({
  index,
  title,
  description,
  state,
  children,
  last = false,
}: {
  index: number;
  title: string;
  description: string;
  state: StepState;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="relative flex gap-4">
      <div className="flex flex-col items-center">
        <span
          className={cx(
            "flex size-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium transition-colors",
            /*
             * The three states are three materials, so they stay legible with
             * no hue: a finished step is seated into the panel, the active one
             * is the bright part that has been raised, and an untouched step
             * is an unfinished blank.
             */
            state === "done"
              ? "well border-transparent text-ink-2"
              : state === "active"
                ? "machined-bright struck border-transparent font-semibold shadow-[0_0_0_4px_var(--color-accent-soft),0_2px_6px_rgba(0,0,0,0.7)]"
                : "border-line-2 bg-bg-inset text-ink-4",
          )}
        >
          {state === "done" ? (
            <svg viewBox="0 0 12 12" className="size-3.5" aria-hidden="true">
              <path
                d="M2.5 6.2 4.8 8.5 9.5 3.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            index
          )}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>

      <Panel className={cx("mb-1 flex-1 overflow-hidden", state === "todo" && "opacity-65")}>
        <PanelHeader title={title} description={description} />
        <div className="p-4">{children}</div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------- Deposit form */

function DepositForm({
  accountId,
  treasury,
  minimumLabel,
  disabled,
  onDeposited,
}: {
  accountId: string;
  treasury: string;
  minimumLabel: string;
  disabled: boolean;
  onDeposited: () => void;
}) {
  const [txId, setTxId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/sellers/deposit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, transaction_id: txId.trim() }),
      });
      const body = await response.json();
      setResult({ ok: response.ok, message: body.message ?? body.error ?? "Done." });
      if (response.ok) onDeposited();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Callout tone="neutral" title="How to deposit">
        Send at least {minimumLabel} from{" "}
        <span className="font-mono">{accountId || "your account"}</span> to the
        marketplace treasury <span className="font-mono">{treasury}</span>, then
        paste the transaction id below. The amount is read back from the mirror
        node — nothing is taken on trust.
      </Callout>

      <Field
        label="Transaction id"
        htmlFor="txid"
        hint="Format 0.0.12345@1756290000.000000000, as shown on HashScan."
      >
        <Input
          id="txid"
          value={txId}
          onChange={(event) => setTxId(event.target.value)}
          placeholder="0.0.12345@1756290000.000000000"
          disabled={disabled}
        />
      </Field>

      {result && (
        <Callout tone={result.ok ? "ok" : "bad"}>{result.message}</Callout>
      )}

      <Button type="submit" loading={submitting} disabled={disabled || !txId.trim()}>
        Verify deposit
      </Button>
      {disabled && (
        <p className="text-[12px] text-ink-3">Register the account first.</p>
      )}
    </form>
  );
}

/* ---------------------------------------------------------- Listing form */
