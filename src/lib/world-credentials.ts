/**
 * The World ID credential registry.
 *
 * Kept in its own module, free of `node:crypto` and the database, because both
 * the server that verifies proofs and the browser that captures them need to
 * agree on exactly one list. A duplicated copy in the client bundle is a copy
 * that will eventually disagree about which credential a seller holds.
 */

/** The IDKit preset factory the browser must call for a credential. */
export type PresetName =
  | "selfieCheckLegacy"
  | "orbLegacy"
  | "deviceLegacy"
  | "documentLegacy"
  | "secureDocumentLegacy"
  | "proofOfHuman"
  | "passport";

export interface CredentialSpec {
  /** Shown in the UI and in error messages. */
  label: string;
  /** What the credential actually attests, in one line. */
  assurance: string;
  /** Which IDKit preset the client requests. */
  preset: PresetName;
  /**
   * `allow_legacy_proofs` for the IDKit request. This is not a preference:
   * the legacy presets return World ID 3.0 proofs and IDKit refuses the
   * request outright unless legacy proofs are permitted. General World
   * guidance is to prefer `false` for new apps, which points in exactly the
   * opposite direction from what these credentials require.
   */
  legacyProofs: boolean;
  /**
   * Identifiers World may report for a passing proof of this credential.
   *
   * This is the downgrade guard. A proof carries which credential actually
   * satisfied it, and we store that against the seller — so accepting any
   * passing identifier would let a device-level proof be recorded as a
   * Selfie Check pass. Only identifiers listed here count.
   *
   * `face` appears alongside `selfie` because IDKit normalises the legacy
   * `verification_level` of `face` to the identifier `selfie`; both spellings
   * are accepted so the guard does not depend on which transport was used.
   */
  identifiers: string[];
  /** True when World must enable a feature flag before this credential works. */
  gated: boolean;
}

export const CREDENTIALS: Record<string, CredentialSpec> = {
  selfie_check: {
    label: "Selfie Check",
    assurance: "A distinct live human, proven by face capture.",
    preset: "selfieCheckLegacy",
    legacyProofs: true,
    identifiers: ["selfie", "face"],
    gated: true,
  },
  proof_of_human: {
    label: "Proof of Human",
    assurance: "A distinct human, World ID 4.0 with Orb fallback.",
    preset: "proofOfHuman",
    legacyProofs: true,
    identifiers: ["proof_of_human", "orb"],
    gated: false,
  },
  orb: {
    label: "Orb",
    assurance: "A distinct human, proven by in-person iris verification.",
    preset: "orbLegacy",
    legacyProofs: true,
    identifiers: ["orb"],
    gated: false,
  },
  document: {
    label: "Document",
    assurance: "A holder of a verified identity document.",
    preset: "documentLegacy",
    legacyProofs: true,
    identifiers: ["document"],
    gated: false,
  },
  secure_document: {
    label: "Secure Document",
    assurance: "A holder of a chip-verified identity document.",
    preset: "secureDocumentLegacy",
    legacyProofs: true,
    identifiers: ["secure_document"],
    gated: false,
  },
  passport: {
    label: "Passport",
    assurance: "A passport holder, World ID 4.0.",
    preset: "passport",
    legacyProofs: false,
    identifiers: ["passport"],
    gated: false,
  },
  device: {
    label: "Device",
    assurance: "A distinct World App install. Weak: one human can hold several.",
    preset: "deviceLegacy",
    legacyProofs: true,
    identifiers: ["device"],
    gated: false,
  },
};

export const DEFAULT_CREDENTIAL = "selfie_check";

/** Credential ids this app can legitimately have obtained from World. */
export const REAL_CREDENTIALS: ReadonlySet<string> = new Set(Object.keys(CREDENTIALS));

/** Simulated passes must never render as the real thing. */
export const SIMULATED_CREDENTIAL = "selfie_check_simulated";

export function credentialLabel(credential: string | null | undefined): string {
  if (!credential) return "World ID";
  if (credential === SIMULATED_CREDENTIAL) return "World ID · simulated";
  return CREDENTIALS[credential]?.label ?? "World ID";
}
