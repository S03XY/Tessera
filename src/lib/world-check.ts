import { signRequest } from "@worldcoin/idkit-core/signing";
import { CREDENTIALS } from "@/lib/world-credentials";
import { configurationProblem, credentialSpec, world, worldMode } from "@/lib/world";

/**
 * Does this deployment's World ID configuration actually work?
 *
 * Nothing about a World integration is verified by the app starting cleanly.
 * Four separate things must be true before a capture can succeed, and the
 * failure of any one of them is invisible until a person has already stood in
 * front of a camera — which is the most expensive moment to find out.
 *
 * So we ask World directly, by sending deliberately invalid proofs and reading
 * which error comes back. That is not a hack for want of an endpoint: World
 * distinguishes "I do not know this app" from "I know it but that proof is
 * rubbish", and those answers need completely different fixes. The Developer
 * Portal already knows all of this and does not show it.
 *
 * Nothing here is a secret. The signing key is used to sign a throwaway
 * challenge and is never returned, so this is safe to render in the UI.
 */

const V2 = "https://developer.worldcoin.org/api/v2/verify";
const V4 = "https://developer.world.org/api/v4/verify";

export type CheckState = "pass" | "fail" | "warn" | "skip";

export interface Check {
  /** Stable id, so the UI can key on it rather than on prose. */
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  /** What to go and do, when there is something to do. */
  remedy?: string;
}

export interface WorldCheckReport {
  mode: ReturnType<typeof worldMode>;
  credential: string;
  credential_label: string;
  checks: Check[];
  /** True when a real capture could succeed right now. */
  ready: boolean;
  /** Ordered, de-duplicated list of outstanding actions. */
  todo: string[];
}

