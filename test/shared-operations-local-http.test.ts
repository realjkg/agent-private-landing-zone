import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createDualEntryOperations } from "../src/integrations/ai-studio/dual-entry-operations.js";
import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import type { VerifiedCaller } from "../src/operations/unified.js";
import type { OperationSpec } from "../src/operations/types.js";

const subject: VerifiedCaller = {
  verifiedBy: "TRUSTED_GATEWAY",
  identity: { subject: "operator", audience: "alz-private", scopes: ["ALZ_DISCOVERY_READ"],
    expiresAt: Date.now() + 60_000, traceId: "shared-local-test" },
};
const catalog: OperationSpec[] = [
  { id: "health", title: "Health", summary: "Read status", family: "evidence",
    cli: "./alz health", safety: "READ_ONLY", inputs: [], evidenceBasis: "FIXTURE",
    job: {script: "cli/health.js", args: () => []} },
  { id: "unsafe", title: "Unsafe", summary: "Mutation denied", family: "governance",
    cli: "./alz unsafe", safety: "WRITES_LOCAL", inputs: [], evidenceBasis: "FIXTURE",
    job: {script: "cli/unsafe.js", args: () => []} },
];
test("reconciled local HTTP routes share Studio service, require CSRF and deny mutation", async () => {
  const calls: string[] = [];
  const shared = createDualEntryOperations({
    root: process.cwd(), audience: "alz-private", catalog,
    runner: async job => { calls.push(job.mode); return "HEALTH OK"; },
  }, {verifyLocalSession: async () => subject, verifyStudioBearer: async () => subject});
  const {server} = createLocalOperatorServer({
    root: process.cwd(), catalog, localOperations: shared.local,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port;
    const page = await (await fetch(url)).text();
    const csrf = page.match(/name="token" value="([0-9a-f]{48})"/)?.[1];
    assert.ok(csrf);
    assert.equal((await fetch(url + "/api/operations")).status, 403);
    const headers = {"x-alz-csrf": csrf};
    const listing = await fetch(url + "/api/operations", {headers});
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json() as {operations:{id:string}[]}).operations.map(x=>x.id), ["health"]);
    const invoke = (operation: string) => fetch(url + "/api/operations/invoke", {
      method: "POST", headers: {...headers, "content-type": "application/json"},
      body: JSON.stringify({operation}),
    });
    assert.equal((await invoke("health")).status, 200);
    assert.equal((await invoke("unsafe")).status, 403);
    assert.deepEqual(calls, ["health"]);
    assert.equal((await fetch(url + "/api/operations/invoke",{
      method:"POST",headers:{...headers,"content-type":"text/plain"},body:"{}",
    })).status,415);
    assert.equal((await fetch(url + "/api/operations",{
      headers: {...headers, origin:"https://untrusted.example"},
    })).status,403);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test("local HTTP routes fail closed without an authenticated adapter", async () => {
  const {server} = createLocalOperatorServer({root:process.cwd(),catalog});
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  try {
    const addr=server.address();
    assert.ok(addr && typeof addr !== "string");
    const url="http://127.0.0.1:"+addr.port;
    assert.equal((await fetch(url+"/api/operations")).status,503);
    assert.equal((await fetch(url+"/api/operations/invoke",{method:"POST"})).status,503);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
