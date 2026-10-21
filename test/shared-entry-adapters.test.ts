import assert from "node:assert/strict";
import test from "node:test";
import { UnifiedOperations, type VerifiedCaller } from "../src/operations/unified.js";
import { LocalOperationsAdapter } from "../src/operations/local-adapter.js";
import { StudioMcpAdapter } from "../src/integrations/ai-studio/operations-mcp.js";
import type { OperationSpec } from "../src/operations/types.js";

const now=1_800_000_000_000;
const catalog:OperationSpec[]=[
  {id:"health",title:"Health",summary:"Read status",family:"evidence",cli:"./alz health",
    safety:"READ_ONLY",inputs:[],evidenceBasis:"FIXTURE",job:{script:"cli/health.js",args:()=>[]}},
  {id:"deploy",title:"Deploy",summary:"Not available via shared read-only API",
    family:"governance",cli:"./alz deploy",safety:"HANDOFF",inputs:[],evidenceBasis:"FIXTURE",
    handoff:{reason:"Operator approval required",command:"./alz apply approve"}},
];
const identity=(overrides:Partial<VerifiedCaller["identity"]>={}):VerifiedCaller=>({
  verifiedBy:"TRUSTED_GATEWAY",
  identity:{subject:"operator-1",audience:"private-alz",scopes:["ALZ_DISCOVERY_READ"],
    expiresAt:now+60_000,traceId:"shared-trace-1",...overrides}
});
const create=()=>{
  const executions:string[]=[];
  const ops=new UnifiedOperations({root:process.cwd(),catalog,audience:"private-alz",
    now:()=>now,runner:async job=>{executions.push(job.mode);return "HEALTH OK";}});
  return {ops,executions};
};
test("Studio and local adapters list and invoke identical allowlisted operations",async()=>{
  const {ops,executions}=create();
  const local=new LocalOperationsAdapter(ops,{resolveLocalCaller:async()=>identity()});
  const studio=new StudioMcpAdapter(ops);
  const list=await local.list();
  assert.equal(list.ok,true);
  const studioList=await studio.dispatch(identity(),{jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name:"alz.operations.list",arguments:{}}});
  assert.equal(studioList.error,undefined);
  assert.deepEqual(JSON.parse((studioList.result as {content:{text:string}[]}).content[0]!.text),
    list.ok?list.operations:[]);
  const result=await local.invoke("health");
  const remote=await studio.dispatch(identity(),{jsonrpc:"2.0",id:2,method:"tools/call",
    params:{name:"alz.operations.invoke",arguments:{operation:"health"}}});
  assert.equal(result.ok,true);
  assert.deepEqual(JSON.parse((remote.result as {content:{text:string}[]}).content[0]!.text),result);
  assert.deepEqual(executions,["health","health"]);
});
test("both paths refuse mutation and unscoped callers",async()=>{
  const {ops,executions}=create();
  const local=new LocalOperationsAdapter(ops,{resolveLocalCaller:async()=>identity()});
  const studio=new StudioMcpAdapter(ops);
  assert.equal((await local.invoke("deploy")).ok,false);
  const remote=await studio.dispatch(identity(),{jsonrpc:"2.0",id:2,method:"tools/call",
    params:{name:"alz.operations.invoke",arguments:{operation:"deploy"}}});
  assert.equal(JSON.parse((remote.result as {content:{text:string}[]}).content[0]!.text).ok,false);
  const denied=new LocalOperationsAdapter(ops,{resolveLocalCaller:async()=>identity({scopes:[]})});
  assert.equal((await denied.invoke("health")).ok,false);
  assert.equal((await studio.dispatch(identity({scopes:[]}),{jsonrpc:"2.0",id:1,method:"tools/list"})).error?.message,"FORBIDDEN");
  assert.deepEqual(executions,[]);
});
test("local identity failure is fail closed and cannot elevate an unverified caller",async()=>{
  const {ops,executions}=create();
  for(const resolveLocalCaller of [
    async()=>null,
    async()=>{throw new Error("secret=must-not-escape");},
    async()=>({...identity(),verifiedBy:"UNTRUSTED" as never}),
  ]){
    const local=new LocalOperationsAdapter(ops,{resolveLocalCaller});
    assert.deepEqual(await local.list(),{ok:false,error:"LOCAL_AUTH_REQUIRED"});
    assert.equal((await local.invoke("health")).error,"LOCAL_AUTH_REQUIRED");
  }
  const expired=new LocalOperationsAdapter(ops,{resolveLocalCaller:async()=>identity({expiresAt:now-1})});
  assert.equal((await expired.invoke("health")).ok,false);
  assert.deepEqual(executions,[]);
});
