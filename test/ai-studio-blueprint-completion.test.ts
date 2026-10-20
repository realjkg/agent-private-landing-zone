import test from "node:test";
import assert from "node:assert/strict";
import { blueprintReleaseFromCompleted, completeLandingZoneBlueprint, type LandingZoneBlueprint } from "../src/integrations/ai-studio/blueprint-completion.js";
const base:LandingZoneBlueprint={
 schemaVersion:1,blueprintId:"release-001",provider:"AWS",scope:"CONTROL_TOWER_REUSE",
 governance:{managementAccountId:"111111111111",homeRegion:"us-east-1",
   governedRegions:["us-east-1","us-west-2"],discoveryEvidenceRef:"evidence://discovery/aws",
   existingControlTowerLandingZoneArn:"arn:aws:controltower:us-east-1:111111111111:landingzone/example"},
 environments:{devAccountId:"222222222222",nonProdAccountId:"333333333333",
   productionAccountId:"444444444444",devAccountAlias:"dev",nonProdAccountAlias:"qa",
   productionAccountAlias:"prod",separateStateBackends:true,separateExecutionIdentities:true},
 architecture:{accountTopology:"separate governed accounts",networkDesign:"shared approved transit",
   identityDesign:"federated limited roles",loggingDesign:"central CloudTrail",encryptionDesign:"KMS per account",
   monitoringDesign:"OTEL and CloudWatch",recoveryDesign:"verified recovery"},
 policies:{authorityRef:"policy-authority-01",inheritedPolicies:["scp-encryption","scp-regions"],
   proposedControls:[],compatibilityEvidenceRef:"evidence://policy/check"},
 execution:{engine:"TERRAFORM",stateOwnershipRef:"evidence://state/owner",
   validationEvidenceRef:"evidence://iac/validation",costEstimateEvidenceRef:"evidence://cost/estimate",
   scanEvidenceRef:"evidence://scan/sbom",rollbackEvidenceRef:"evidence://recovery/plan"}
};
test("complete governed brownfield blueprint produces a deterministic release identity",()=>{
 const a=completeLandingZoneBlueprint(base);
 assert.equal(a.complete,true);
 const reordered={...base,governance:{...base.governance,governedRegions:["us-west-2","us-east-1"]}};
 assert.equal(completeLandingZoneBlueprint(reordered).sha256,a.sha256);
 assert.equal(blueprintReleaseFromCompleted(base).state,"COMPLETE");
});
test("incomplete blueprint cannot enter release gate",()=>{
 const wrong={...base,architecture:{...base.architecture,loggingDesign:""}};
 const r=completeLandingZoneBlueprint(wrong);
 assert.equal(r.complete,false);
 assert.ok(r.missing.includes("architecture.loggingDesign"));
 assert.throws(()=>blueprintReleaseFromCompleted(wrong),/BLUEPRINT_INCOMPLETE/);
});
test("duplicate account boundaries or missing state isolation block completion",()=>{
 const wrong={...base,environments:{...base.environments,productionAccountId:base.environments.devAccountId,separateStateBackends:false}};
 const r=completeLandingZoneBlueprint(wrong);
 assert.ok(r.missing.includes("environments.distinctTargets"));
 assert.ok(r.missing.includes("environments.separateStateBackends"));
});
test("first-time Control Tower blueprint can be complete before accounts have numeric IDs",()=>{
 const bootstrap:LandingZoneBlueprint={
  ...base,scope:"CONTROL_TOWER_BOOTSTRAP",
  governance:{...base.governance,existingControlTowerLandingZoneArn:undefined},
  environments:{...base.environments,devAccountId:undefined,nonProdAccountId:undefined,productionAccountId:undefined}
 };
 assert.equal(completeLandingZoneBlueprint(bootstrap).complete,true);
});
test("existing Control Tower reuse requires discovered landing zone",()=>{
 const wrong={...base,governance:{...base.governance,existingControlTowerLandingZoneArn:undefined}};
 assert.equal(completeLandingZoneBlueprint(wrong).complete,false);
});
