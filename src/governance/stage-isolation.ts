import { sha256 } from "../util/sha256.js";

/** A tenant/stage identity must be bound to every blueprint and action.
 * This is a deterministic admission gate, not an infrastructure apply path.
 */
export type Stage = "DEVELOPMENT" | "STAGING" | "PRODUCTION";
export type Cloud = "AWS" | "AZURE" | "GCP" | "PRIVATE";
export type StageTarget = {
  tenantId: string;
  environmentId: string;
  stage: Stage;
  provider: Cloud;
  accountOrProject: string;
  region: string;
  executionIdentityRef: string;
  stateNamespace: string;
  evidenceNamespace: string;
  keyScopeRef: string;
};
export type StagePlan = {
  blueprintSha256: string;
  sealedPlanSha256: string;
  target: StageTarget;
  capability: "READ" | "PREVIEW" | "APPLY";
  evidence: "FIXTURE" | "OBSERVED";
  policyEvidenceRef?: string;
  inventoryEvidenceRef?: string;
  recoveryEvidenceRef?: string;
  approvalEvidenceRef?: string;
};
export type PromotionAttestation = {
  from: StageTarget;
  to: StageTarget;
  blueprintSha256: string;
  sealedPlanSha256: string;
  verifiedSourcePlanSha256: string;
  independentReviewRef: string;
  approvedBy: string;
};
export type StageAdmission = { permitted: boolean; reasons: string[]; bindingSha256?: string };
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,95}$/;
const REF=/^(?:evidence|secret|vault|keyring):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,180}$/;
const HASH=/^[a-f0-9]{64}$/;
const REG=/^[a-z][a-z0-9-]{1,47}$/;
const NAMESPACE=/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,190}$/;
const TARGET_FIELDS=["tenantId","environmentId","stage","provider","accountOrProject","region","executionIdentityRef","stateNamespace","evidenceNamespace","keyScopeRef"] as const;
function checkTarget(target: StageTarget, reasons: string[]): void {
  if (!target || typeof target!=="object" || Array.isArray(target)) {
    reasons.push("STAGE_TARGET_MISSING");return;
  }
  if (Object.keys(target).some(k=>!TARGET_FIELDS.includes(k as typeof TARGET_FIELDS[number])))
    reasons.push("STAGE_TARGET_FIELD_UNKNOWN");
  for (const k of ["tenantId","environmentId","accountOrProject"] as const)
    if (typeof target[k]!=="string" || !ID.test(target[k])) reasons.push("STAGE_TARGET_INVALID_"+k);
  for (const k of ["stateNamespace","evidenceNamespace"] as const)
    if(typeof target[k]!=="string" || !NAMESPACE.test(target[k]) || target[k].includes(".."))
      reasons.push("STAGE_NAMESPACE_INVALID_"+k);
  if (!["DEVELOPMENT","STAGING","PRODUCTION"].includes(target.stage))
    reasons.push("STAGE_INVALID");
  if (!["AWS","AZURE","GCP","PRIVATE"].includes(target.provider))
    reasons.push("PROVIDER_INVALID");
  if (typeof target.region!=="string" || !REG.test(target.region)) reasons.push("REGION_INVALID");
  for (const k of ["executionIdentityRef","keyScopeRef"] as const)
    if (typeof target[k]!=="string" || !REF.test(target[k]))
      reasons.push("STAGE_REF_INVALID_"+k);
  // State, evidence and key paths are stage and tenant namespaced. Never
  // infer an omitted stage from provider defaults or environment aliases.
  const prefix=String(target.tenantId)+"/"+String(target.stage).toLowerCase()+"/"+String(target.environmentId)+"/";
  if (typeof target.stateNamespace!=="string" || !target.stateNamespace.startsWith(prefix)) reasons.push("STATE_NAMESPACE_CROSS_BOUNDARY");
  if (typeof target.evidenceNamespace!=="string" || !target.evidenceNamespace.startsWith(prefix)) reasons.push("EVIDENCE_NAMESPACE_CROSS_BOUNDARY");
  const keyScope=target.tenantId+"/"+target.stage.toLowerCase()+"/"+target.environmentId;
  if (typeof target.keyScopeRef!=="string" || !target.keyScopeRef.endsWith("/"+keyScope))
    reasons.push("KEY_SCOPE_CROSS_BOUNDARY");
}
function reference(x: unknown): boolean {return typeof x==="string" && REF.test(x) && !x.includes("..");}
function sameTarget(a:StageTarget,b:StageTarget):boolean {
  return Boolean(a && b) && TARGET_FIELDS.every(k=>a[k]===b[k]);
}
function stageIndex(x:Stage):number {return ["DEVELOPMENT","STAGING","PRODUCTION"].indexOf(x);}
export function admitStagePlan(input: {
  plan: StagePlan;
  authenticatedTarget: StageTarget;
  operation: "READ" | "PREVIEW" | "APPLY";
  promotion?: PromotionAttestation;
}): StageAdmission {
  const reasons:string[]=[];
  const {plan,authenticatedTarget,operation,promotion}=input;
  if (!plan || typeof plan!=="object")return {permitted:false,reasons:["PLAN_MISSING"]};
  checkTarget(plan.target,reasons);
  checkTarget(authenticatedTarget,reasons);
  if (!HASH.test(plan.blueprintSha256??"")) reasons.push("BLUEPRINT_HASH_INVALID");
  if (!HASH.test(plan.sealedPlanSha256??"")) reasons.push("SEALED_PLAN_HASH_INVALID");
  if (!["READ","PREVIEW","APPLY"].includes(plan.capability)) reasons.push("CAPABILITY_INVALID");
  if (operation!==plan.capability) reasons.push("OPERATION_SCOPE_MISMATCH");
  if (!sameTarget(plan.target,authenticatedTarget)) reasons.push("AUTHENTICATED_TARGET_MISMATCH");
  if (operation==="APPLY") {
    if (plan.evidence!=="OBSERVED") reasons.push("FIXTURE_NOT_APPLY_EVIDENCE");
    for(const k of ["policyEvidenceRef","inventoryEvidenceRef","recoveryEvidenceRef","approvalEvidenceRef"] as const)
      if(!reference(plan[k])) reasons.push("APPLY_EVIDENCE_MISSING_"+k);
  }
  if (plan.target.stage!=="DEVELOPMENT" && operation==="APPLY") {
    if (!promotion) reasons.push("PROMOTION_ATTESTATION_REQUIRED");
    else {
      checkTarget(promotion.from,reasons);
      checkTarget(promotion.to,reasons);
      if (promotion.from.tenantId!==plan.target.tenantId ||
          promotion.from.provider!==plan.target.provider ||
          promotion.from.environmentId===plan.target.environmentId ||
          promotion.from.accountOrProject===plan.target.accountOrProject ||
          promotion.from.executionIdentityRef===plan.target.executionIdentityRef ||
          promotion.from.stateNamespace===plan.target.stateNamespace ||
          promotion.from.keyScopeRef===plan.target.keyScopeRef)
        reasons.push("PROMOTION_BOUNDARY_REUSED");
      if (!sameTarget(promotion.to,plan.target)) reasons.push("PROMOTION_TARGET_MISMATCH");
      if (stageIndex(promotion.from.stage)!==stageIndex(plan.target.stage)-1)
        reasons.push("PROMOTION_SEQUENCE_INVALID");
      if (promotion.blueprintSha256!==plan.blueprintSha256 ||
          promotion.sealedPlanSha256!==plan.sealedPlanSha256 ||
          !HASH.test(promotion.verifiedSourcePlanSha256??""))
        reasons.push("PROMOTION_ARTIFACT_MISMATCH");
      if (!reference(promotion.independentReviewRef) ||
          !ID.test(promotion.approvedBy??"")) reasons.push("PROMOTION_REVIEW_MISSING");
    }
  }
  if (reasons.length)return {permitted:false,reasons:[...new Set(reasons)]};
  return {permitted:true,reasons:[],bindingSha256:sha256(JSON.stringify({
    target:plan.target,blueprintSha256:plan.blueprintSha256,sealedPlanSha256:plan.sealedPlanSha256,
    operation,sourcePlanSha256:promotion?.verifiedSourcePlanSha256??null
  }))};
}
