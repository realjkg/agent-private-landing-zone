import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { UnifiedOperations, type VerifiedCaller } from "../src/operations/unified.js";
import { StudioMcpAdapter } from "../src/integrations/ai-studio/operations-mcp.js";
import { createPrivateMcpServer, PRIVATE_MCP_BIND_HOST } from "../src/integrations/ai-studio/operations-mcp-http.js";
import type { OperationSpec } from "../src/operations/types.js";

const catalog:OperationSpec[]=[{
  id:"health",title:"Health",summary:"Read status.",family:"evidence",cli:"./alz health",
  safety:"READ_ONLY",inputs:[],evidenceBasis:"FIXTURE",job:{script:"cli/health.js",args:()=>[]}
}];
const caller:VerifiedCaller={verifiedBy:"TRUSTED_GATEWAY",identity:{
  subject:"studio-agent",audience:"private-alz",scopes:["ALZ_DISCOVERY_READ"],
  expiresAt:Date.now()+60000,traceId:"studio-trace-1"
}};
test("HTTP MCP loopback round trip enforces bearer verification and read-only command admission",async()=>{
  const executed:string[]=[];
  const ops=new UnifiedOperations({root:process.cwd(),catalog,audience:"private-alz",
    runner:async job=>{executed.push(job.mode);return "HEALTH OK token=should-not-escape";}});
  // Synthetic verifier for transport contract testing, NOT proof of live OIDC or Studio SSO.
  const server=createPrivateMcpServer({adapter:new StudioMcpAdapter(ops),
    verifyBearer:async token=>token==="test-token-123456" ? caller : null});
  server.listen(0,PRIVATE_MCP_BIND_HOST);
  await once(server,"listening");
  const address=server.address();
  assert.ok(address && typeof address!=="string");
  const url="http://127.0.0.1:"+address.port+"/mcp";
  const call=(token:string,method:string,params:unknown={})=>fetch(url,{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer "+token},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})
  });
  try {
    const missing=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
    assert.equal(missing.status,401);
    assert.equal((await call("invalid-token-9999","tools/list")).status,401);
    const list=await call("test-token-123456","tools/list");
    assert.equal(list.status,200);
    assert.match(await list.text(),/alz.operations.invoke/);
    const invoke=await call("test-token-123456","tools/call",{name:"alz.operations.invoke",arguments:{operation:"health"}});
    assert.equal(invoke.status,200);
    const output=await invoke.text();
    assert.match(output,/HEALTH OK/);
    assert.doesNotMatch(output,/should-not-escape/);
    assert.deepEqual(executed,["health"]);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
