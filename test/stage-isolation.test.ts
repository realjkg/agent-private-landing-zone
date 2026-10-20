import test from "node:test";
import assert from "node:assert/strict";
import { admitStagePlan, type StageTarget, type StagePlan, type PromotionAttestation } from "../src/governance/stage-isolation.js";
const hash=(char:string)=>char.repeat(64);
const target=(stage:StageTarget["stage"], n:string):StageTarget=>({
 tenantId:"tenant-01",environmentId:"env-"+n,stage,provider:"AWS",
 accountOrProject:"account-"+n,region:"us-east-1",
 executionIdentityRef:"secret://auth/"+n,
 stateNamespace:"tenant-01/"+stage.toLowerCase()+"/env-"+n+"/terraform",
 evidenceNamespace:"tenant-01/"+stage.toLowerCase()+"/env-"+n+"/evidence",
 keyScopeRef:"vault://keys/tenant-01/"+stage.toLowerCase()+"/env-"+n
});
const dev=target("DEVELOPMENT","dev");
const staging=target("STAGING","stage");
const prod=target("PRODUCTION","prod");
const plan=(t:StageTarget,capability:StagePlan["capability"]="PREVIEW"):StagePlan=>({
 target:t,capability,blueprintSha256:hash("a"),sealedPlanSha256:hash("b"),
 evidence:"OBSERVED",policyEvidenceRef:"evidence://policy/ok",
 inventoryEvidenceRef:"evidence://inventory/ok",recoveryEvidenceRef:"evidence://recovery/ok",
 approvalEvidenceRef:"evidence://approval/ok"
});
const attest=(from:StageTarget,to:StageTarget):PromotionAttestation=>({
 from,to,blueprintSha256:hash("a"),sealedPlanSha256:hash("b"),
 verifiedSourcePlanSha256:hash("c"),
 independentReviewRef:"evidence://promotion/independent-review",approvedBy:"reviewer-02"
});
test("development previews and reads remain available without production approval",()=>{
 assert.equal(admitStagePlan({plan:plan(dev),authenticatedTarget:dev,operation:"PREVIEW"}).permitted,true);
 assert.equal(admitStagePlan({plan:plan(dev,"READ"),authenticatedTarget:dev,operation:"READ"}).permitted,true);
});
test("development apply still requires authentic policy/inventory/recovery/approval evidence",()=>{
 assert.equal(admitStagePlan({plan:plan(dev,"APPLY"),authenticatedTarget:dev,operation:"APPLY"}).permitted,true);
 const r=admitStagePlan({plan:{...plan(dev,"APPLY"),evidence:"FIXTURE",approvalEvidenceRef:undefined},authenticatedTarget:dev,operation:"APPLY"});
 assert.ok(r.reasons.includes("FIXTURE_NOT_APPLY_EVIDENCE"));
 assert.ok(r.reasons.includes("APPLY_EVIDENCE_MISSING_approvalEvidenceRef"));
});
test("production and staging require independent stage-to-stage promotion",()=>{
 assert.ok(admitStagePlan({plan:plan(staging,"APPLY"),authenticatedTarget:staging,operation:"APPLY"}).reasons.includes("PROMOTION_ATTESTATION_REQUIRED"));
 assert.equal(admitStagePlan({plan:plan(staging,"APPLY"),authenticatedTarget:staging,operation:"APPLY",promotion:attest(dev,staging)}).permitted,true);
 assert.equal(admitStagePlan({plan:plan(prod,"APPLY"),authenticatedTarget:prod,operation:"APPLY",promotion:attest(staging,prod)}).permitted,true);
 assert.ok(admitStagePlan({plan:plan(prod,"APPLY"),authenticatedTarget:prod,operation:"APPLY",promotion:attest(dev,prod)}).reasons.includes("PROMOTION_SEQUENCE_INVALID"));
});
test("cross-tenant or cross-stage authenticated targets cannot reuse developer grants",()=>{
 const r=admitStagePlan({plan:plan(dev,"PREVIEW"),authenticatedTarget:{...dev,tenantId:"tenant-02"},operation:"PREVIEW"});
 assert.ok(r.reasons.includes("AUTHENTICATED_TARGET_MISMATCH"));
});
test("stage paths and key scopes cannot alias another environment",()=>{
 const tampered={...staging,stateNamespace:dev.stateNamespace,keyScopeRef:dev.keyScopeRef};
 const r=admitStagePlan({plan:plan(tampered),authenticatedTarget:tampered,operation:"PREVIEW"});
 assert.ok(r.reasons.includes("STATE_NAMESPACE_CROSS_BOUNDARY"));
 assert.ok(r.reasons.includes("KEY_SCOPE_CROSS_BOUNDARY"));
});
test("promotion must not reuse account, execution identity or sealed review bytes",()=>{
 const duplicate={...prod,accountOrProject:staging.accountOrProject};
 const r=admitStagePlan({plan:plan(duplicate,"APPLY"),authenticatedTarget:duplicate,
 operation:"APPLY",promotion:attest(staging,duplicate)});
 assert.ok(r.reasons.includes("PROMOTION_BOUNDARY_REUSED"));
 const stale=attest(staging,prod);stale.blueprintSha256=hash("d");
 assert.ok(admitStagePlan({plan:plan(prod,"APPLY"),authenticatedTarget:prod,
 operation:"APPLY",promotion:stale}).reasons.includes("PROMOTION_ARTIFACT_MISMATCH"));
});
test("no provider fallback, implicit stage, unknown fields or apply scope escalation",()=>{
 const unknown={...dev,stage:"DEV" as StageTarget["stage"],provider:"AWS" as const};
 assert.ok(admitStagePlan({plan:plan(unknown),authenticatedTarget:unknown,operation:"PREVIEW"}).reasons.includes("STAGE_INVALID"));
 const extra={...dev,unexpected:true};
 assert.ok(admitStagePlan({plan:plan(extra),authenticatedTarget:extra,operation:"PREVIEW"}).reasons.includes("STAGE_TARGET_FIELD_UNKNOWN"));
 assert.ok(admitStagePlan({plan:plan(dev,"PREVIEW"),authenticatedTarget:dev,operation:"APPLY"}).reasons.includes("OPERATION_SCOPE_MISMATCH"));
});

test("malformed stage namespace values fail closed instead of throwing",()=>{
 const malformed={...dev,stateNamespace:undefined as unknown as string,
 evidenceNamespace:undefined as unknown as string,keyScopeRef:undefined as unknown as string};
 const r=admitStagePlan({plan:plan(malformed),authenticatedTarget:malformed,operation:"PREVIEW"});
 assert.equal(r.permitted,false);
 assert.ok(r.reasons.includes("STATE_NAMESPACE_CROSS_BOUNDARY"));
 assert.ok(r.reasons.includes("KEY_SCOPE_CROSS_BOUNDARY"));
});
