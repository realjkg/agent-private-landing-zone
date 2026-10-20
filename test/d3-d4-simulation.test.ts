import assert from "node:assert/strict";
import test from "node:test";
import { simulateD3D4, SIMULATION_CASES, simulateD3Preflight } from "../src/qualification/d3-d4-simulation.js";

const commit="f".repeat(40);
test("D3/D4 sim campaign covers all injected expected failures and baseline controls",()=>{
 const campaign=simulateD3D4(commit);
 assert.equal(campaign.passed,true,JSON.stringify(campaign.cases.filter(c=>!c.matched)));
 assert.equal(campaign.cases.length,SIMULATION_CASES.length);
 assert.equal(campaign.cases.filter(x=>x.lane==="D3").length,6);
 assert.equal(campaign.cases.filter(x=>x.lane==="D4").length,6);
 for(const c of campaign.cases) {
   assert.equal(c.matched,true,c.name);
   assert.equal(c.actEnabled,false);
   assert.equal(c.actualInference,"NOT_RUN");
   assert.equal(c.actualAwsDiscovery,"NOT_RUN");
   assert.equal(c.actualAwsPreview,"NOT_RUN");
   assert.equal(c.evidenceClass,"SIMULATED");
   if(c.expected==="REJECT")assert.ok(c.reasons.length>0,c.name);
 }
});
test("a synthetically passing prelive campaign never self-qualifies live release",()=>{
 const result=simulateD3D4(commit);
 assert.equal(result.releaseAdmission,false);
 assert.equal(result.qualification,"PRELIVE_ONLY");
 assert.equal(result.evidenceClass,"SIMULATED");
 assert.equal(result.sourceCommit,commit);
});
test("evidence hash binds source and case disposition",()=>{
 const a=simulateD3D4(commit);
 const b=simulateD3D4(commit);
 assert.equal(a.digest,b.digest);
 assert.notEqual(a.digest,simulateD3D4("e".repeat(40)).digest);
 assert.equal(a.digest.length,64);
});
test("unbound source SHA fails closed",()=>{
 assert.throws(()=>simulateD3D4("main"),/SIMULATION_SOURCE_COMMIT_INVALID/);
});

test("simulated D3 preflight runs real metadata validator with injected responses", async () => {
 const r = await simulateD3Preflight();
 assert.equal(r.matched, true);
 assert.equal(r.releaseAdmission, false);
});
