"use client";

import { useState } from "react";
import { IDKitRequestWidget } from "@worldcoin/idkit";
import { selfieCheckLegacy } from "@worldcoin/idkit-core";
import { Button, Callout, Field, Input } from "@/components/ui";

interface Challenge {
  mode: "live" | "simulated";
  app_id: `app_${string}`;
  action: string;
  environment?: "production" | "staging" | "sandbox";
  rp_context?: {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
}

/**
 * Selfie Check.
 *
 * Live mode fetches a server-signed RP context, runs IDKit, and forwards the
 * proof to our backend for World to verify — the browser's word is never
 * enough. Simulated mode skips the capture entirely and is labelled as such
 * everywhere it touches.
 */
export function SelfieCheckButton({
  accountId,
  displayName,
  disabled,
  simulated,
  onVerified,
}: {
  accountId: string;
  displayName: string;
  disabled: boolean;
  simulated: boolean;
  onVerified: () => void;
}) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [persona, setPersona] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(
    null,
  );

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch("/api/world/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, display_name: displayName, ...body }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage({ tone: "bad", text: result.message ?? "Verification rejected." });
        return;
      }
      setMessage({
        tone: result.simulated ? "warn" : "ok",
        text: result.simulated
          ? "Simulated pass recorded. This is not a real Selfie Check and is labelled as simulated everywhere."
          : "Selfie Check passed. This account is now a verified seller.",
      });
      onVerified();
    } catch (err) {
      setMessage({
        tone: "bad",
        text: err instanceof Error ? err.message : "Verification failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function startLive() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/world/challenge", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ tone: "warn", text: body.message ?? "Could not start verification." });
        return;
      }
      setChallenge(body);
      setOpen(true);
    } catch (err) {
      setMessage({
        tone: "bad",
        text: err instanceof Error ? err.message : "Could not start verification.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (simulated) {
    return (
      <div className="space-y-3">
        <Callout tone="warn" title="Simulation mode">
          Selfie Check has not been enabled for this app by World yet, so the
          real capture cannot run. This records a simulated pass so the seller
          gate and the demo work. It is <strong>not</strong> a Selfie Check and
          does not satisfy World&apos;s Sandbox App requirement.
        </Callout>

        <Field
          label="Persona"
          htmlFor="persona"
          hint="Stands in for a real human. Two accounts claiming the same persona collide, exactly as two proofs from one person would."
        >
          <Input
            id="persona"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder="alice"
            disabled={disabled}
          />
        </Field>

        <Button
          onClick={() => submit({ persona })}
          loading={busy}
          disabled={disabled || !persona.trim()}
        >
          Record simulated pass
        </Button>

        {disabled && <p className="text-[12px] text-ink-3">Enter a seller account first.</p>}
        {message && <Callout tone={message.tone}>{message.text}</Callout>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Button onClick={startLive} loading={busy} disabled={disabled}>
        Start Selfie Check
      </Button>

      {disabled && <p className="text-[12px] text-ink-3">Enter a seller account first.</p>}
      {message && <Callout tone={message.tone}>{message.text}</Callout>}

      {challenge?.rp_context && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={challenge.app_id}
          action={challenge.action}
          rp_context={challenge.rp_context}
          environment={challenge.environment}
          // Selfie Check returns World ID 3.0 proofs, so legacy must be allowed.
          allow_legacy_proofs
          preset={selfieCheckLegacy({ signal: accountId })}
          onSuccess={(result) => submit({ proof: result })}
          onError={(code) => setMessage({ tone: "bad", text: `World App reported: ${code}` })}
        />
      )}
    </div>
  );
}
