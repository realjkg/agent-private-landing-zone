import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCostCommand, type CostCliDeps } from "../src/cli/cost.js";
import { costConfigSummary, costPaths, costRequestOf, isCostStatus, readCostSnapshot, readLocalCostConfig, writeCostSnapshot } from "../src/cost/local.js";
import type { CostReadRequest } from "../src/cost/status.js";
import { resolveCostConfig } from "../src/design/cost.js";
import { COST_ACCOUNT, COST_NOW, costAnswers, costReader, costStatusOf } from "./helpers/cost-fixtures.js";

// The local cost files (src/cost/local.ts) and `./alz cost status` (src/cli/cost.ts). SYNTHETIC: the AWS reader is a fixture,
// nothing reads or changes AWS.

const root = mkdtempSync(join(tmpdir(), "alz-cost-local-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const file = (name: string, content?: string): string => {
  const path = join(root, ++counter + "-" + name);
  if (content !== undefined) writeFileSync(path, content);
  return path;
};
const CONFIG = {
  owner: "platform-team", notifications: { emails: ["finops@example.com"] },
  tags: { "cost-center": "cc-1234", environment: "dev" }, budget: { name: "alz-dev-monthly", amount: "50" }, review: { reviewBy: "2027-01-31" },
};
const ACTION = {
  enabled: true, type: "APPLY_IAM_POLICY", thresholdPercent: 100, executionRoleArn: "arn:aws:iam::123456789012:role/alz-budget-action",
  policyArn: "arn:aws:iam::123456789012:policy/alz-deny-new-compute", roles: ["workload-deployer"],
};

test("the configuration file: absent is NONE, unreadable or invalid is INVALID with paths only, valid is OK with the build's defaults", () => {
  assert.deepEqual(readLocalCostConfig(file("absent.json")), { state: "NONE" });
  assert.deepEqual(readLocalCostConfig(file("bad.json", "{not json")), { state: "INVALID", issues: [{ path: "$", code: "NOT_JSON" }] });
  const invalid = readLocalCostConfig(file("invalid.json", JSON.stringify({ ...CONFIG, budget: { amount: "lots" } })));
  assert.equal(invalid.state, "INVALID");
  assert.ok(invalid.state === "INVALID" && invalid.issues.every((i) => Object.keys(i).sort().join() === "code,path"));
  const ok = readLocalCostConfig(file("ok.json", JSON.stringify(CONFIG)));
  assert.equal(ok.state, "OK");
  assert.deepEqual(costPaths("/r"), { config: "/r/config/cost.json", status: "/r/.runs/cost/status.json" });
});

test("the configuration summary: alerts only by default, a budget action only when configured and with its effect", () => {
  const plain = costConfigSummary(resolveCostConfig(CONFIG));
  assert.equal(plain.label, "CONFIGURED");
  assert.equal(plain.budget.control, "ALERT_ONLY");
  assert.deepEqual(plain.budgetAction, { enabled: false });
  assert.deepEqual(plain.notifications.emails, ["finops@example.com"]);
  assert.equal(plain.costAllocationTagActivation, "NOT_REQUESTED");
  assert.deepEqual(plain.limits, { allowedRegions: [], resourceFamilies: [], sizes: {}, quantities: {} });
  const acting = costConfigSummary(resolveCostConfig({ ...CONFIG, budgetAction: ACTION }));
  assert.equal(acting.budget.control, "ALERT_AND_BUDGET_ACTION");
  assert.ok(acting.budgetAction.enabled && /does not stop running resources or cap spend/.test(acting.budgetAction.effect));
});

test("the read request comes from the one configuration: budget name, required tags, export and analytics", () => {
  const request = costRequestOf(resolveCostConfig(CONFIG), { accountId: COST_ACCOUNT, unitId: "unit-1", region: "us-east-2" });
  assert.deepEqual(request, { accountId: COST_ACCOUNT, budgetName: "alz-dev-monthly", requiredTagKeys: ["cost-center", "environment", "owner"],
    unitId: "unit-1", region: "us-east-2", exportName: "alz-cur2", analytics: "off" });
});

test("the saved status: written owner-only, read back typed; a malformed or foreign file is UNREADABLE, never a status", async () => {
  const status = await costStatusOf("observed");
  const path = join(root, "runs", "cost", "status.json");
  writeCostSnapshot(status, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readCostSnapshot(path), { state: "OK", status });
  assert.deepEqual(readCostSnapshot(file("none.json")), { state: "NONE" });
  assert.deepEqual(readCostSnapshot(file("garbage.json", "[]")), { state: "UNREADABLE" });
  for (const forged of [{ ...status, actEnabled: true }, { ...status, budget: { ...status.budget, hardSpendCap: true } }, { ...status, overall: "GREEN" }, { ...status, accountId: "x" }]) {
    assert.equal(isCostStatus(forged), false);
    assert.deepEqual(readCostSnapshot(file("forged.json", JSON.stringify(forged))), { state: "UNREADABLE" });
  }
  assert.throws(() => writeCostSnapshot({ ...status, actEnabled: true } as never, file("refused.json")), /COST_STATUS_INVALID/);
});

function cli(over: Partial<CostCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: CostReadRequest[] = [];
  const read = costReader(costAnswers());
  const deps: CostCliDeps = {
    configPath: file("cost.json", JSON.stringify(CONFIG)), statusPath: join(root, ++counter + "-status", "status.json"), now: () => COST_NOW,
    read: async (request) => { calls.push(request); return read(request); }, out: (l) => out.push(l), err: (l) => err.push(l), ...over,
  };
  return { deps, out, err, calls };
}

test("./alz cost status: read-only, concise, recipients redacted, and the typed status saved for the console", async () => {
  const run = cli();
  const code = await runCostCommand(["status", "--account", COST_ACCOUNT, "--unit", "unit-0001", "--region", "us-east-2"], run.deps);
  assert.equal(code, 0, run.err.join("\n"));
  const text = run.out.join("\n");
  assert.match(text, /^Cost status: OBSERVED_COMPLETE \(read-only, advisory; a budget alerts and never caps spend\)/);
  assert.match(text, /f\*\*\*@example\.com/);
  assert.doesNotMatch(text, /finops@example\.com/, "the terminal shows the masked address only");
  assert.match(text, /ACT remains disabled/);
  assert.ok(run.out.length <= 10);
  // Every call is one of the broker's read tools; nothing writes.
  assert.ok(run.calls.length > 0 && run.calls.every((c) => /^aws_(budgets_describe|tagging_get|ce_list|bcm_(get|list))_/.test(c.tool)), run.calls.map((c) => c.tool).join());
  // The local copy keeps the typed status (full address, for this computer's operator only).
  const saved = readCostSnapshot(run.deps.statusPath);
  assert.equal(saved.state, "OK");
  assert.match(readFileSync(run.deps.statusPath!, "utf8"), /finops@example\.com/);
});

test("negative: no account, no or invalid configuration, a refused value or a failed read saves nothing and exits 2", async () => {
  const cases: [string[], Partial<CostCliDeps>, RegExp][] = [
    [["status"], {}, /COST_STATUS_ACCOUNT_REQUIRED/],
    [["status", "--account", COST_ACCOUNT], { configPath: file("missing.json") }, /COST_CONFIG_MISSING/],
    [["status", "--account", COST_ACCOUNT], { configPath: file("invalid.json", JSON.stringify({ owner: "x" })) }, /COST_CONFIG_INVALID/],
    [["status", "--account", "12"], {}, /COST_STATUS_ACCOUNT_INVALID/],
    [["status", "--account", COST_ACCOUNT, "--unit", "u-1"], {}, /COST_STATUS_UNIT_NEEDS_REGION/],
    [["status", "--account", COST_ACCOUNT, "--bogus", "1"], {}, /Usage/],
    [["status", "--account", COST_ACCOUNT, "--account", COST_ACCOUNT], {}, /Usage/],
  ];
  for (const [args, over, expected] of cases) {
    const run = cli(over);
    assert.equal(await runCostCommand(args, run.deps), 2, args.join(" "));
    assert.match(run.err.join("\n"), expected, args.join(" "));
    assert.doesNotMatch(run.err.join("\n"), /secret|\bat \//, "no stack or raw error text");
    assert.deepEqual(readCostSnapshot(run.deps.statusPath), { state: "NONE" }, "nothing saved");
  }
  // A read that throws on every call is still a completed read: every value UNKNOWN, INCOMPLETE, never a pass.
  const denied = cli({ read: async () => { throw new Error("An error occurred (AccessDeniedException): not authorized"); } });
  assert.equal(await runCostCommand(["status", "--account", COST_ACCOUNT], denied.deps), 0);
  assert.match(denied.out[0]!, /Cost status: (INCOMPLETE|ATTENTION)/);
  assert.doesNotMatch(denied.out.join("\n"), /OBSERVED_COMPLETE/);
});
