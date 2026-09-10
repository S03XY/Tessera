"use client";

import { useState } from "react";
import { IDKitRequestWidget } from "@worldcoin/idkit";
import {
  deviceLegacy,
  documentLegacy,
  orbLegacy,
  passport,
  proofOfHuman,
  secureDocumentLegacy,
  selfieCheckLegacy,
  type Preset,
} from "@worldcoin/idkit-core";
import { Button, Callout, Field, Input } from "@/components/ui";
import type { PresetName } from "@/lib/world-credentials";

/**
 * World ID verification.
 *
 * Live mode fetches a server-signed RP context, runs IDKit, and forwards the
 * proof to our backend for World to verify — the browser's word is never
 * enough. Simulated mode skips the capture entirely and is labelled as such
 * everywhere it touches.
 *
 * Which credential is requested comes from the server rather than from this
 * file. The seller gate is deployment policy, and a client that hard-codes
 * one preset silently ignores that policy.
 */

interface Challenge {
  mode: "live" | "simulated";
  app_id: `app_${string}`;
  action: string;
  credential: string;
  credential_label?: string;
  preset?: PresetName;
  allow_legacy_proofs?: boolean;
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
 * The preset factories, by the name the server sends.
 *
 * A lookup rather than a `switch` so an unknown name is a missing entry we
 * can report, not a silent fall-through to the wrong credential.
 */
const PRESETS: Record<PresetName, (opts: { signal: string }) => Preset> = {
  selfieCheckLegacy,
  orbLegacy,
  deviceLegacy,
  documentLegacy,
  secureDocumentLegacy,
  proofOfHuman,
  passport,
};

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
          ? "Simulated pass recorded. This is not a real World ID proof and is labelled as simulated everywhere."
          : `${result.credential_label ?? "World ID"} passed. This account is now a verified seller.`,
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
      const body = (await response.json()) as Challenge & { message?: string };
      if (!response.ok) {
        setMessage({ tone: "warn", text: body.message ?? "Could not start verification." });
        return;
      }
      if (!body.preset || !(body.preset in PRESETS)) {
        setMessage({
          tone: "bad",
          text: "Verification is not available right now. Please try again shortly.",
        });
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
          No World ID credentials are configured, so the real capture cannot
          run. This records a simulated pass so the seller gate and the demo
          work. It is <strong>not</strong> a World ID proof.
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

  const preset = challenge?.preset ? PRESETS[challenge.preset] : null;

  return (
    <div className="space-y-3">
      <Button onClick={startLive} loading={busy} disabled={disabled}>
        Start verification
      </Button>

      {disabled && <p className="text-[12px] text-ink-3">Enter a seller account first.</p>}
      {message && <Callout tone={message.tone}>{message.text}</Callout>}

      {challenge?.rp_context && preset && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={challenge.app_id}
          action={challenge.action}
          rp_context={challenge.rp_context}
          environment={challenge.environment}
          // Legacy presets return World ID 3.0 proofs, so this is mandatory
          // for them and must be false for the 4.0-only ones. The server
          // decides, because it is the one that knows the credential.
          allow_legacy_proofs={challenge.allow_legacy_proofs ?? true}
          // The signal binds the proof to this seller account, so a proof
          // captured for one account cannot be replayed onto another.
          preset={preset({ signal: accountId })}
          onSuccess={(result) => submit({ proof: result })}
          onError={(code) => setMessage({ tone: "bad", text: describeIdKitError(code) })}
        />
      )}
    </div>
  );
}

/**
 * IDKit's error codes, in words a seller can act on.
 *
 * World ships the codes as a TypeScript union but documents neither cause nor
 * remedy, and "World App reported: invalid_rp_signature" tells the person in
 * front of the screen nothing at all. The server has the same table for the
 * codes it sees; these are the ones only the browser ever observes.
 */
function describeIdKitError(code: string): string {
  const known: Record<string, string> = {
    user_rejected: "You declined the check in World App.",
    verification_rejected: "World App rejected the verification.",
    credential_unavailable:
      "Your World ID does not hold this credential yet. Obtain it in World App, then try again.",
    max_verifications_reached: "This World ID has already verified as many times as this action allows.",
    inclusion_proof_pending:
      "Your World ID is still being registered on-chain. Try again in a few minutes.",
    // These three are the marketplace's own misconfiguration, not anything the
    // person holding the phone did or can fix. They are told it is our fault
    // and to try later; the operator sees the real cause in `?setup=1`.
    invalid_rp_signature: "Verification is misconfigured on our side. Please try again later.",
    unknown_rp: "Verification is misconfigured on our side. Please try again later.",
    inactive_rp: "Verification is unavailable on our side. Please try again later.",
    rp_signature_expired: "The request expired before you finished. Start the check again.",
    world_id_4_not_available: "Update World App — this version cannot produce the required proof.",
    connection_failed: "World App could not reach World. Check its connection and try again.",
    timeout: "The check timed out. Start it again.",
    cancelled: "The check was cancelled.",
  };
  return known[code] ?? `World App reported: ${code}`;
}
