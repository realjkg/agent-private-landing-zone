import test from "node:test";
import assert from "node:assert/strict";
import {BASE_BUILD_ENGINES,routeStudioSubagent,type HarnessRoute,type AgentTask} from "../src/integrations/ai-studio/subagent-routing.js";
const route:HarnessRoute={interface:"STUDIO_PRESIDIO_AI",transport:"MCP_STREAMABLE_HTTP",target:"PRIVATE_ALZ",remoteAuthVerified:true,tokenAudienceVerified:true,requestIdentity:"studio-user",correlationId:"req-123"};
const task:AgentTask={role:"IAC",capability:"IAC_PREVIEW",engine:"OPENTOFU",blueprintId:"blueprint-01",delegatedBy:"orchestrator",traceId:"trace-01"};
test("all eight existing IaC adapters are base-compatible; no new runtime engine is needed",()=>{
 assert.equal(BASE_BUILD_ENGINES.length,8);
 for(const engine of ["OPENTOFU","BICEP","ANSIBLE","CROSSPLANE"] as const){
  assert.equal(routeStudioSubagent(route,{...task,engine}).allowed,true);
 }
});
test("hosted AI Studio sub-agent tasks require verified authentication and intended audience",()=>{
 assert.deepEqual(routeStudioSubagent({...route,remoteAuthVerified:false},task),{allowed:false,reason:"HARNESS_AUTH_NOT_VERIFIED"});
 assert.deepEqual(routeStudioSubagent({...route,tokenAudienceVerified:false},task),{allowed:false,reason:"HARNESS_AUTH_NOT_VERIFIED"});
});
test("sub-agents cannot elevate policy roles or bypass the private broker",()=>{
 assert.deepEqual(routeStudioSubagent(route,{...task,role:"INVENTORY"}),{allowed:false,reason:"SUBAGENT_CAPABILITY_DENIED"});
 assert.deepEqual(routeStudioSubagent(route,{...task,engine:undefined}),{allowed:false,reason:"SUBAGENT_ENGINE_REQUIRED"});
 const result=routeStudioSubagent(route,task);
 assert.deepEqual(result,{allowed:true,execution:"READ_OR_PREVIEW_ONLY",route:"PRIVATE_POLICY_BROKER",role:"IAC"});
});
test("unsupported harness paths and invalid correlation values fail closed",()=>{
 assert.equal(routeStudioSubagent({...route,target:"PUBLIC_ALZ" as HarnessRoute["target"]},task).allowed,false);
 assert.equal(routeStudioSubagent({...route,correlationId:"invalid token"},task).allowed,false);
});