async function probe(url: string, body: unknown) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as { code?: string }, text };
    } catch {
      return { status: response.status, body: null, text };
    }
  } catch (err) {
    return { status: 0, body: null, text: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWorldChecks(): Promise<WorldCheckReport> {
  const checks: Check[] = [];
  const spec = credentialSpec();

  /* ------------------------------------------------------- 1. variables */

  const problem = configurationProblem();
  checks.push(
    problem
      ? {
          id: "variables",
          label: "Environment variables",
          state: "fail",
          detail: problem,
          remedy:
            "Set the World ID variables in .env.local. WORLD_RP_ID and " +
            "WORLD_RP_SIGNING_KEY are issued together by the Developer Portal.",
        }
      : {
          id: "variables",
          label: "Environment variables",
          state: "pass",
          detail: `app ${world.appId}, rp ${world.rpId}, action "${world.action}", ${world.environment}`,
        },
  );

  /* -------------------------------------------------------- 2. signing */

  if (problem) {
    checks.push({
      id: "signing",
      label: "Request signing",
      state: "skip",
      detail: "Skipped — the configuration is incomplete.",
    });
  } else {
    try {
      const signed = signRequest({
        signingKeyHex: world.signingKey.replace(/^0x/, ""),
        action: world.action,
        ttl: 600,
      });
      checks.push({
        id: "signing",
        label: "Request signing",
        state: "pass",
        detail: `The signing key produces a valid RP signature (${signed.expiresAt - signed.createdAt}s TTL).`,
      });
    } catch (err) {
      checks.push({
        id: "signing",
        label: "Request signing",
        state: "fail",
        detail: `signRequest rejected the key: ${err instanceof Error ? err.message : String(err)}`,
        remedy: "Re-copy WORLD_RP_SIGNING_KEY from the Developer Portal.",
      });
    }
  }

  /* ------------------------------------- 3. does World know app + action */

  if (!world.appId) {
    checks.push({
      id: "action",
      label: "App and action",
      state: "skip",
      detail: "Skipped — no WORLD_APP_ID.",
    });
  } else {
    const v2 = await probe(`${V2}/${world.appId}`, {
      nullifier_hash: "0x00",
      merkle_root: "0x00",
      proof: "0x00",
      verification_level: "orb",
      action: world.action,
    });
    const code = v2.body?.code ?? `http_${v2.status}`;

    if (v2.status === 0) {
      checks.push({
        id: "action",
        label: "App and action",
        state: "warn",
        detail: `Could not reach World: ${v2.text}`,
      });
    } else if (code === "invalid_action") {
      checks.push({
        id: "action",
        label: "App and action",
        state: "fail",
        detail: `World knows the app, but not the action "${world.action}".`,
        remedy: `Create an Incognito Action with identifier "${world.action}" under the app.`,
      });
    } else if (v2.status === 404 || code === "app_not_found") {
      checks.push({
        id: "action",
        label: "App and action",
        state: "fail",
        detail: "World does not recognise this app id.",
        remedy: "Check WORLD_APP_ID against the Developer Portal.",
      });
    } else {
      // Any other code means both the app and the action resolved and World
      // got as far as rejecting our deliberately invalid proof — a pass.
      checks.push({
        id: "action",
        label: "App and action",
        state: "pass",
        detail: `World knows the app and the action "${world.action}".`,
      });
    }
  }

  /* ------------------------------------------------ 4. World ID 4.0 migration */

  if (!world.rpId) {
    checks.push({
      id: "migration",
      label: "World ID 4.0 migration",
      state: "skip",
      detail: "Skipped — no WORLD_RP_ID.",
    });
  } else {
    const v4 = await probe(`${V4}/${world.rpId}`, {
      protocol_version: "3.0",
      nonce: "0".repeat(64),
      action: world.action,
      environment: world.environment,
      responses: [
        {
          identifier: "orb",
          proof: "0x00",
          merkle_root: "0x00",
          nullifier: "0x00",
          signal_hash: "0x00",
        },
      ],
    });
    const code = v4.body?.code ?? `http_${v4.status}`;

    if (v4.status === 0) {
      checks.push({
        id: "migration",
        label: "World ID 4.0 migration",
        state: "warn",
        detail: `Could not reach World: ${v4.text}`,
      });
    } else if (code === "app_not_migrated") {
      checks.push({
        id: "migration",
        label: "World ID 4.0 migration",
        state: "fail",
        detail: "This app has not been migrated to World ID 4.0, so every proof is refused.",
        remedy:
          'Use the "Enable World ID 4.0" banner on the app in the Developer Portal. ' +
          "It issues both WORLD_RP_ID and WORLD_RP_SIGNING_KEY, and the key is shown once.",
      });
    } else if (code === "unknown_rp" || v4.status === 404) {
      checks.push({
        id: "migration",
        label: "World ID 4.0 migration",
        state: "fail",
        detail: "World does not recognise this rp_id.",
        remedy: "Check WORLD_RP_ID against the Developer Portal.",
      });
    } else {
      checks.push({
        id: "migration",
        label: "World ID 4.0 migration",
        state: "pass",
        detail: "The app is migrated and the rp_id resolves.",
      });
    }
  }

  /* ------------------------------------------------------- 5. credential */

  checks.push(
    spec.gated
      ? {
          id: "credential",
          label: `Credential — ${spec.label}`,
          state: "warn",
          detail:
            `${spec.label} is access-gated by World and must be enabled for this app ` +
            "before any capture succeeds. Everything else can be verified from here; this cannot.",
          remedy:
            `Request access from developers@toolsforhumanity.com, or set WORLD_CREDENTIAL to an ` +
            `ungated credential (${Object.entries(CREDENTIALS)
              .filter(([, value]) => !value.gated)
              .map(([id]) => id)
              .join(", ")}) to go live now.`,
        }
      : {
          id: "credential",
          label: `Credential — ${spec.label}`,
          state: "pass",
          detail: `${spec.assurance} Not access-gated.`,
        },
  );

  const todo = [...new Set(checks.map((check) => check.remedy).filter((r): r is string => !!r))];

  return {
    mode: worldMode(),
    credential: world.credential,
    credential_label: spec.label,
    checks,
    // A gated credential is a warning, not a failure, because the rest of the
    // integration is genuinely ready — but it is not "ready" either.
    ready: checks.every((check) => check.state === "pass"),
    todo,
  };
}
