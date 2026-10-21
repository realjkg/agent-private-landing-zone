import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createDualEntryOperations } from "../src/integrations/ai-studio/dual-entry-operations.js";
import type { VerifiedCaller } from "../src/operations/unified.js";
import type { OperationSpec } from "../src/operations/types.js";

const now = 1_800_000_000_000;
const verified: VerifiedCaller = {
  verifiedBy: "TRUSTED_GATEWAY",
  identity: {
    subject: "operator-1", audience: "alz-private", scopes: ["ALZ_DISCOVERY_READ"],
    expiresAt: now + 60_000, traceId: "trace-001",
  },
};
const catalog: OperationSpec[] = [
  {id:"health",title:"Health",summary:"Read local health.",family:"evidence",
   cli:"./alz health",safety:"READ_ONLY",inputs:[],evidenceBasis:"FIXTURE",
   job:{script:"cli/health.js",args:()=>[]}},
  {id:"unsafe",title:"Unsafe",summary:"Make local change.",family:"governance",
   cli:"./alz unsafe",safety:"WRITES_LOCAL",inputs:[],evidenceBasis:"FIXTURE",
   job:{script:"cli/unsafe.js",args:()=>[]}},
];
function create(options: {local?: VerifiedCaller | null; studio?: VerifiedCaller | null} = {}) {
  const calls:string[] = [];
  const app=createDualEntryOperations({
    audience:"alz-private",root:process.cwd(),catalog,now:()=>now,
    runner:async job=>{calls.push(job.mode);return "HEALTH OK";},
  },{
    verifyLocalSession:async()=>options.local===undefined?verified:options.local,
    verifyStudioBearer:async token=>token==="valid-studio-bearer"?
      (options.studio===undefined?verified:options.studio):null,
  });
  return {app,calls};
}
async function rpc(port:number,token:string,operation:string) {
  return fetch("http://127.0.0.1:"+port+"/mcp",{
    method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer "+token},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"alz.operations.invoke",arguments:{operation}}}),
  });
}
test("both entry points execute only the same read-only operation through one service",async()=>{
  const {app,calls}=create();
  const local=await app.local.invoke("health");
  assert.equal(local.ok,true);
  const server=app.createStudioServer();
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const address=server.address();
    assert.ok(address && typeof address!=="string");
    const response=await rpc(address.port,"valid-studio-bearer","health");
    assert.equal(response.status,200);
    const result=JSON.parse(await response.text()) as {result:{content:{text:string}[]}};
    assert.deepEqual(JSON.parse(result.result.content[0]!.text),local);
    assert.deepEqual(calls,["health","health"]);
    assert.deepEqual((await app.local.list()).ok,true);
    const localDenied=await app.local.invoke("unsafe");
    assert.deepEqual(localDenied.ok,false);
    const remoteDenied=await rpc(address.port,"valid-studio-bearer","unsafe");
    assert.match(await remoteDenied.text(),/OPERATIONS_READ_ONLY_DENIED/);
    assert.deepEqual(calls,["health","health"]);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});
test("local absence and Studio invalid bearer deny access without any operation running",async()=>{
  const {app,calls}=create({local:null});
  assert.deepEqual(await app.local.list(),{ok:false,error:"LOCAL_AUTH_REQUIRED"});
  assert.equal((await app.local.invoke("health")).ok,false);
  const server=app.createStudioServer();
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const address=server.address();
    assert.ok(address && typeof address!=="string");
    const denied=await rpc(address.port,"invalid-studio-bearer","health");
    assert.equal(denied.status,401);
    assert.deepEqual(calls,[]);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});
test("expired, wrong audience and missing scope fail equally via either adapter",async()=>{
  for (const identity of [
    {...verified,identity:{...verified.identity,expiresAt:now-1}},
    {...verified,identity:{...verified.identity,audience:"another-service"}},
    {...verified,identity:{...verified.identity,scopes:[]}},
  ]) {
    const {app,calls}=create({local:identity,studio:identity});
    assert.deepEqual(await app.local.list(),{ok:false,error:"LOCAL_UNAUTHORIZED"});
    assert.equal((await app.local.invoke("health")).ok,false);
    const studio=await app.studio.dispatch(identity,{
      jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"alz.operations.invoke",arguments:{operation:"health"}},
    });
    assert.match(JSON.stringify(studio),/OPERATIONS_UNAUTHORIZED/);
    assert.deepEqual(calls,[]);
  }
});
test("verifier errors are sanitized and do not grant local access",async()=>{
  const app=createDualEntryOperations({
    audience:"alz-private",root:process.cwd(),catalog,
    runner:async()=>{throw Error("NEVER_RUN");},
  },{
    verifyLocalSession:async()=>{throw Error("secret-sso-token");},
    verifyStudioBearer:async()=>{throw Error("secret-sso-token");},
  });
  const result=await app.local.invoke("health");
  assert.deepEqual(result,{ok:false,operation:"health",traceId:"unverified",error:"OPERATIONS_UNAUTHORIZED"});
  assert.doesNotMatch(JSON.stringify(result),/secret-sso-token/);
});
