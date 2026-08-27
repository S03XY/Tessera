"use client";

import { useState } from "react";
import { IDKitRequestWidget } from "@worldcoin/idkit";
import { selfieCheckLegacy } from "@worldcoin/idkit-core";
import { Button, Callout } from "@/components/ui";

interface Challenge {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  rp_context: {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
}

/**
 * Selfie Check via IDKit.
 *
 * The RP context is fetched from our server because it is signed with the RP
 * key. The proof that comes back is forwarded to our backend and verified
 * with World before anything is written — the browser's word is never enough.
 */
export function SelfieCheckButton({
  accountId,
  displayName,
  disabled,
  onVerified,
}: {
  accountId: string;
  displayName: string;
  disabled: boolean;
  onVerified: () => void;
}) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(
    null,
  );

  async function start() {
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

  async function submitProof(proof: unknown) {
    setBusy(true);
    try {
      const response = await fetch("/api/world/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, display_name: displayName, proof }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ tone: "bad", text: body.message ?? "Verification rejected." });
        return;
      }
      setMessage({ tone: "ok", text: "Selfie Check passed. This account is now a verified seller." });
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

  return (
    <div className="space-y-3">
      <Button onClick={start} loading={busy} disabled={disabled}>
        Start Selfie Check
      </Button>

      {disabled && <p className="text-[12px] text-ink-3">Enter a seller account first.</p>}

      {message && <Callout tone={message.tone}>{message.text}</Callout>}

      {challenge && (
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
          onSuccess={(result) => submitProof(result)}
          onError={(code) =>
            setMessage({ tone: "bad", text: `World App reported: ${code}` })
          }
        />
      )}
    </div>
  );
}
