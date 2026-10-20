import { sha256 } from "../../util/sha256.js";
import { completeLandingZoneBlueprint, type LandingZoneBlueprint } from "./blueprint-completion.js";
import { admitBlueprintForEnvironment, type BlueprintRelease } from "./blueprint-release.js";
import { assessNativeAwsPlan, type NativeEngine, type NativePlan, type PlanAssessment } from "./aws-native-plan.js";
import type { GovernanceEvidence } from "./aws-governance.js";

/**
 * Preview/build reviewer boundary. Native JSON bytes must come from the
 * independently trusted IaC adapter. Neither this gate nor an agent may
 * authorize ACT; the existing sealed apply driver verifies signatures.
 */
export type BoundNativePlan = {
  engine: NativeEngine;
  /** Exact UTF-8 plan JSON serialized by the native adapter. */
  nativePlanBytes: string;
  /** Digest from an independently sealed plan/review bundle. */
  sealedNativePlanSha256: string;
  /** Independently verified targeted account and environment claim. */
  target: { environment: "DEV" | "QA" | "PROD"; accountId: string; region: string };
};
export type BlueprintPlanReview = {
  blueprint: LandingZoneBlueprint;
  release: BlueprintRelease;
  plan: BoundNativePlan;
  governance: GovernanceEvidence;
  /** A reviewer may preview; handoff requires approved blueprint metadata. */
  purpose: "REVIEW" | "APPLY_HANDOFF";
};
export type BlueprintPlanReviewResult = {
  status: "REVIEWABLE" | "READY_FOR_DRIVER_REVIEW" | "BLOCKED";
  reasons: string[];
  blueprintSha256?: string;
  nativePlanSha256?: string;
  assessment?: PlanAssessment;
};
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const MAX_NATIVE_PLAN_BYTES = 4_000_000;
const ENGINE = new Set<NativeEngine>(["TERRAFORM", "CDK", "CLOUDFORMATION", "PULUMI"]);

function expectedAccount(b: LandingZoneBlueprint, stage: BoundNativePlan["target"]["environment"]): string | undefined {
  return stage === "DEV" ? b.environments.devAccountId :
    stage === "QA" ? b.environments.nonProdAccountId : b.environments.productionAccountId;
}

export function inspectBlueprintNativePlanBinding(input: BlueprintPlanReview): BlueprintPlanReviewResult {
  const reasons: string[] = [];
  const completed = completeLandingZoneBlueprint(input.blueprint);
  if (!completed.complete || !completed.sha256)
    reasons.push("BLUEPRINT_INCOMPLETE");
  const blueprintSha256 = completed.sha256;
  const { plan, release } = input;
  if (!release || release.blueprintSha256 !== blueprintSha256)
    reasons.push("RELEASE_BLUEPRINT_HASH_MISMATCH");
  if (!plan || !ENGINE.has(plan.engine))
    return { status: "BLOCKED", reasons: [...reasons, "NATIVE_ENGINE_UNKNOWN"], blueprintSha256 };
  if (plan.engine !== input.blueprint.execution.engine)
    reasons.push("ENGINE_BLUEPRINT_MISMATCH");
  const target = plan.target;
  if (!target || !["DEV","QA","PROD"].includes(target.environment) ||
      !ACCOUNT.test(target.accountId ?? "") || !REGION.test(target.region ?? ""))
    reasons.push("TARGET_INVALID");
  else {
    const account = expectedAccount(input.blueprint,target.environment);
    // Bootstrap planning may contain logical aliases, but never admit an
    // unresolved account to this native-plan review / execution handoff.
    if (!account || account !== target.accountId)
      reasons.push("TARGET_ACCOUNT_UNVERIFIED");
    if (!input.blueprint.governance.governedRegions.includes(target.region))
      reasons.push("TARGET_REGION_NOT_GOVERNED");
  }
  let nativePlanSha256: string | undefined;
  let parsed: NativePlan | undefined;
  if (typeof plan.nativePlanBytes !== "string" ||
      Buffer.byteLength(plan.nativePlanBytes,"utf8") > MAX_NATIVE_PLAN_BYTES ||
      plan.nativePlanBytes.trim().length === 0)
    reasons.push("NATIVE_PLAN_BYTES_INVALID");
  else {
    nativePlanSha256 = sha256(plan.nativePlanBytes);
    if (!HASH.test(plan.sealedNativePlanSha256 ?? "") ||
        nativePlanSha256 !== plan.sealedNativePlanSha256)
      reasons.push("SEALED_NATIVE_PLAN_DIGEST_MISMATCH");
    try {
      const payload: unknown = JSON.parse(plan.nativePlanBytes);
      parsed = {engine:plan.engine,payload};
    } catch {
      reasons.push("NATIVE_PLAN_JSON_INVALID");
    }
  }
  let assessment: PlanAssessment | undefined;
  if (parsed) {
    assessment=assessNativeAwsPlan(parsed,input.governance);
    if (!assessment.allowed) reasons.push(...assessment.reasons);
  }
  if (input.purpose === "APPLY_HANDOFF") {
    if (!target || !["DEV","QA","PROD"].includes(target.environment))
      reasons.push("TARGET_ENVIRONMENT_MISSING");
    else {
      const approved = admitBlueprintForEnvironment(release,target.environment,"APPLY");
      reasons.push(...approved.reasons);
    }
    if (!input.governance || input.governance.organization === "UNKNOWN" ||
        input.governance.landingZone === "UNKNOWN" ||
        !input.governance.managementAccountVerified)
      reasons.push("GOVERNANCE_DISCOVERY_NOT_ATTESTED");
  } else if (input.purpose !== "REVIEW") {
    reasons.push("PURPOSE_UNKNOWN");
  }
  if (reasons.length)
    return { status:"BLOCKED",reasons:[...new Set(reasons)],blueprintSha256,nativePlanSha256,assessment };
  return {
    status: input.purpose === "REVIEW" ? "REVIEWABLE" : "READY_FOR_DRIVER_REVIEW",
    reasons:[],blueprintSha256,nativePlanSha256,assessment
  };
}
