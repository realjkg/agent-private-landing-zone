import test from "node:test";
import assert from "node:assert/strict";
import { completeLandingZoneBlueprint, type LandingZoneBlueprint } from "../src/integrations/ai-studio/blueprint-completion.js";
import { admitBlueprintForEnvironment, type BlueprintRelease } from "../src/integrations/ai-studio/blueprint-release.js";
import { assessNativeAwsPlan } from "../src/integrations/ai-studio/aws-native-plan.js";
import { assessEarlyAwsExecution, type ExecutionRequest } from "../src/integrations/ai-studio/aws-execution.js";
import { createBlueprintInventory, transitionBlueprintItem } from "../src/integrations/ai-studio/blueprint-inventory.js";
const now="2026-10-19T19:00:00Z";
const value:LandingZoneBlueprint={
 schemaVersion:1,blueprintId:"qual-001",provider:"AWS",scope:"APPLICATION_LANDING_ZONE",
 governance:{managementAccountId:"111111111111",homeRegion:"us-east-1",governedRegions:["us-east-1"],
   discoveryEvidenceRef:"evidence://discovery/controltower"},
 environments:{devAccountId:"222222222222",nonProdAccountId:"333333333333",productionAccountId:"444444444444",
   devAccountAlias:"dev",nonProdAccountAlias:"qa",productionAccountAlias:"prod",
   separateStateBackends:true,separateExecutionIdentities:true},
 architecture:{accountTopology:"three distinct workload accounts",networkDesign:"pre-approved VPC",
   identityDesign:"dedicated federated identities",loggingDesign:"central CloudTrail",
   encryptionDesign:"customer KMS",monitoringDesign:"OTEL metrics",recoveryDesign:"versioned restore"},
 policies:{authorityRef:"policy-review-01",inheritedPolicies:["scp"],proposedControls:[],
   compatibilityEvidenceRef:"evidence://policy/compat"},
 execution:{engine:"TERRAFORM",stateOwnershipRef:"evidence://state/ownership",validationEvidenceRef:"evidence://scan/validation",
   costEstimateEvidenceRef:"evidence://cost/estimate",scanEvidenceRef:"evidence://scan/security",
   rollbackEvidenceRef:"evidence://recovery/runbook"}
};
test("offline sequence: complete blueprint, inspect real-format plan, approve DEV, verify Non-Prod, admit PROD",()=>{
 const completion=completeLandingZoneBlueprint(value);
 assert.equal(completion.complete,true);
 const blueprint:BlueprintRelease={
  state:"APPROVED",blueprintSha256:completion.sha256!,
  approvedBlueprintSha256:completion.sha256!,reviewEvidenceRef:"evidence://approval/blueprint",
  releaseIdentity:completion.releaseIdentity!
 };
 const governanceEvidence={organization:"EXISTS",landingZone:"EXISTS",managementAccountVerified:true} as const;
 const nativePlan={engine:"TERRAFORM" as const,payload:{resource_changes:[{
  address:"aws_cloudwatch_log_group.app",type:"aws_cloudwatch_log_group",change:{actions:["create"]}
 }]}};
 assert.equal(assessNativeAwsPlan(nativePlan,governanceEvidence).allowed,true);
 const candidate:ExecutionRequest={
  provider:"AWS",engine:"TERRAFORM",environment:"DEV",operation:"APPLY",caller:"OPERATOR",
  targetClass:"INTERNAL_PILOT",governance:"EXISTING_CONTROL_TOWER",
  governanceEvidence,resourceActions:[{resourceType:"aws_cloudwatch_log_group",action:"CREATE"}],
  blueprint,nativePlan,pilotContractAuthorized:true,engineQualified:true,
  targetIdentityVerified:true,sealedArtifactVerified:true,signedApprovalsVerified:true
 };
 assert.equal(assessEarlyAwsExecution(candidate).status,"PILOT_ELIGIBLE");
 assert.equal(assessEarlyAwsExecution({...candidate,environment:"QA"}).status,"BLOCKED");
 const dev={...blueprint,devVerifiedReleaseIdentity:blueprint.releaseIdentity};
 assert.equal(admitBlueprintForEnvironment(dev,"QA","APPLY").allowed,true);
 assert.equal(assessEarlyAwsExecution({...candidate,environment:"QA",blueprint:dev}).status,"PILOT_ELIGIBLE");
 const promoted={...dev,nonProdVerifiedReleaseIdentity:blueprint.releaseIdentity};
 assert.equal(admitBlueprintForEnvironment(promoted,"PROD","APPLY").allowed,true);
 assert.equal(assessEarlyAwsExecution({...candidate,environment:"PROD",blueprint:promoted}).status,"PILOT_ELIGIBLE");
 let inventory=createBlueprintInventory("qual-001",[{
  id:"app-logs",kind:"WORKLOAD",provider:"AWS",resourceType:"aws_cloudwatch_log_group",
  action:"CREATE",state:"REQUESTED",sourceOfTruth:"BLUEPRINT",evidenceRefs:[],updatedAt:now
 }]);
 for(const [n,state] of ["PLANNED","VALIDATING","AWAITING_APPROVAL","APPROVED","EXECUTING","VERIFYING","SUCCEEDED"].entries())
  inventory=transitionBlueprintItem(inventory,{itemId:"app-logs",to:state as typeof inventory.items[number]["state"],
   at:now,sourceRef:"offline-adapter-"+n,evidenceRefs:["evidence://synthetic/"+n]});
 assert.equal(inventory.counts.SUCCEEDED,1);
});
test("offline sequence: hidden parallel Control Tower root prevents execution",()=>{
 const bad={engine:"TERRAFORM" as const,payload:{resource_changes:[
  {type:"aws_cloudwatch_log_group",change:{actions:["create"]}},
  {type:"aws_controltower_landing_zone",change:{actions:["create"]}}
 ]}};
 assert.equal(assessNativeAwsPlan(bad,{organization:"EXISTS",landingZone:"EXISTS",managementAccountVerified:true}).allowed,false);
});
