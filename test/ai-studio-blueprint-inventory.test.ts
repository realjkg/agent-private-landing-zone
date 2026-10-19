import test from "node:test";
import assert from "node:assert/strict";
import { createBlueprintInventory, transitionBlueprintItem, verifyBlueprintInventory } from "../src/integrations/ai-studio/blueprint-inventory.js";

const at = "2026-10-19T20:00:00Z";
const make = () => createBlueprintInventory("alz-blueprint-01", [
 {id:"control-tower",kind:"GOVERNANCE",provider:"AWS",resourceType:"AWS::ControlTower::LandingZone",action:"READ",state:"REQUESTED",sourceOfTruth:"EXISTING_AWS",evidenceRefs:[],updatedAt:at},
 {id:"app-log",kind:"WORKLOAD",provider:"AWS",resourceType:"AWS::Logs::LogGroup",action:"CREATE",state:"REQUESTED",sourceOfTruth:"BLUEPRINT",evidenceRefs:[],updatedAt:at}
]);
function go(s: ReturnType<typeof make>, itemId: string, to: Parameters<typeof transitionBlueprintItem>[1]["to"], n: number) {
 return transitionBlueprintItem(s,{itemId,to,at,sourceRef:"adapter-"+n,evidenceRefs:["evidence://run/"+n]});
}
test("existing Control Tower moves to REUSED and retains evidence",()=>{
 let s=go(make(),"control-tower","DISCOVERING",1);
 s=go(s,"control-tower","REUSED",2);
 assert.equal(s.counts.REUSED,1);
 assert.equal(s.version,2);
 assert.equal(verifyBlueprintInventory(s),true);
});
test("application IaC resource reports each execution state",()=>{
 let s=make();
 for(const [i,to] of ["PLANNED","VALIDATING","AWAITING_APPROVAL","APPROVED","EXECUTING","VERIFYING","SUCCEEDED"].entries())
   s=go(s,"app-log",to as Parameters<typeof transitionBlueprintItem>[1]["to"],i+1);
 assert.equal(s.counts.SUCCEEDED,1);
 assert.equal(s.events.length,7);
 assert.equal(verifyBlueprintInventory(s),true);
});
test("invalid transition or absent approval evidence is rejected",()=>{
 assert.throws(()=>go(make(),"app-log","SUCCEEDED",1),/TRANSITION_DENIED/);
 let s=go(make(),"app-log","PLANNED",1);
 s=go(s,"app-log","VALIDATING",2);
 s=go(s,"app-log","AWAITING_APPROVAL",3);
 assert.throws(()=>transitionBlueprintItem(s,{itemId:"app-log",to:"APPROVED",at,sourceRef:"adapter",evidenceRefs:[]}),/AUTHORITY_EVIDENCE_REQUIRED/);
});
test("altered event hash or head is detected",()=>{
 const s=go(make(),"control-tower","DISCOVERING",1);
 assert.equal(verifyBlueprintInventory({...s,headHash:"wrong"}),false);
 assert.equal(verifyBlueprintInventory({...s,events:[{...s.events[0]!,sourceRef:"other"}]}),false);
});
test("duplicate resources and invalid evidence references are refused",()=>{
 const item=make().items[0]!;
 assert.throws(()=>createBlueprintInventory("test",[item,item]),/ITEM_ID_INVALID/);
 assert.throws(()=>transitionBlueprintItem(make(),{itemId:"control-tower",to:"DISCOVERING",at,sourceRef:"adapter",evidenceRefs:["invalid-ref"]}),/EVIDENCE_INVALID/);
});
