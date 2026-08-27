import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { inspectHederaTransaction } from "@x402/hedera";
import { FACILITATOR_URL, X402_NETWORK } from "@/lib/config";

/**
 * x402 v2 over the Blocky402 facilitator.
 *
 * Settlement is deliberately not implemented here: /verify and /settle are the
 * facilitator's job, which is both a sponsor requirement and the reason this
 * gateway never has to hold a payer's key.
 */

export const X402_VERSION = 2;
export const SCHEME = "exact";

export class FacilitatorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "FacilitatorError";
  }
}

/* --------------------------------------------------------------- /supported */

let supportedCache: { value: SupportedResponse; fetchedAt: number } | null = null;
const SUPPORTED_TTL_MS = 5 * 60_000;

export async function getSupported(force = false): Promise<SupportedResponse> {
  const now = Date.now();
  if (!force && supportedCache && now - supportedCache.fetchedAt < SUPPORTED_TTL_MS) {
    return supportedCache.value;
  }

  const response = await fetchWithTimeout(`${FACILITATOR_URL}/supported`, { method: "GET" });
  if (!response.ok) {
    throw new FacilitatorError(
      `facilitator /supported returned ${response.status}`,
      response.status,
    );
  }

  const value = (await response.json()) as SupportedResponse;
  supportedCache = { value, fetchedAt: now };
  return value;
}

/**
 * The `extra` block the facilitator requires for our network. On Hedera this
 * carries `feePayer`, the account Blocky402 uses to cover gas — read from the
 * facilitator rather than hardcoded so a rotation does not break settlement.
 */
export async function networkExtra(): Promise<Record<string, unknown>> {
  try {
    const supported = await getSupported();
    const kind = supported.kinds.find(
      (entry) => entry.network === X402_NETWORK && entry.scheme === SCHEME,
    );
    return kind?.extra ?? {};
  } catch {
    return {};
  }
}

export async function facilitatorSupportsNetwork(): Promise<boolean> {
  try {
    const supported = await getSupported();
    return supported.kinds.some(
      (entry) => entry.network === X402_NETWORK && entry.scheme === SCHEME,
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ Requirements */

export interface BuildRequirementsInput {
  amount: bigint | string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
}

export async function buildRequirements(
  input: BuildRequirementsInput,
): Promise<PaymentRequirements> {
  return {
    scheme: SCHEME,
    network: X402_NETWORK as `${string}:${string}`,
    asset: input.asset,
    amount: input.amount.toString(),
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
    extra: await networkExtra(),
  };
}

export function paymentRequiredBody(
  requirements: PaymentRequirements[],
  resource: ResourceInfo,
  error?: string,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource,
    accepts: requirements,
  };
}

/* ---------------------------------------------------------------- Payloads */

export class PaymentHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentHeaderError";
  }
}

/** Decodes the base64 `X-PAYMENT` header into a payload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  let json: string;
  try {
    json = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new PaymentHeaderError("X-PAYMENT is not valid base64");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PaymentHeaderError("X-PAYMENT does not decode to JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new PaymentHeaderError("X-PAYMENT payload is not an object");
  }

  const payload = parsed as Partial<PaymentPayload>;

  if (payload.x402Version !== X402_VERSION) {
    throw new PaymentHeaderError(
      `unsupported x402Version ${String(payload.x402Version)}, expected ${X402_VERSION}`,
    );
  }
  if (!payload.accepted || typeof payload.accepted !== "object") {
    throw new PaymentHeaderError("X-PAYMENT is missing the accepted requirements");
  }
  if (!payload.payload || typeof payload.payload !== "object") {
    throw new PaymentHeaderError("X-PAYMENT is missing the scheme payload");
  }

  return payload as PaymentPayload;
}

export function encodeSettlementHeader(settlement: SettleResponse): string {
  return Buffer.from(JSON.stringify(settlement), "utf8").toString("base64");
}

/**
 * Pulls the Hedera transaction id out of a signed payload *before* settling.
 *
 * This is the replay guard: the id is stable across resubmissions of the same
 * signed transaction, so the gateway can refuse a payment header that has
 * already bought a delivery.
 */
export function transactionIdFromPayload(payload: PaymentPayload): string | null {
  const inner = payload.payload as { transaction?: unknown };
  if (typeof inner?.transaction !== "string") return null;
  try {
    return inspectHederaTransaction(inner.transaction).transactionId || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- verify and settle */

const FACILITATOR_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FacilitatorError(`facilitator unreachable: ${reason}`, 503);
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchWithTimeout(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new FacilitatorError(
      `facilitator ${path} returned non-JSON (${response.status})`,
      response.status,
      text.slice(0, 400),
    );
  }

  if (!response.ok) {
    throw new FacilitatorError(
      `facilitator ${path} returned ${response.status}`,
      response.status,
      parsed,
    );
  }

  return parsed as T;
}

export async function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return post<VerifyResponse>("/verify", {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
}

export async function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  return post<SettleResponse>("/settle", {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
}
