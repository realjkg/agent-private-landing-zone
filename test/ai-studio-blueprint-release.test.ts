import test from "node:test";
import assert from "node:assert/strict";
import { admitBlueprintForEnvironment, type BlueprintRelease } from "../src/integrations/ai-studio/blueprint-release.js";
const approved: BlueprintRelease = {
 state:"APPROVED",blueprintSha256:"a".repeat(64),approvedBlueprintSha256:"a".repeat(64),
 reviewEvidenceRef:"evidence://blueprint/signoff",releaseIdentity:"release-42"
};
test("uncompleted blueprint blocks all environment execution",()=>{
 for(const env of ["DEV","QA","PROD"] as const)
  assert.equal(admitBlueprintForEnvironment({...approved,state:"DRAFT"},env,"APPLY").allowed,false);
});
test("completed but unsigned blueprint cannot be executed",()=>{
 assert.deepEqual(admitBlueprintForEnvironment({...approved,state:"COMPLETE"},"DEV","APPLY").reasons,["BLUEPRINT_NOT_APPROVED"]);
 assert.deepEqual(admitBlueprintForEnvironment({...approved,approvedBlueprintSha256:"b".repeat(64)},"DEV","APPLY").reasons,["BLUEPRINT_NOT_APPROVED"]);
});
test("signed blueprint allows DEV only, with QA and PROD separately gated",()=>{
 assert.equal(admitBlueprintForEnvironment(approved,"DEV","APPLY").allowed,true);
 assert.ok(admitBlueprintForEnvironment(approved,"QA","APPLY").reasons.includes("DEV_RELEASE_NOT_VERIFIED"));
 assert.ok(admitBlueprintForEnvironment(approved,"PROD","APPLY").reasons.includes("NONPROD_RELEASE_NOT_VERIFIED"));
});
test("verified DEV and NONPROD release identities allow a production handoff",()=>{
 const dev={...approved,devVerifiedReleaseIdentity:"release-42"};
 assert.equal(admitBlueprintForEnvironment(dev,"QA","APPLY").allowed,true);
 assert.equal(admitBlueprintForEnvironment({...dev,nonProdVerifiedReleaseIdentity:"release-42"},"PROD","APPLY").allowed,true);
 assert.equal(admitBlueprintForEnvironment({...dev,nonProdVerifiedReleaseIdentity:"release-99"},"PROD","APPLY").allowed,false);
});
