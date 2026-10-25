import { sha256 } from "../util/sha256.js";

/**
 * Stable, non-secret origin attribution for the MIT-licensed accelerator.
 *
 * Owner supplied: original author JK Gonzalez; registered mark designation
 * Sovereign ALZ®. This is an attribution fingerprint, NOT a cryptographic
 * signature, registry attestation, license check, or permission to ACT.
 * A fork can alter source; release integrity must use the separate source
 * commit, signed provenance and artifact checks.
 */
export const BRAND_IDENTITY = Object.freeze({
  product: "agent-private-landing-zone",
  productMark: "Sovereign ALZ®",
  originalAuthor: "JK Gonzalez",
  copyrightHolder: "Adapt Cloud",
  softwareLicense: "MIT",
  sourceRepository: "https://github.com/realjkg/agent-private-landing-zone",
  registrationBasis: "OWNER_ATTESTED_REGISTERED",
} as const);

export const BRAND_FINGERPRINT = sha256(
  "ALZ-BRAND-IDENTITY-v1\n" + JSON.stringify(BRAND_IDENTITY),
);

export const BRAND_PROVENANCE = Object.freeze({
  ...BRAND_IDENTITY,
  fingerprintSha256: BRAND_FINGERPRINT,
});

export type BrandProvenance = typeof BRAND_PROVENANCE;

export function matchesBrandProvenance(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const expected = BRAND_PROVENANCE as Record<string, unknown>;
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, v]) => actual[key] === v);
}
