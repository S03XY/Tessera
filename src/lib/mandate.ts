/**
 * The agent's spending mandate, read from chain.
 *
 * The buying agent already has a per-call cap, but that cap lives in this
 * codebase, which means it holds because the agent behaves. A mandate is the
 * same policy expressed where the agent cannot reach it: three instructions on
 * 1inch's Aqua SwapVM that bound a per-call draw, a daily budget, and give the
 * owner a one transaction kill switch.
 *
 * Nothing is bridged. Funds never move between chains, and a draw on Aqua does
 * not fund a payment on Hedera. The mandate is consulted as the *authority on
 * whether the agent may spend at all*, and Hedera is where settlement happens.
 * That separation is deliberate: it gives an owner a kill switch that works
 * without this marketplace's cooperation, and it needs no bridge to be true.
 *
 * Aqua is deployed on Base and Arbitrum mainnet only, with no testnet
 * deployment, so this reads whatever router is configured and degrades to null
 * when none is. An unconfigured mandate is not a failure; it means the agent
 * falls back to the cap it enforces itself, and the UI says so.
 */

import { MANDATE } from "@/lib/config";

/** `mandateRevoked(address,uint32)` */
const REVOKED_SELECTOR = "0xb7c402d5";
/** `mandateSpentToday(address,bytes32)` */
const SPENT_SELECTOR = "0xd91a9f94";

const RPC_TIMEOUT_MS = 8_000;

export interface MandateState {
  router: string;
  owner: string;
  mandateId: number;
  chain: string;
  /** The owner has killed it. The agent must not spend, whatever its own cap says. */
  revoked: boolean;
  /** Drawn against the mandate so far today, in the mandate token's units. */
  spentToday: bigint;
  dailyCap: bigint;
  /** What is left of today's budget, floored at zero. */
  remaining: bigint;
  explorerUrl: string;
}

/** Why the agent may not spend, or null when it may. */
export type MandateRefusal = "revoked" | "daily_cap_exhausted";

function encodeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeUint32(value: number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeBytes32(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function ethCall(to: string, data: string, rpcUrl: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: { result?: string; error?: unknown };
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (body.error || typeof body.result !== "string") return null;
  if (!/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
  return body.result;
}

export type MandateConfig = typeof MANDATE;

/** True when a router, owner and order hash are all present. */
export function isMandateConfigured(config: MandateConfig = MANDATE): boolean {
  return Boolean(config.router && config.owner && config.orderHash);
}

/** Convenience for callers reading the ambient environment. */
export const mandateConfigured = isMandateConfigured();

/**
 * Reads the mandate. Returns null when unconfigured or unreachable, which the
 * caller must treat as "no on-chain authority", never as "permission granted"
 * — the agent's own cap still applies either way.
 */
export async function readMandate(
  config: MandateConfig = MANDATE,
): Promise<MandateState | null> {
  if (!isMandateConfigured(config)) return null;

  const [revokedRaw, spentRaw] = await Promise.all([
    ethCall(
      config.router,
      `${REVOKED_SELECTOR}${encodeAddress(config.owner)}${encodeUint32(config.mandateId)}`,
      config.rpcUrl,
    ),
    ethCall(
      config.router,
      `${SPENT_SELECTOR}${encodeAddress(config.owner)}${encodeBytes32(config.orderHash)}`,
      config.rpcUrl,
    ),
  ]);

  if (revokedRaw === null || spentRaw === null) return null;

  let revoked: boolean;
  let spentToday: bigint;
  try {
    revoked = BigInt(revokedRaw) !== 0n;
    spentToday = BigInt(spentRaw);
  } catch {
    return null;
  }

  const dailyCap = config.dailyCap;
  const remaining = dailyCap > spentToday ? dailyCap - spentToday : 0n;

  return {
    router: config.router,
    owner: config.owner,
    mandateId: config.mandateId,
    chain: config.chain,
    revoked,
    spentToday,
    dailyCap,
    remaining,
    explorerUrl: `${config.explorerBase}/address/${config.router}`,
  };
}

/**
 * Whether the mandate forbids this spend.
 *
 * `null` means nothing on chain objects — either the mandate permits it, or
 * there is no mandate to ask.
 */
export function mandateRefusal(state: MandateState | null): MandateRefusal | null {
  if (!state) return null;
  if (state.revoked) return "revoked";
  if (state.dailyCap > 0n && state.remaining === 0n) return "daily_cap_exhausted";
  return null;
}

/**
 * Whole units, for output a person reads rather than a machine.
 * A mandate denominated in wei is unreadable at demo speed.
 */
export function formatMandateUnits(value: bigint, decimals = MANDATE.decimals): string {
  if (!Number.isSafeInteger(decimals) || decimals <= 0 || decimals > 36) {
    return value.toString();
  }
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  const rendered = fraction.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return rendered ? `${whole}.${rendered}` : whole.toString();
}

export function describeRefusal(reason: MandateRefusal, state: MandateState): string {
  if (reason === "revoked") {
    return (
      `The owner revoked mandate #${state.mandateId} on ${state.chain}. ` +
      `No spending is authorised, whatever this agent's own cap allows.`
    );
  }
  return (
    `Today's mandate budget is spent: ${formatMandateUnits(state.spentToday)} of ` +
    `${formatMandateUnits(state.dailyCap)} drawn on ${state.chain}. ` +
    `The mandate resets at the next UTC day.`
  );
}
