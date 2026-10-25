/**
 * Immutable source-identity claim for the Sovereign ALZ accelerator.
 *
 * This is a public attribution fingerprint, NOT a secret watermark, digital
 * signature, trademark registration certificate, or proof of legal title.
 * Release provenance separately binds each artifact to its source commit and
 * file hashes. The MIT license permits commercial use by services providers.
 */
import { sha256 } from "../util/sha256.js";
import { BRAND_IDENTITY } from "../brand/identity.js";

/** Compatibility projection of the canonical brand record; not a second authority. */
export const SOVEREIGN_ALZ_ORIGIN = Object.freeze({
  project: "Sovereign Agent Private Landing Zone",
  author: BRAND_IDENTITY.originalAuthor,
  trademark: BRAND_IDENTITY.productMark,
  trademarkClaimant: BRAND_IDENTITY.originalAuthor,
  license: BRAND_IDENTITY.softwareLicense,
  repository: BRAND_IDENTITY.sourceRepository.replace("https://github.com/", ""),
} as const);

/** Stable across builds; the source commit identifies the particular build. */
export const SOVEREIGN_ALZ_ORIGIN_SHA256 =
  sha256(JSON.stringify(SOVEREIGN_ALZ_ORIGIN));

export type ReleaseSourceOrigin = typeof SOVEREIGN_ALZ_ORIGIN & {
  identitySha256: string;
};

export function releaseSourceOrigin(): ReleaseSourceOrigin {
  return {
    ...SOVEREIGN_ALZ_ORIGIN,
    identitySha256: SOVEREIGN_ALZ_ORIGIN_SHA256,
  };
}

export function validReleaseSourceOrigin(
  value: unknown,
): value is ReleaseSourceOrigin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expected = releaseSourceOrigin();
  const keys = Object.keys(expected).sort();
  if (Object.keys(record).sort().join("\0") !== keys.join("\0")) {
    return false;
  }
  return Object.entries(expected).every(([key, entry]) => record[key] === entry);
}
