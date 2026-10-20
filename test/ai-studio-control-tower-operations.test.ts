import test from "node:test";
import assert from "node:assert/strict";
import { parseControlTowerOperation, controlTowerBlueprintProgress } from "../src/integrations/ai-studio/control-tower-operations.js";
const id="12345678-abcd-4123-abcd-0123456789ab";
test("in-progress Control Tower operation maps to blueprint EXECUTING",()=>{
 const result=parseControlTowerOperation(id,{operationDetails:{operationType:"CREATE",status:"IN_PROGRESS",startTime:"2026-10-19T20:00:00Z"}});
 assert.equal(result.evidenceSource,"AWS_CONTROL_TOWER");
 assert.equal(controlTowerBlueprintProgress(result),"EXECUTING");
});
test("successful Control Tower API operation requires separate resource verification",()=>{
 const result=parseControlTowerOperation(id,{operationDetails:{operationType:"CREATE",status:"SUCCEEDED"}});
 assert.equal(controlTowerBlueprintProgress(result),"VERIFYING");
});
test("Control Tower failure is surfaced without claiming success",()=>{
 const result=parseControlTowerOperation(id,{operationDetails:{operationType:"CREATE",status:"FAILED"}});
 assert.equal(controlTowerBlueprintProgress(result),"FAILED");
});
test("invalid identifiers, partial AWS responses or undocumented statuses fail closed",()=>{
 assert.throws(()=>parseControlTowerOperation("invalid",{operationDetails:{status:"SUCCEEDED",operationType:"CREATE"}}),/ID_INVALID/);
 assert.throws(()=>parseControlTowerOperation(id,{operationDetails:{status:"COMPLETE",operationType:"CREATE"}}),/STATUS_UNKNOWN/);
 assert.throws(()=>parseControlTowerOperation(id,{status:"SUCCEEDED"}),/DETAILS_MISSING/);
});
