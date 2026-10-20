import assert from "node:assert/strict";
import test from "node:test";
import { UnifiedOperations, type VerifiedCaller } from "../src/operations/unified.js";
import { StudioMcpAdapter } from "../src/integrations/ai-studio/operations-mcp.js";
import type { OperationSpec } from "../src/operations/types.js";

const catalog:OperationSpec[]=[
  {id:"health",title:"Health",summary:"Read sanitized health.",family:"evidence",cli:"./alz health",safety:"READ_ONLY",
   inputs:[],evidenceBasis:"FIXTURE",job:{script:"cli/health.js",args:()=>[]}},
  {id:"debug",title:"Debug",summary:"Writes local evidence.",family:"evidence",cli:"./alz debug",safety:"WRITES_LOCAL",
   inputs:[],evidenceBasis:"FIXTURE",job:{script:"cli/debug.js",args:()=>[]}},
  {id:"apply",title:"Apply",summary:"Operator only.",family:"evidence",cli:"./alz apply",safety:"HANDOFF",
   inputs:[],evidenceBasis:"REQUIRES_APPROVAL",handoff:{reason:"Human signature required",command:"./alz apply"}}
];
const good:VerifiedCaller={verifiedBy:"TRUSTED_GATEWAY",identity:{
  subject:"studio-agent",audience:"private-alz",scopes:["ALZ_DISCOVERY_READ"],
  expiresAt:Date.now()+60_000,traceId:"trace-123"
}};
function setup(){
  const jobs:string[]=[];
  const operations=new UnifiedOperations({root:process.cwd(),audience:"private-alz",catalog,
    runner:async job=>{jobs.push(job.mode);return "HEALTH: OK";}});
  return {jobs,operations,mcp:new StudioMcpAdapter(operations)};
}
const rpc=(method:string,params:unknown={})=>({jsonrpc:"2.0",id:5,method,params});
test("Studio MCP initializes and lists read-only tool schemas with verified identity",async()=>{
 const {mcp}=setup();
 const initialized=await mcp.dispatch(good,rpc("initialize"));
 assert.equal((initialized.result as {serverInfo:{name:string}}).serverInfo.name,"sovereign-alz-readonly");
 const tools=await mcp.dispatch(good,rpc("tools/list"));
 assert.deepEqual((tools.result as {tools:{name:string}[]}).tools.map(t=>t.name),
 ["alz.operations.list","alz.operations.invoke"]);
});
test("verified MCP caller invokes shared operation without exposing commands",async()=>{
 const {mcp,jobs}=setup();
 const result=await mcp.dispatch(good,rpc("tools/call",{name:"alz.operations.invoke",arguments:{operation:"health",inputs:{}}}));
 assert.deepEqual(jobs,["health"]);
 assert.match(JSON.stringify(result),/HEALTH: OK/);
 assert.doesNotMatch(JSON.stringify(result),/cli\/health\.js/);
});
test("mutating operations are denied before reaching a runner",async()=>{
 const {mcp,jobs}=setup();
 for (const op of ["debug","apply","unknown"]) {
   const response=await mcp.dispatch(good,rpc("tools/call",{name:"alz.operations.invoke",arguments:{operation:op}}));
   assert.match(JSON.stringify(response),/OPERATIONS_READ_ONLY_DENIED/);
 }
 assert.deepEqual(jobs,[]);
});
test("missing, expired, wrong-audience and unscoped identities cannot invoke",async()=>{
 const {mcp,jobs}=setup();
 const invalid=[undefined,
  {...good,identity:{...good.identity,expiresAt:Date.now()-1}},
  {...good,identity:{...good.identity,audience:"some-other-service"}},
  {...good,identity:{...good.identity,scopes:[]}}];
 for(const caller of invalid) {
   const response=await mcp.dispatch(caller,rpc("tools/call",{name:"alz.operations.invoke",arguments:{operation:"health"}}));
   assert.match(JSON.stringify(response),/UNAUTHENTICATED|OPERATIONS_UNAUTHORIZED/);
 }
 assert.deepEqual(jobs,[]);
});
test("MCP refuses unknown methods, tool names and malformed calls",async()=>{
 const {mcp,jobs}=setup();
 assert.match(JSON.stringify(await mcp.dispatch(good,rpc("shell/exec"))),/METHOD_NOT_FOUND/);
 assert.match(JSON.stringify(await mcp.dispatch(good,rpc("tools/call",{name:"shell.exec",arguments:{}}))),/TOOL_NOT_ALLOWED/);
 assert.match(JSON.stringify(await mcp.dispatch(good,rpc("tools/call",{name:"alz.operations.invoke",arguments:{operation:"health",script:"evil"}}))),/INVALID_PARAMS/);
 assert.deepEqual(jobs,[]);
});
