"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Callout, Spinner } from "@/components/ui";

/**
 * World ID setup, checked from inside the app.
 *
 * Four separate things must be true in the Developer Portal before a seller
 * can complete a capture, and none of them is visible from the app starting
 * cleanly — the portal shows an rp_id and IDKit accepts the configuration even
 * when the app was never migrated. The result is a setup that looks finished
 * and fails on the first real proof.
 *
 * So the operator gets the verdicts here rather than in a terminal, and the
 * secret never has to move: the signing key stays in `.env.local`, the server
 * signs a throwaway challenge with it, and only pass/fail comes back.
 */

interface Check {
  id: string;
  label: string;
  state: "pass" | "fail" | "warn" | "skip";
  detail: string;
  remedy?: string;
}

interface Report {
  mode: "live" | "simulated" | "unavailable";
  credential: string;
  credential_label: string;
  checks: Check[];
  ready: boolean;
  todo: string[];
}

const TONE: Record<Check["state"], "ok" | "bad" | "warn" | "neutral"> = {
  pass: "ok",
  fail: "bad",
  warn: "warn",
  skip: "neutral",
};

const GLYPH: Record<Check["state"], string> = {
  pass: "✓",
  fail: "✗",
  warn: "!",
  skip: "·",
};

/**
 * Fetches the verdicts. Kept outside the component and free of state so the
 * mount-time load can `await` before touching state — a hook that sets state
 * synchronously is a hook that cannot be called from an effect.
 */
async function fetchReport(signal?: AbortSignal): Promise<Report> {
  const response = await fetch("/api/world/status", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Status check failed (${response.status}).`);
  return (await response.json()) as Report;
}

export function WorldSetupPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The manual re-check, driven by the button. */
  const recheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchReport());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Abandoned on unmount so a slow probe cannot resolve into a state update
    // on a component that is already gone.
    const controller = new AbortController();
    fetchReport(controller.signal)
      .then((body) => setReport(body))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not run the check.");
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-4">
            World ID setup
          </span>
          {report && (
            <Badge tone={report.ready ? "ok" : "warn"} dot>
              {report.mode}
            </Badge>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void recheck()} disabled={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Checking…" : "Re-check"}
        </Button>
      </div>

      {error && <Callout tone="bad">{error}</Callout>}

      {report && (
        <>
          <ul className="space-y-px">
            {report.checks.map((item) => (
              <li
                key={item.id}
                className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2.5 border-b border-line py-2.5 last:border-0"
              >
                <span
                  aria-hidden="true"
                  className={
                    "mt-[1px] text-center font-mono text-[12px] " +
                    (item.state === "pass"
                      ? "text-ok"
                      : item.state === "fail"
                        ? "text-bad"
                        : item.state === "warn"
                          ? "text-warn"
                          : "text-ink-4")
                  }
                >
                  {GLYPH[item.state]}
                </span>
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-ink">
                    {item.label}
                    <span className="sr-only"> — {item.state}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{item.detail}</p>
                  {item.remedy && (
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-4">→ {item.remedy}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {report.ready ? (
            <Callout tone="ok" title="Ready">
              A seller can complete a real {report.credential_label} capture now.
            </Callout>
          ) : (
            <Callout tone={TONE.warn} title="Not live yet">
              These are Developer Portal settings, not code. Everything is
              checked against World&apos;s own endpoints, so once the portal is
              right this panel turns green without a redeploy.
            </Callout>
          )}
        </>
      )}

      {!report && !error && (
        <p className="text-[12px] text-ink-4">Checking the World ID configuration…</p>
      )}
    </div>
  );
}
