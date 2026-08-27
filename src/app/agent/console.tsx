"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Button,
  Callout,
  IndeterminateBar,
  Input,
  Panel,
  PanelHeader,
  Spinner,
  cx,
} from "@/components/ui";
import { formatAmount } from "@/lib/money";

interface Step {
  key: string;
  title: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
  data?: Record<string, unknown>;
  ms?: number;
}

interface RunResult {
  capability: string;
  steps: Step[];
  chosen: { slug: string; name: string; seller: string; price: string; quote: string } | null;
  considered: Array<{ slug: string; name: string; seller: string; price: string }>;
  paid: boolean;
  transaction: string | null;
  callId: string | null;
  response: string | null;
  error: string | null;
}

const PRESETS = ["exchange rates", "bitcoin price", "weather", "tech news", "encyclopedia"];

export function AgentConsole({ canPay }: { canPay: boolean }) {
  const [capability, setCapability] = useState("exchange rates");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(query = capability) {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: query }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? `Run failed with ${response.status}.`);
        return;
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Run a cycle"
          description="One invocation: discover, rank, quote, check the cap, pay, consume."
        />
        <div className="space-y-3 p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (capability.trim()) void run(capability.trim());
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <div className="min-w-[240px] flex-1">
              <Input
                value={capability}
                onChange={(event) => setCapability(event.target.value)}
                placeholder="Describe a capability the agent should buy"
                aria-label="Capability to buy"
              />
            </div>
            <Button type="submit" variant="primary" loading={running} disabled={!capability.trim()}>
              {running ? "Running…" : "Run agent"}
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-ink-3">Try:</span>
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={running}
                onClick={() => {
                  setCapability(preset);
                  void run(preset);
                }}
                className="rounded-full border border-line-2 bg-bg px-2.5 py-0.5 text-[12px] text-ink-2 transition-colors hover:border-line-3 hover:text-ink disabled:opacity-50"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
        {running && <IndeterminateBar className="rounded-none" />}
      </Panel>

      {!canPay && (
        <Callout tone="warn" title="Buyer key not configured">
          The agent will discover, rank and quote for real, then stop before
          signing. Set <span className="font-mono">AGENT_ACCOUNT_ID</span> and{" "}
          <span className="font-mono">AGENT_PRIVATE_KEY</span> to a funded Hedera
          testnet account to complete a settled payment.
        </Callout>
      )}

      {error && <Callout tone="bad">{error}</Callout>}

      {running && !result && <RunningSkeleton />}

      {result && <Trace result={result} />}
    </div>
  );
}

function Trace({ result }: { result: RunResult }) {
  return (
    <div className="space-y-5 animate-fade-up">
      {result.considered.length > 0 && (
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Providers considered"
            description="Ranked cheapest first. The agent takes the head of this list."
          />
          <ul className="divide-y divide-line">
            {result.considered.map((option, index) => (
              <li
                key={option.slug}
                className={cx(
                  "flex items-center justify-between gap-4 px-4 py-2.5",
                  index === 0 && "bg-ok-soft/40",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {index === 0 ? (
                    <span className="rounded border border-ok-line bg-ok-soft px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ok">
                      chosen
                    </span>
                  ) : (
                    <span className="w-[52px] font-mono text-[11px] text-ink-4">#{index + 1}</span>
                  )}
                  <Link
                    href={`/services/${option.slug}`}
                    className="truncate text-[13px] text-ink underline-offset-4 hover:underline"
                  >
                    {option.name}
                  </Link>
                  <span className="truncate text-[12px] text-ink-3">{option.seller}</span>
                </div>
                <span className="tnum shrink-0 font-mono text-[12.5px] text-ink-2">
                  {formatAmount(option.price)} ℏ
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="overflow-hidden">
        <PanelHeader title="Run trace" />
        <ol className="divide-y divide-line">
          {result.steps.map((step) => (
            <li key={step.key} className="flex gap-3 px-4 py-3">
              <StatusDot status={step.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[13px] font-medium text-ink">{step.title}</p>
                  {step.ms !== undefined && (
                    <span className="tnum shrink-0 font-mono text-[11px] text-ink-4">
                      {step.ms} ms
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      {result.paid && result.response && (
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Response received"
            description={
              result.transaction
                ? `Settled on Hedera as ${result.transaction}`
                : "Delivered after settlement."
            }
            actions={
              result.callId ? (
                <Link href={`/activity/${result.callId}`}>
                  <Button size="sm" variant="secondary">
                    Receipt →
                  </Button>
                </Link>
              ) : undefined
            }
          />
          <pre className="scroll-thin max-h-80 overflow-auto bg-bg-subtle px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
            {pretty(result.response)}
          </pre>
        </Panel>
      )}
    </div>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function StatusDot({ status }: { status: Step["status"] }) {
  if (status === "ok") {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
        <svg viewBox="0 0 12 12" className="size-2.5" aria-label="ok">
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
        <svg viewBox="0 0 12 12" className="size-2.5" aria-label="failed">
          <path
            d="M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-bg-inset text-ink-4"
      aria-label="skipped"
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}

function RunningSkeleton() {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title="Run trace" />
      <div className="space-y-3 px-4 py-4">
        {["Discovering providers", "Ranking by price", "Requesting quote"].map((label) => (
          <div key={label} className="flex items-center gap-2.5 text-[12.5px] text-ink-3">
            <Spinner className="size-3.5" />
            {label}…
          </div>
        ))}
      </div>
    </Panel>
  );
}
