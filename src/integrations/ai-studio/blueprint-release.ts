/** Blueprint-first release admission; this does not execute AWS operations. */
export type BlueprintRelease = {
  state: "DRAFT" | "COMPLETE" | "APPROVED";
  blueprintSha256: string;
  approvedBlueprintSha256?: string;
  reviewEvidenceRef?: string;
  releaseIdentity: string;
  devVerifiedReleaseIdentity?: string;
  nonProdVerifiedReleaseIdentity?: string;
};
export type BlueprintAdmission = { allowed: boolean; reasons: string[] };
const HASH = /^[0-9a-f]{64}$/;
const REF = /^evidence:\/\/[A-Za-z0-9._/-]{1,128}$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export function admitBlueprintForEnvironment(
  blueprint: BlueprintRelease | undefined,
  environment: "DEV" | "QA" | "PROD",
  operation: "PREVIEW" | "APPLY"
): BlueprintAdmission {
  const reasons: string[] = [];
  if (!blueprint || !HASH.test(blueprint.blueprintSha256) || !RELEASE.test(blueprint.releaseIdentity))
    return { allowed: false, reasons: ["BLUEPRINT_NOT_COMPLETED"] };
  if (blueprint.state === "DRAFT") reasons.push("BLUEPRINT_NOT_COMPLETED");
  if (operation === "APPLY" && (blueprint.state !== "APPROVED" ||
      blueprint.approvedBlueprintSha256 !== blueprint.blueprintSha256 ||
      !blueprint.reviewEvidenceRef || !REF.test(blueprint.reviewEvidenceRef)))
    reasons.push("BLUEPRINT_NOT_APPROVED");
  if (operation === "APPLY" && environment === "QA" &&
      blueprint.devVerifiedReleaseIdentity !== blueprint.releaseIdentity)
    reasons.push("DEV_RELEASE_NOT_VERIFIED");
  if (operation === "APPLY" && environment === "PROD") {
    if (blueprint.devVerifiedReleaseIdentity !== blueprint.releaseIdentity)
      reasons.push("DEV_RELEASE_NOT_VERIFIED");
    if (blueprint.nonProdVerifiedReleaseIdentity !== blueprint.releaseIdentity)
      reasons.push("NONPROD_RELEASE_NOT_VERIFIED");
  }
  return { allowed: reasons.length === 0, reasons };
}
