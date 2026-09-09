"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Panel,
  PanelHeader,
  Select,
  Textarea,
  cx,
} from "@/components/ui";

// IDKit pulls in WASM and touches window; keep it off the server render.
const SelfieCheckButton = dynamic(
  () => import("./selfie-check").then((m) => m.SelfieCheckButton),
  { ssr: false, loading: () => <Button disabled>Loading Selfie Check…</Button> },
);

interface Status {
  account_id: string;
  display_name: string;
  verification_status: string;
  deposit_amount: string;
  world_credential: string | null;
  service_count: string;
}

type StepState = "todo" | "active" | "done";

export function OnboardingFlow({
  worldMode,
  chainConfigured,
  treasury,
  minimumDeposit,
  minimumLabel,
}: {
  worldMode: "live" | "simulated" | "unavailable";
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

  const verified = status?.verification_status === "verified";
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
            <Badge tone={verified ? "ok" : "warn"} dot>
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
        title="Pass World ID Selfie Check"
        state={verified ? "done" : accountId.trim() ? "active" : "todo"}
        description="One human, one seller account. The nullifier is stored under a unique constraint, so the same person cannot register twice."
      >
        {worldMode === "unavailable" ? (
          <Callout tone="warn" title="World ID is not configured">
            Set <span className="font-mono">WORLD_APP_ID</span>,{" "}
            <span className="font-mono">WORLD_RP_ID</span> and{" "}
            <span className="font-mono">WORLD_RP_SIGNING_KEY</span> in{" "}
            <span className="font-mono">.env.local</span>. Selfie Check is
            feature-gated — request access for your app from World before it
            will work, including in the Sandbox App.
          </Callout>
        ) : verified ? (
          <Callout
            tone={status?.world_credential === "selfie_check_simulated" ? "warn" : "ok"}
            title={
              status?.world_credential === "selfie_check_simulated"
                ? "Verified (simulated)"
                : "Verified"
            }
          >
            {status?.world_credential === "selfie_check_simulated"
              ? "Recorded via a simulated pass, not a real Selfie Check."
              : "Selfie Check passed. This account is a distinct, live human."}
          </Callout>
        ) : (
          <SelfieCheckButton
            accountId={accountId.trim()}
            displayName={displayName.trim()}
            disabled={!accountId.trim()}
            simulated={worldMode === "simulated"}
            onVerified={() => refresh()}
          />
        )}
      </Step>

      <Step
        index={3}
        title="Post the dispute deposit"
        state={funded ? "done" : verified ? "active" : "todo"}
        description={`At least ${minimumLabel} held against refunds. An upheld dispute is paid out of this balance.`}
      >
        {!chainConfigured ? (
          <Callout tone="warn" title="No treasury configured">
            Set <span className="font-mono">HEDERA_OPERATOR_ID</span> and{" "}
            <span className="font-mono">HEDERA_OPERATOR_KEY</span> so deposits
            can be verified against the mirror node.
          </Callout>
        ) : (
          <DepositForm
            accountId={accountId.trim()}
            treasury={treasury}
            minimumLabel={minimumLabel}
            disabled={!verified}
            onDeposited={() => refresh()}
          />
        )}
      </Step>

      <Step
        index={4}
        title="List a service"
        state={funded ? "active" : "todo"}
        description="Only reachable once both gates above are green. The API rejects a listing from an unverified or underfunded account."
        last
      >
        <ListingForm accountId={accountId.trim()} verified={verified} funded={funded} />
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
        <p className="text-[12px] text-ink-3">Pass Selfie Check first.</p>
      )}
    </form>
  );
}

/* ---------------------------------------------------------- Listing form */

function ListingForm({
  accountId,
  verified,
  funded,
}: {
  accountId: string;
  verified: boolean;
  funded: boolean;
}) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "general",
    endpoint_url: "",
    price_amount: "100000",
    price_unit: "per_call",
    keywords: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; slug?: string } | null>(
    null,
  );

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch("/api/services/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          name: form.name,
          description: form.description,
          category: form.category,
          endpoint_url: form.endpoint_url,
          price_amount: form.price_amount,
          price_unit: form.price_unit,
          keywords: form.keywords
            .split(",")
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        }),
      });
      const body = await response.json();
      setResult(
        response.ok
          ? { ok: true, message: "Listed and live.", slug: body.service.slug }
          : { ok: false, message: body.message ?? "Listing failed." },
      );
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Failed." });
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = !accountId || !verified || !funded;

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="name">
          <Input id="name" value={form.name} onChange={set("name")} placeholder="Gold Spot Price" />
        </Field>
        <Field label="Category" htmlFor="category">
          <Input id="category" value={form.category} onChange={set("category")} />
        </Field>
      </div>

      <Field label="Description" htmlFor="description">
        <Textarea
          id="description"
          value={form.description}
          onChange={set("description")}
          placeholder="What the endpoint returns, and how often it refreshes."
        />
      </Field>

      <Field
        label="Endpoint URL"
        htmlFor="endpoint"
        hint="Must be a public https URL. Private ranges and metadata addresses are rejected."
      >
        <Input
          id="endpoint"
          value={form.endpoint_url}
          onChange={set("endpoint_url")}
          placeholder="https://api.example.com/gold"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Price (tinybars)" htmlFor="price" hint="100000 tinybars = 0.001 ℏ">
          <Input id="price" value={form.price_amount} onChange={set("price_amount")} />
        </Field>
        <Field label="Metering" htmlFor="unit">
          <Select id="unit" value={form.price_unit} onChange={set("price_unit")}>
            <option value="per_call">Per call</option>
            <option value="per_token">Per token</option>
            <option value="per_row">Per row</option>
          </Select>
        </Field>
      </div>

      <Field
        label="Discovery keywords"
        htmlFor="keywords"
        hint="Comma separated. The synonyms an agent might search for."
      >
        <Input
          id="keywords"
          value={form.keywords}
          onChange={set("keywords")}
          placeholder="gold, xau, precious metals, commodity price"
        />
      </Field>

      {result && (
        <Callout tone={result.ok ? "ok" : "bad"}>
          {result.message}
          {result.slug && (
            <>
              {" "}
              <Link
                href={`/services/${result.slug}`}
                className="underline underline-offset-4"
              >
                View listing
              </Link>
            </>
          )}
        </Callout>
      )}

      <Button type="submit" variant="primary" loading={submitting} disabled={blocked}>
        List service
      </Button>
      {blocked && (
        <p className="text-[12px] text-ink-3">
          {!accountId
            ? "Enter a seller account first."
            : !verified
              ? "Blocked: this account has not passed Selfie Check."
              : "Blocked: deposit is below the minimum."}
        </p>
      )}
    </form>
  );
}
