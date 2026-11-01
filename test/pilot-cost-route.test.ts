import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PILOT_TOKEN_HEADER } from "../src/cli/ui-channel.js";
import { writeCostSnapshot } from "../src/cost/local.js";
import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { awsContractJson, SOURCE_COMMIT, NOW, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { costStatusOf } from "./helpers/cost-fixtures.js";

// GET /pilot/cost (plan item 5): the "Cost and visibility" panel's data. Read-only: two local files and the contract, never a cloud
// call. SYNTHETIC: fixture files in a temporary folder; nothing reads AWS.

const scratch = mkdtempSync(join(tmpdir(), "alz-cost-route-"));
const servers: Server[] = [];
test.after(() => { for (const server of servers) server.close(); removeTree(scratch); });
const TOKEN = "c".repeat(64);
let counter = 0;
const fresh = (label: string): string => { const dir = join(scratch, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
const CONFIG = {
  owner: "platform-team", notifications: { emails: ["finops@example.com"] }, tags: { "cost-center": "cc-1234", environment: "dev" },
  budget: { name: "alz-dev-monthly", amount: "50" }, review: { reviewBy: "2027-01-31" }, limits: { allowedRegions: ["us-east-2"], quantities: { aws_instance: 2 } },
};

async function serve(contract: unknown | null): Promise<{ port: number; configPath: string; statusPath: string }> {
  const dir = fresh("world");
  const contractPath = join(dir, "act-pilot-contract.json");
  if (contract !== null) writeReviewedContract(contractPath, contract);
  const configPath = join(dir, "cost.json");
  const statusPath = join(dir, "status.json");
  const { server } = createLocalOperatorServer({
    root: dir,
    pilot: { token: TOKEN, approvalsDir: fresh("approvals"), cost: { configPath, statusPath },
      cli: { sourceCommit: SOURCE_COMMIT, env: {}, now: () => NOW, operatorId: "operator.fixture", contractPath } },
  });
  servers.push(server);
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, configPath, statusPath };
}

function call(port: number, method: string, path: string, token: string | null = TOKEN): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = { Host: "127.0.0.1:" + port, Origin: "http://127.0.0.1:" + port };
  if (token !== null) headers[PILOT_TOKEN_HEADER] = token;
  if (method === "POST") { headers["Content-Type"] = "application/json"; headers["Content-Length"] = "2"; }
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        done({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.on("error", fail);
    if (method === "POST") req.write("{}");
    req.end();
  });
}
const fingerprint = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex") + ":" + statSync(path).mtimeMs;

test("GET /pilot/cost needs the session token and, with nothing saved, says NONE: no data yet, never a passing value", async () => {
  const { port } = await serve(null);
  const refused = await call(port, "GET", "/pilot/cost", null);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "PILOT_TOKEN_REQUIRED");
  assert.equal((await call(port, "GET", "/pilot/cost", "wrong")).status, 401);
  const reply = await call(port, "GET", "/pilot/cost");
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.body, {
    label: "COST_VISIBILITY", readOnly: true, advisory: true, actEnabled: false, command: "./alz cost status --account <account>",
    status: { state: "NONE" }, config: { state: "NONE" }, contractLimits: { state: "DISABLED" },
  });
});

test("GET /pilot/cost returns the typed status (full addresses, local operator only), the configuration summary and the contract's limits, and changes nothing", async () => {
  const { port, configPath, statusPath } = await serve(awsContractJson(join(scratch, "KILL")));
  writeFileSync(configPath, JSON.stringify(CONFIG));
  const status = await costStatusOf("observed");
  writeCostSnapshot(status, statusPath);
  const before = [fingerprint(configPath), fingerprint(statusPath)];
  const reply = await call(port, "GET", "/pilot/cost");
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.body.status, { state: "OK", cost: status });
  assert.match(reply.text, /finops@example\.com/);
  const summary = reply.body.config.summary;
  assert.equal(reply.body.config.state, "OK");
  assert.deepEqual([summary.budget.amount, summary.budget.control, summary.budgetAction.enabled], ["50.00", "ALERT_ONLY", false]);
  assert.deepEqual(summary.limits.allowedRegions, ["us-east-2"]);
  assert.equal(reply.body.contractLimits.state, "OK");
  assert.deepEqual(reply.body.contractLimits.environments.map((e: { environment: string }) => e.environment), ["DEV", "QA", "PROD"]);
  assert.deepEqual([fingerprint(configPath), fingerprint(statusPath)], before, "a GET writes nothing");
  // Read-only: there is no write door at this path.
  const post = await call(port, "POST", "/pilot/cost");
  assert.notEqual(post.status, 200);
  assert.deepEqual([fingerprint(configPath), fingerprint(statusPath)], before);
});

test("negative: a malformed or forged status, or an invalid configuration, is reported as such with 200, never a 500 or a stack trace", async () => {
  const { port, configPath, statusPath } = await serve(null);
  writeFileSync(configPath, JSON.stringify({ owner: "x" }));
  writeFileSync(statusPath, JSON.stringify({ ...(await costStatusOf("observed")), actEnabled: true }));
  let reply = await call(port, "GET", "/pilot/cost");
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.body.status, { state: "UNREADABLE" });
  assert.equal(reply.body.config.state, "INVALID");
  assert.ok(reply.body.config.issues.every((i: object) => Object.keys(i).sort().join() === "code,path"), "paths and codes only");
  assert.doesNotMatch(reply.text, /\bat \/|Error:/);
  // A directory where the file should be: still an answer, not an error page.
  mkdirSync(statusPath + ".d");
  writeFileSync(statusPath, "{");
  reply = await call(port, "GET", "/pilot/cost");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.status, { state: "UNREADABLE" });
});
