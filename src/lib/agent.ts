import type { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { discoverServices, type ServiceListing } from "@/lib/repo";
import { queryOne, query } from "@/lib/db";
import { parsePrivateKey } from "@/lib/hedera";
import { formatAmount, normalizeUnits, quoteFor, type PriceUnit } from "@/lib/money";
import { BASE_URL, X402_NETWORK } from "@/lib/config";
import { X402_VERSION } from "@/lib/x402";

/**
 * The buyer agent.
 *
 * Runs as a short sequence of steps inside one request, because Vercel is
 * serverless and there is no daemon to keep alive. Every run returns a full
 * trace so the console can show what the agent decided and why, rather than
 * just the final answer.
 */

export const agentBuyer = {
  accountId: process.env.AGENT_ACCOUNT_ID ?? "",
  privateKey: process.env.AGENT_PRIVATE_KEY ?? "",
};

export const agentCanPay = Boolean(agentBuyer.accountId && agentBuyer.privateKey);

export type StepStatus = "ok" | "failed" | "skipped";

export interface AgentStep {
  key: string;
  title: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
  ms?: number;
}

export interface AgentRunResult {
  capability: string;
  steps: AgentStep[];
  chosen: {
    slug: string;
    name: string;
    seller: string;
    price: string;
    unit: PriceUnit;
    quote: string;
  } | null;
  considered: Array<{ slug: string; name: string; seller: string; price: string }>;
  paid: boolean;
  transaction: string | null;
  callId: string | null;
  response: string | null;
  error: string | null;
}

export interface AgentRunInput {
  capability: string;
  units?: number;
  /** Refuse to spend more than this on a single call, in atomic units. */
  perCallCap?: bigint;
}

const DEFAULT_PER_CALL_CAP = 5_000_000n; // 0.05 ℏ

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const steps: AgentStep[] = [];
  const result: AgentRunResult = {
    capability: input.capability,
    steps,
    chosen: null,
    considered: [],
    paid: false,
    transaction: null,
    callId: null,
    response: null,
    error: null,
  };

  const step = (s: AgentStep) => {
    steps.push(s);
    return s;
  };

  /* ------------------------------------------------------------ discover */

  const t0 = Date.now();
  let candidates: ServiceListing[];
  try {
    candidates = await discoverServices({
      q: input.capability,
      limit: 10,
      payableOnly: true,
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    step({
      key: "discover",
      title: "Discover services",
      status: "failed",
      detail: result.error,
    });
    return result;
  }

  result.considered = candidates.map((service) => ({
    slug: service.slug,
    name: service.name,
    seller: service.seller_name,
    price: service.price_amount,
  }));

  if (candidates.length === 0) {
    step({
      key: "discover",
      title: "Discover services",
      status: "failed",
      detail: `No payable service matched “${input.capability}”.`,
      ms: Date.now() - t0,
    });
    result.error = "no_matching_service";
    return result;
  }

  step({
    key: "discover",
    title: "Discover services",
    status: "ok",
    detail: `${candidates.length} provider${candidates.length === 1 ? "" : "s"} match this capability.`,
    data: { candidates: result.considered },
    ms: Date.now() - t0,
  });

  /* -------------------------------------------------------------- select */

  // discoverServices already ranks by price then success rate, so the head of
  // the list is the cheapest provider with the best delivery record.
  const chosen = candidates[0];
  const units = normalizeUnits(input.units, chosen.price_unit);
  const expected = quoteFor(chosen.price_amount, units);

  result.chosen = {
    slug: chosen.slug,
    name: chosen.name,
    seller: chosen.seller_name,
    price: chosen.price_amount,
    unit: chosen.price_unit,
    quote: expected.toString(),
  };

  const runnerUp = candidates[1];
  step({
    key: "select",
    title: "Select cheapest provider",
    status: "ok",
    detail: runnerUp
      ? `${chosen.seller_name} at ${formatAmount(chosen.price_amount)} ℏ, undercutting ${
          runnerUp.seller_name
        } at ${formatAmount(runnerUp.price_amount)} ℏ.`
      : `${chosen.seller_name} at ${formatAmount(chosen.price_amount)} ℏ — only provider.`,
    data: { slug: chosen.slug, seller: chosen.seller_name },
  });

  /* --------------------------------------------------------------- quote */

  const paidUrl = new URL(`/x402/${chosen.slug}`, BASE_URL);
  if (chosen.price_unit !== "per_call") paidUrl.searchParams.set("units", String(units));

  const t1 = Date.now();
  let requirements: PaymentRequirements;
  try {
    const response = await fetch(paidUrl, { cache: "no-store" });
    if (response.status !== 402) {
      const text = await response.text();
      throw new Error(`expected 402, got ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = await response.json();
    requirements = body.accepts?.[0];
    if (!requirements) throw new Error("402 carried no payment requirements");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    step({ key: "quote", title: "Request quote", status: "failed", detail: result.error });
    return result;
  }

  step({
    key: "quote",
    title: "Request quote",
    status: "ok",
    detail: `402 quoting ${formatAmount(requirements.amount)} ℏ to ${requirements.payTo}.`,
    data: {
      amount: requirements.amount,
      payTo: requirements.payTo,
      asset: requirements.asset,
      network: requirements.network,
    },
    ms: Date.now() - t1,
  });

  /* ----------------------------------------------------------- spend cap */

  const cap = input.perCallCap ?? (await perCallCap());
  if (BigInt(requirements.amount) > cap) {
    step({
      key: "budget",
      title: "Check spending cap",
      status: "failed",
      detail: `Quote of ${formatAmount(requirements.amount)} ℏ exceeds the per-call cap of ${formatAmount(
        cap,
      )} ℏ. Refusing to pay.`,
      data: { quote: requirements.amount, cap: cap.toString() },
    });
    result.error = "per_call_cap_exceeded";
    return result;
  }

  step({
    key: "budget",
    title: "Check spending cap",
    status: "ok",
    detail: `${formatAmount(requirements.amount)} ℏ is within the ${formatAmount(cap)} ℏ per-call cap.`,
    data: { quote: requirements.amount, cap: cap.toString() },
  });

  /* ----------------------------------------------------------------- pay */

  if (!agentCanPay) {
    step({
      key: "pay",
      title: "Sign and pay",
      status: "skipped",
      detail:
        "No buyer key configured. Set AGENT_ACCOUNT_ID and AGENT_PRIVATE_KEY to a funded Hedera testnet account to complete a real payment.",
    });
    return result;
  }

  const t2 = Date.now();
  let paymentHeader: string;
  try {
    const signer = createClientHederaSigner(
      agentBuyer.accountId,
      parsePrivateKey(agentBuyer.privateKey),
      { network: X402_NETWORK },
    );
    const scheme = new ExactHederaScheme(signer);
    const signed = await scheme.createPaymentPayload(X402_VERSION, requirements);

    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: signed.payload,
    };
    paymentHeader = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    step({ key: "pay", title: "Sign and pay", status: "failed", detail: result.error });
    return result;
  }

  step({
    key: "sign",
    title: "Sign transfer",
    status: "ok",
    detail: `Signed a ${formatAmount(requirements.amount)} ℏ transfer from ${agentBuyer.accountId}.`,
    ms: Date.now() - t2,
  });

  /* ------------------------------------------------------------- consume */

  const t3 = Date.now();
  try {
    const response = await fetch(paidUrl, {
      cache: "no-store",
      headers: { "x-payment": paymentHeader },
    });
    const text = await response.text();

    if (!response.ok) {
      result.error = text.slice(0, 400);
      step({
        key: "consume",
        title: "Consume response",
        status: "failed",
        detail: `Gateway returned ${response.status}.`,
        data: { body: result.error },
        ms: Date.now() - t3,
      });
      return result;
    }

    result.paid = true;
    result.transaction = response.headers.get("x-tollgate-tx");
    result.callId = response.headers.get("x-tollgate-call-id");
    result.response = text.slice(0, 4000);

    step({
      key: "consume",
      title: "Consume response",
      status: "ok",
      detail: `200 OK, ${text.length} bytes, settled as ${result.transaction ?? "unknown tx"}.`,
      data: {
        transaction: result.transaction,
        call_id: result.callId,
        units: response.headers.get("x-tollgate-units"),
        paid: response.headers.get("x-tollgate-paid"),
      },
      ms: Date.now() - t3,
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    step({ key: "consume", title: "Consume response", status: "failed", detail: result.error });
  }

  return result;
}

/** Per-call cap from the registered agent row, falling back to the default. */
async function perCallCap(): Promise<bigint> {
  try {
    const row = await queryOne<{ per_call_cap: string | null }>(
      `SELECT per_call_cap FROM agents WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1`,
    );
    if (row?.per_call_cap) return BigInt(row.per_call_cap);
  } catch {
    // Fall through to the default when the agent registry is unavailable.
  }
  return DEFAULT_PER_CALL_CAP;
}

/** Total spent by settled calls in the trailing 24 hours, in atomic units. */
export async function spentToday(): Promise<bigint> {
  const rows = await query<{ total: string }>(
    `SELECT coalesce(sum(paid_amount), 0)::text AS total
       FROM calls
      WHERE status = 'delivered' AND created_at > now() - interval '24 hours'`,
  );
  return BigInt(rows[0]?.total ?? "0");
}
