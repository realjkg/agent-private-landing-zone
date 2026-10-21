import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../src/util/sha256.js";
import { completeLandingZoneBlueprint, type LandingZoneBlueprint } from "../src/integrations/ai-studio/blueprint-completion.js";
import { inspectBlueprintNativePlanBinding, type BlueprintPlanReview } from "../src/integrations/ai-studio/blueprint-plan-binding.js";

const b: LandingZoneBlueprint={
  schemaVersion:1,blueprintId:"release-01",provider:"AWS",scope:"APPLICATION_LANDING_ZONE",
  governance:{managementAccountId:"111111111111",homeRegion:"us-east-1",
    governedRegions:["us-east-1"],discoveryEvidenceRef:"evidence://aws/discovery"},
  environments:{devAccountId:"222222222222",nonProdAccountId:"333333333333",
    productionAccountId:"444444444444",devAccountAlias:"dev",
    nonProdAccountAlias:"nonprod",productionAccountAlias:"prod",
    separateStateBackends:true,separateExecutionIdentities:true},
  architecture:{accountTopology:"three distinct accounts",networkDesign:"approved VPC",
    identityDesign:"separate roles",loggingDesign:"central audit",
    encryptionDesign:"managed encryption",monitoringDesign:"OpenTelemetry",
    recoveryDesign:"encrypted backup"},
  policies:{authorityRef:"policy-authority-1",inheritedPolicies:[],proposedControls:[],
    compatibilityEvidenceRef:"evidence://policy/compat"},
  execution:{engine:"TERRAFORM",stateOwnershipRef:"evidence://state/owner",
    validationEvidenceRef:"evidence://validation/iac",costEstimateEvidenceRef:"evidence://cost/report",
    scanEvidenceRef:"evidence://scan/report",rollbackEvidenceRef:"evidence://recovery/plan"}
};
const nativeBytes=JSON.stringify({resource_changes:[
  {address:"aws_cloudwatch_log_group.test",type:"aws_cloudwatch_log_group",change:{actions:["create"]}}
]});
function sample():BlueprintPlanReview{
  const hash=completeLandingZoneBlueprint(b).sha256!;
  return {
    blueprint:b,
    release:{state:"APPROVED",blueprintSha256:hash,approvedBlueprintSha256:hash,
      releaseIdentity:b.blueprintId,reviewEvidenceRef:"evidence://approvals/blueprint"},
    plan:{engine:"TERRAFORM",nativePlanBytes:nativeBytes,
      sealedNativePlanSha256:sha256(nativeBytes),
      target:{environment:"DEV",accountId:"222222222222",region:"us-east-1"}},
    governance:{organization:"EXISTS",landingZone:"EXISTS",managementAccountVerified:true},
    purpose:"APPLY_HANDOFF"
  };
}
test("complete, approved blueprint with a sealed native plan is ready for independent driver review",()=>{
  const out=inspectBlueprintNativePlanBinding(sample());
  assert.equal(out.status,"READY_FOR_DRIVER_REVIEW");
  assert.equal(out.nativePlanSha256,sha256(nativeBytes));
});
test("normal design review does not require final signed approval",()=>{
  const s=sample();s.purpose="REVIEW";s.release.state="COMPLETE";
  s.release.approvedBlueprintSha256=undefined;
  assert.equal(inspectBlueprintNativePlanBinding(s).status,"REVIEWABLE");
});
test("altered native plan bytes are rejected despite agent-declared safe resources",()=>{
  const s=sample();
  s.plan.nativePlanBytes=JSON.stringify({resource_changes:[
    {type:"aws_organizations_organization",change:{actions:["create"]}}]});
  const out=inspectBlueprintNativePlanBinding(s);
  assert.ok(out.reasons.includes("SEALED_NATIVE_PLAN_DIGEST_MISMATCH"));
  assert.ok(out.reasons.includes("PARALLEL_GOVERNANCE_FORBIDDEN"));
});
test("a changed blueprint invalidates released approval identity",()=>{
  const s=sample();s.blueprint={...b,architecture:{...b.architecture,networkDesign:"different"}};
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("RELEASE_BLUEPRINT_HASH_MISMATCH"));
});
test("stage, account, region and engine confusion never enter driver review",()=>{
  for(const mutate of [
    (s:BlueprintPlanReview)=>{s.plan.target.accountId="444444444444";},
    (s:BlueprintPlanReview)=>{s.plan.target.region="us-west-2";},
    (s:BlueprintPlanReview)=>{s.plan.engine="CDK";},
    (s:BlueprintPlanReview)=>{s.plan.target.environment="PROD";}
  ]){
    const s=sample();mutate(s);
    assert.equal(inspectBlueprintNativePlanBinding(s).status,"BLOCKED");
  }
});
test("unresolved bootstrap account and unverified governance cannot authorize handoff",()=>{
  const s=sample();
  s.blueprint={...b,scope:"CONTROL_TOWER_BOOTSTRAP",
    environments:{...b.environments,devAccountId:undefined},
  };
  s.release.blueprintSha256=completeLandingZoneBlueprint(s.blueprint).sha256!;
  s.release.approvedBlueprintSha256=s.release.blueprintSha256;
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("TARGET_ACCOUNT_UNVERIFIED"));
  s.governance={organization:"UNKNOWN",landingZone:"UNKNOWN",managementAccountVerified:false};
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("GOVERNANCE_DISCOVERY_NOT_ATTESTED"));
});
test("incomplete, oversized and malformed native JSON are never silently admitted",()=>{
  const s=sample();s.plan.nativePlanBytes="{oops";
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("NATIVE_PLAN_JSON_INVALID"));
  const t=sample();t.plan.nativePlanBytes=" ".repeat(4_000_001);
  assert.ok(inspectBlueprintNativePlanBinding(t).reasons.includes("NATIVE_PLAN_BYTES_INVALID"));
});
test("opaque nested infrastructure requires expansion before native review",()=>{
  const s=sample();
  const bytes=JSON.stringify({resource_changes:[{type:"aws_cloudformation_stack",change:{actions:["create"]}}]});
  s.plan.nativePlanBytes=bytes;s.plan.sealedNativePlanSha256=sha256(bytes);
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("UNKNOWN_REVIEW_REQUIRED"));
});
test("QA/PROD handoff requires separately recorded previous-stage verification",()=>{
  const s=sample();s.plan.target={environment:"QA",accountId:"333333333333",region:"us-east-1"};
  assert.ok(inspectBlueprintNativePlanBinding(s).reasons.includes("DEV_RELEASE_NOT_VERIFIED"));
  s.release.devVerifiedReleaseIdentity=b.blueprintId;
  assert.equal(inspectBlueprintNativePlanBinding(s).status,"READY_FOR_DRIVER_REVIEW");
});
