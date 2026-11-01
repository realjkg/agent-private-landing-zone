import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCostCommand, type CostCliDeps } from "../src/cli/cost.js";
import { costConfigSummary, costPaths, costRequestOf, isCostStatus, readCostSnapshot, readLocalCostConfig, writeCostSnapshot } from "../src/cost/local.js";
import type { CostReadRequest } from "../src/cost/status.js";
import { resolveCostConfig, validateCostConfig } from "../src/design/cost.js";
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
    assert.deepEqual(readCostSnapshot(file("forged.json", JSON.stringify(envelope(forged)))), { state: "UNREADABLE" });
  }
  assert.throws(() => writeCostSnapshot({ ...status, actEnabled: true } as never, file("refused.json")), /COST_STATUS_INVALID/);
});

const envelope = (status: unknown, schemaVersion: unknown = 1) => ({ schemaVersion, kind: "ALZ_COST_STATUS_SNAPSHOT", status });
/** The review's shallow file (6539995646, B2): every top-level field, none of the nested ones. */
const shallow = (overall: string) => ({ kind: "ALZ_COST_STATUS", source: "AWS_API_READ_ONLY", accountId: COST_ACCOUNT, capturedAt: COST_NOW.toISOString(), overall,
  advisory: true, actEnabled: false, budget: { state: "PRESENT", hardSpendCap: false }, tags: { state: "x" }, costAllocationTags: { state: "x" }, export: { state: "x" }, freshness: { state: "x" } });

test("B2: the saved status is versioned and checked in depth; a shallow, unversioned or other-version file is UNREADABLE", async () => {
  for (const variant of ["observed", "waiting", "stale", "attention", "missing", "incomplete"] as const) {
    const status = await costStatusOf(variant);
    assert.equal(isCostStatus(status), true, variant + " as the status model writes it");
    assert.deepEqual(readCostSnapshot(file(variant + ".json", JSON.stringify(envelope(status)))), { state: "OK", status });
  }
  const status = await costStatusOf("observed");
  for (const [label, content] of [
    ["unversioned", status], ["version 2", envelope(status, 2)], ["no version", { kind: "ALZ_COST_STATUS_SNAPSHOT", status }],
    ["shallow complete", envelope(shallow("OBSERVED_COMPLETE"))], ["shallow attention", envelope(shallow("ATTENTION"))],
    ["label without value", envelope({ ...status, budget: { ...status.budget, actualSpend: { label: "OBSERVED" } } })],
    ["unknown without reason", envelope({ ...status, export: { ...status.export, configValid: { label: "UNKNOWN" } } })],
    ["notifications not a list", envelope({ ...status, budget: { ...status.budget, notifications: { label: "OBSERVED", value: {} } } })],
  ] as const) {
    assert.deepEqual(readCostSnapshot(file("bad.json", JSON.stringify(content))), { state: "UNREADABLE" }, label);
  }
});

test("B1: the saved status is a private file: 0600 on every rewrite, the folder tightened to 0700, never written through a link", async () => {
  const status = await costStatusOf("observed");
  const dir = join(root, ++counter + "-private");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const path = join(dir, "status.json");
  // A leftover 0644 file at the target: the rewrite is 0600, and the folder becomes owner-only.
  writeFileSync(path, "old", { mode: 0o644 });
  chmodSync(path, 0o644);
  writeCostSnapshot(status, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // A link planted at the old predictable temporary name is never followed: the victim is untouched and no link replaces the target.
  const victim = join(root, ++counter + "-victim.txt");
  writeFileSync(victim, "victim");
  symlinkSync(victim, path + ".tmp-" + process.pid);
  writeCostSnapshot(status, path);
  assert.equal(readFileSync(victim, "utf8"), "victim");
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // A link at the target name is refused, and its target is untouched.
  const linked = join(dir, "linked.json");
  symlinkSync(victim, linked);
  assert.throws(() => writeCostSnapshot(status, linked), /not a regular file/);
  assert.equal(readFileSync(victim, "utf8"), "victim");
  // A link where the folder should be is refused before anything is written.
  const elsewhere = join(root, ++counter + "-elsewhere");
  mkdirSync(elsewhere);
  const linkedDir = join(root, ++counter + "-linked-dir");
  symlinkSync(elsewhere, linkedDir);
  assert.throws(() => writeCostSnapshot(status, join(linkedDir, "status.json")), /COST_STATUS_FOLDER_INVALID/);
  assert.equal(existsSync(join(elsewhere, "status.json")), false);
});

test("N5: the committed example configuration is valid under the build's own rules, and is not ignored", () => {
  const example = JSON.parse(readFileSync(new URL("../config/cost.example.json", import.meta.url), "utf8"));
  const result = validateCostConfig(example);
  assert.equal(result.ok, true, JSON.stringify(!result.ok && result.issues));
  assert.doesNotMatch(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /cost\.example/);
  const config = resolveCostConfig(example);
  assert.equal(config.budgetAction.enabled, false, "the example is notify-only");
  assert.equal(config.analytics, "OFF");
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
    [["status", "--account", COST_ACCOUNT, "--export-arn", "arn:aws:bcm-data-exports:us-east-1:999999999999:export/alz-cur2-1"], {}, /COST_STATUS_EXPORT_ACCOUNT_MISMATCH/],
    [["status", "--account", COST_ACCOUNT, "--export-arn", "not-an-arn"], {}, /COST_STATUS_EXPORT_ACCOUNT_MISMATCH/],
    [["status", "--account", COST_ACCOUNT, "--account", COST_ACCOUNT], {}, /Usage/],
  ];
  for (const [args, over, expected] of cases) {
    const run = cli(over);
    assert.equal(await runCostCommand(args, run.deps), 2, args.join(" "));
    assert.match(run.err.join("\n"), expected, args.join(" "));
    assert.doesNotMatch(run.err.join("\n"), /secret|\bat \//, "no stack or raw error text");
    assert.deepEqual(readCostSnapshot(run.deps.statusPath), { state: "NONE" }, "nothing saved");
    assert.equal(run.calls.length, 0, "refused before any read: " + args.join(" "));
  }
  // A read that throws on every call is still a completed read: every value UNKNOWN, INCOMPLETE, never a pass.
  const denied = cli({ read: async () => { throw new Error("An error occurred (AccessDeniedException): not authorized"); } });
  assert.equal(await runCostCommand(["status", "--account", COST_ACCOUNT], denied.deps), 0);
  assert.match(denied.out[0]!, /Cost status: (INCOMPLETE|ATTENTION)/);
  assert.doesNotMatch(denied.out.join("\n"), /OBSERVED_COMPLETE/);
});
