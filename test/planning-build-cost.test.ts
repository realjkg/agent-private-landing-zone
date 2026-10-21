import test from "node:test";
import assert from "node:assert/strict";
import { comparePlanningBuildCost, type BuildCostScenario } from "../src/economics/planning-build.js";
const scenario=():BuildCostScenario=>({
 id:"lz-config-review",workloadFingerprint:"a".repeat(64),
 sourceCommit:"b".repeat(40),expectedOutcome:"Reviewed blueprint and equivalent IaC preview",
 baselineOutcomeVerified:true,candidateOutcomeVerified:true,
 baseline:{entries:[
  {lane:"AI_INFERENCE",basis:"OBSERVED",metric:"METERED_INFERENCE",costCents:250,evidenceRef:"evidence://baseline/ai"},
  {lane:"INFRASTRUCTURE",basis:"OBSERVED",metric:"COMPUTE",costCents:750,evidenceRef:"evidence://baseline/compute"},
  {lane:"ENGINEERING_RUNTIME",basis:"OBSERVED",metric:"COMPUTE",costCents:100,evidenceRef:"evidence://baseline/runtime"}
 ]},
 candidate:{entries:[
  {lane:"AI_INFERENCE",basis:"OBSERVED",metric:"METERED_INFERENCE",costCents:125,evidenceRef:"evidence://candidate/ai"},
  {lane:"INFRASTRUCTURE",basis:"OBSERVED",metric:"COMPUTE",costCents:100,evidenceRef:"evidence://candidate/compute"},
  {lane:"ENGINEERING_RUNTIME",basis:"OBSERVED",metric:"COMPUTE",costCents:175,evidenceRef:"evidence://candidate/runtime"}
 ]}
});
test("same-workload observed run produces lane-level reduction without asserting invoice savings",()=>{
 const r=comparePlanningBuildCost(scenario());
 assert.equal(r.status,"OBSERVED_REDUCTION");
 assert.equal(r.baselineCents,1100);
 assert.equal(r.candidateCents,400);
 assert.equal(r.deltaCents,700);
 assert.equal(r.savingsBps,6364);
 assert.equal(r.byLane.find(x=>x.lane==="ENGINEERING_RUNTIME")?.deltaCents,-75);
 assert.equal(r.invoiceSavingsVerified,false);
 assert.equal(r.infrastructureAct,"DISABLED");
});
test("estimated costs cannot be presented as measured savings",()=>{
 const s=scenario();s.candidate.entries[0].basis="ESTIMATED";
 const r=comparePlanningBuildCost(s);
 assert.equal(r.status,"ESTIMATE_ONLY");
 assert.equal(r.invoiceSavingsVerified,false);
});
test("unequal or unverified outcomes invalidate a cost comparison",()=>{
 const s=scenario();s.candidateOutcomeVerified=false;
 assert.equal(comparePlanningBuildCost(s).status,"NOT_COMPARABLE");
});
test("reused evidence, malformed sources and negative costs fail closed",()=>{
 const s=scenario();s.candidate.entries[0].evidenceRef=s.baseline.entries[0].evidenceRef;
 assert.ok(comparePlanningBuildCost(s).issues.includes("REUSED_EVIDENCE_ACROSS_RUNS"));
 const t=scenario();t.sourceCommit="main";
 assert.ok(comparePlanningBuildCost(t).issues.includes("WORKLOAD_BINDING_INVALID"));
 const u=scenario();u.candidate.entries[0].costCents=-1;
 assert.equal(comparePlanningBuildCost(u).status,"NOT_COMPARABLE");
});
test("a more expensive candidate reports an increase, not imaginary savings",()=>{
 const s=scenario();s.candidate.entries[1].costCents=1500;
 const r=comparePlanningBuildCost(s);
 assert.equal(r.status,"OBSERVED_NO_REDUCTION");
 assert.ok(r.deltaCents!<0);
});
test("zero-cost baseline never manufactures a savings percentage",()=>{
 const s=scenario();
 for(const x of s.baseline.entries)x.costCents=0;
 const r=comparePlanningBuildCost(s);
 assert.equal(r.savingsBps,null);
 assert.equal(r.status,"OBSERVED_NO_REDUCTION");
});
