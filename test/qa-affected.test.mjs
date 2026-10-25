import assert from "node:assert/strict";
import { test } from "node:test";
import { diffCommand, importsOf, planChanged } from "../scripts/qa-affected.mjs";

function fixture() {
  return new Map([
    ["src/agent/core.ts", "export const value = 1;"],
    ["src/agent/service.ts", 'import {value} from "./core.js"; export {value};'],
    ["test/agent-core.test.ts", 'import "../src/agent/service.js";'],
    ["src/operator-ui/app/components/Card.tsx", "export const Card = () => null;"],
    ["test/operator-ui-react.test.tsx", 'import "../src/operator-ui/app/components/Card.js";'],
    ["test/operator-ui-shell.test.tsx", "test()"],
    ["test/csp-first-party.test.tsx", "test()"],
    ["test/security-boundaries.test.ts", "test()"],
    ["test/apply-boundary.test.ts", "test()"],
    ["test/config.test.ts", "test()"],
    ["test/security-policy.test.ts", "test()"],
    ["test/deps-install.test.ts", "test()"],
    ["test/development-readiness.test.ts", "test()"],
    ["test/qa-affected.test.mjs", "test()"],
    ["scripts/qa-affected.mjs", "export const x = 1;"],
    ["test/operations-parity.test.ts", "test()"],
    ["test/operations-core.test.ts", "test()"],
    ["test/cli-ui-journey-map.test.ts", "test()"],
  ]);
}
test("resolves TypeScript sources referenced by .js specifiers", () => {
  assert.deepEqual([...importsOf('import "../src/agent/service.js";', "test/agent-core.test.ts", fixture())],
    ["src/agent/service.ts"]);
});
test("transitively selects importing tests without running the full suite", () => {
  const plan = planChanged(["src/agent/core.ts"], fixture());
  assert.deepEqual(plan.nodeTests, ["test/agent-core.test.ts"]);
  assert.deepEqual(plan.uiTests, []);
  assert.deepEqual(plan.gaps, []);
  assert.deepEqual(plan.typeNode, ["src/agent/core.ts"]);
});
test("edited UI tests run only their own suite and build UI when required", () => {
  const plan = planChanged(["test/csp-first-party.test.tsx"], fixture());
  assert.deepEqual(plan.uiTests, ["test/csp-first-party.test.tsx"]);
  assert.equal(plan.buildUi, true);
});
test("CSS edits use small explicit UI ownership set", () => {
  const plan = planChanged(["src/operator-ui/app/style.css"], fixture());
  assert.deepEqual(plan.uiTests, ["test/csp-first-party.test.tsx",
    "test/operator-ui-react.test.tsx", "test/operator-ui-shell.test.tsx"]);
});
test("untested code changes fail closed instead of silently passing", () => {
  const files = fixture();
  files.set("src/agent/orphan.ts", "export const orphan = true;");
  const plan = planChanged(["src/agent/orphan.ts"], files);
  assert.equal(plan.gaps.length, 1);
  assert.match(plan.gaps[0], /no importing test/);
});
test("documentation-only edits skip dependencies and GitHub minutes", () => {
  const plan = planChanged(["docs/user-guide.md", "README.md"], fixture());
  assert.equal(plan.testCount, 0);
  assert.equal(plan.needsDeps, false);
  assert.equal(plan.gaps.length, 0);
});
test("workflow edits only verify pins and the QA selector", () => {
  const plan = planChanged([".github/workflows/pr-validation.yml"], fixture());
  assert.equal(plan.pinCheck, true);
  assert.deepEqual(plan.jsTests, ["test/qa-affected.test.mjs"]);
  assert.equal(plan.needsDeps, false);
});
test("configuration changes perform targeted dependency checks", () => {
  const plan = planChanged(["package-lock.json"], fixture());
  assert.equal(plan.configCheck, true);
  assert.deepEqual(plan.nodeTests, ["test/deps-install.test.ts", "test/development-readiness.test.ts"]);
});
test("unknown executable paths require a mapping before passing", () => {
  const plan = planChanged(["installer/unknown-executable"], fixture());
  assert.match(plan.gaps[0], /no QA ownership rule/);
});
test("policy changes keep focused security regression tests", () => {
  const plan = planChanged(["policy/opa/example.rego"], fixture());
  assert.deepEqual(plan.nodeTests, ["test/security-policy.test.ts"]);
});

test("Python cost and policy scripts select only their importing synthetic tests", () => {
  const files = fixture();
  files.set("scripts/alz-cost-import.py", "def collect(): pass");
  files.set("scripts/alz-policy-coverage.py", "def coverage(): pass");
  files.set("scripts/alz-grafana-dashboard.py", "def dashboard(): pass");
  files.set("scripts/alz-synthetic-qualification.py",
    'files = ["alz-cost-acceptance.test.py", "alz-evidence-integration.test.py"]');
  files.set("test/alz-cost-acceptance.test.py",
    'module = "scripts/alz-cost-import.py"');
  files.set("test/alz-evidence-integration.test.py",
    'module("alz-cost-import.py"); module("alz-policy-coverage.py"); module("alz-grafana-dashboard.py")');
  const plan = planChanged([
    "scripts/alz-cost-import.py", "scripts/alz-policy-coverage.py",
    "scripts/alz-grafana-dashboard.py", "scripts/alz-synthetic-qualification.py",
    "test/alz-cost-acceptance.test.py", "test/alz-evidence-integration.test.py"
  ], files);
  assert.deepEqual(plan.pythonTests, [
    "test/alz-cost-acceptance.test.py", "test/alz-evidence-integration.test.py"
  ]);
  assert.deepEqual(plan.pythonEntrypoints, ["scripts/alz-synthetic-qualification.py"]);
  assert.deepEqual(plan.nodeTests, []);
  assert.deepEqual(plan.uiTests, []);
  assert.equal(plan.needsDeps, false);
  assert.deepEqual(plan.gaps, []);
});
test("Python source without a focused test fails closed", () => {
  const files = fixture();
  files.set("scripts/orphan.py", "print('no tests')");
  const plan = planChanged(["scripts/orphan.py"], files);
  assert.match(plan.gaps[0], /no Python test owner/);
});

test("diff compares branch head with its merge-base, not the advancing main tip", () => {
  const calls = [];
  const args = diffCommand("base-tip", "pr-head", inputs => {
    calls.push(inputs);
    return "common-ancestor" + String.fromCharCode(10);
  });
  assert.deepEqual(calls, [["merge-base", "base-tip", "pr-head"]]);
  assert.deepEqual(args, ["diff", "--name-only", "-z", "--diff-filter=ACMRD",
    "common-ancestor", "pr-head"]);
});

test("ACT-DEV-1 Terraform source receives synthetic HCL ownership without broad regression", () => {
  const files = fixture();
  files.set("qualification/aws/act-dev1-canary/main.tf", 'resource "aws_cloudwatch_log_group" "act_dev1" {}');
  files.set("test/act-dev1-automation.test.py", 'main.tf');
  const plan = planChanged(["qualification/aws/act-dev1-canary/main.tf"], files);
  assert.deepEqual(plan.pythonTests, ["test/act-dev1-automation.test.py"]);
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.needsDeps, false);
});

test("AWS bootstrap boundary changes select ACT-DEV-1 synthetic checks", () => {
  const files = fixture();
  files.set("bootstrap/aws/main.tf", "permissions_boundary");
  files.set("test/act-dev1-automation.test.py", "bootstrap/aws/main.tf");
  const plan = planChanged(["bootstrap/aws/main.tf"], files);
  assert.deepEqual(plan.pythonTests, ["test/act-dev1-automation.test.py"]);
  assert.deepEqual(plan.gaps, []);
});

test("ACT-DEV-1 tfvars and Python handoff changes map to targeted synthetic tests", () => {
  const files=fixture();
  files.set("qualification/aws/act-dev1-canary/terraform.tfvars.example.json",'{"region":"us-east-2"}');
  files.set("tests_python/test_aws_dev_terraform_handoff.py","handoff fixture");
  files.set("test/act-dev1-automation.test.py","act-dev1");
  const plan=planChanged(["qualification/aws/act-dev1-canary/terraform.tfvars.example.json",
                          "tests_python/test_aws_dev_terraform_handoff.py"],files);
  assert.deepEqual(plan.pythonTests,["test/act-dev1-automation.test.py"]);
  assert.deepEqual(plan.gaps,[]);
});
test("a new CLI entry point always runs the filesystem inventory guards", () => {
  const files = fixture();
  files.set("src/cli/new-tool.ts", "export const run = 1;");
  files.set("test/new-tool.test.ts", 'import "../src/cli/new-tool.js";');
  const plan = planChanged(["src/cli/new-tool.ts", "test/new-tool.test.ts"], files);
  assert.deepEqual(plan.gaps, []);
  for (const guard of ["test/cli-ui-journey-map.test.ts", "test/operations-core.test.ts",
    "test/operations-parity.test.ts"]) assert.ok(plan.nodeTests.includes(guard), guard);
});
test("deleting a CLI entry point or editing ./alz still runs the inventory guards", () => {
  for (const path of ["src/cli/removed.ts", "alz", "package.json"]) {
    const plan = planChanged([path], fixture());
    assert.ok(plan.nodeTests.includes("test/operations-parity.test.ts"), path);
  }
});
test("guarded generated docs run their guard instead of being skipped as documentation", () => {
  for (const path of ["docs/operator-console.md", "docs/cli-ui-journey-map.md"]) {
    const plan = planChanged([path], fixture());
    assert.ok(plan.nodeTests.includes("test/operations-core.test.ts"), path);
    assert.ok(plan.nodeTests.includes("test/cli-ui-journey-map.test.ts"), path);
    assert.deepEqual(plan.gaps, []);
  }
});

test("CI builds operator HTML before HTTP inventory guards", () => {
  const files = fixture();
  files.set("src/cli/new-tool.ts", "export const run = 1;");
  files.set("test/new-tool.test.ts", 'import "../src/cli/new-tool.js";');
  const plan = planChanged(["src/cli/new-tool.ts", "test/new-tool.test.ts"], files);
  assert.ok(plan.nodeTests.includes("test/operations-core.test.ts"));
  assert.equal(plan.buildUi, true);
  assert.deepEqual(plan.gaps, []);
});

test("a .gitignore change selects the secret-rule test and leaves no coverage gap", () => {
  const files = new Map([...fixture(), ["test/gitignore-secrets.test.ts", "test()"]]);
  const plan = planChanged([".gitignore"], files);
  assert.deepEqual(plan.nodeTests, ["test/gitignore-secrets.test.ts"]);
  assert.deepEqual(plan.gaps, []);
});

test("the journey matrix and every file it cites select the acceptance check", () => {
  const matrix = JSON.stringify({ rows: [{ steps: { prepare: { code: ["src/apply/prepare.ts"], tests: { ui: [{ file: "test/ui-channel.test.ts", title: "t" }] } },
    execute: { liveEvidence: "config/acceptance/evidence/aws-terraform-execute-dev-1.json" } } }] });
  const files = new Map([...fixture(), ["config/acceptance/journeys.json", matrix], ["test/acceptance-journeys.test.ts", "test()"],
    ["src/apply/prepare.ts", "export const x = 1;"], ["test/ui-channel.test.ts", "test()"], ["src/other.ts", "export const y = 1;"],
    ["config/acceptance/evidence/aws-terraform-execute-dev-1.json", "{}"]]);
  for (const path of ["config/acceptance/journeys.json", "src/apply/prepare.ts", "test/ui-channel.test.ts", "config/acceptance/evidence/aws-terraform-execute-dev-1.json"]) {
    assert.ok(planChanged([path], files).nodeTests.includes("test/acceptance-journeys.test.ts"), path);
  }
  assert.ok(!planChanged(["src/other.ts"], files).nodeTests.includes("test/acceptance-journeys.test.ts"), "an uncited file does not");
});

test("a change under src/apply selects the driver-import guard, which scans files instead of following imports", () => {
  const files = new Map([...fixture(), ["src/apply/new-module.ts", "export const x = 1;"], ["test/new-module.test.ts", 'import { x } from "../src/apply/new-module.js";'],
    ["test/teardown-driver-denials.test.ts", "test()"], ["test/apply-boundary.test.ts", "test()"], ["test/security-boundaries.test.ts", "test()"]]);
  assert.ok(planChanged(["src/apply/new-module.ts"], files).nodeTests.includes("test/teardown-driver-denials.test.ts"));
});

test("release scope, status and the generated release view rerun the release status check", () => {
  const files = fixture();
  files.set("config/release/status.json", "{}");
  files.set("config/release/scope.json", "{}");
  files.set("docs/release-status.md", "# Release status");
  files.set("test/release-status.test.ts", "test()");
  for (const path of ["config/release/status.json", "config/release/scope.json", "docs/release-status.md"]) {
    const plan = planChanged([path], files);
    assert.deepEqual(plan.nodeTests, ["test/release-status.test.ts"], path);
    assert.deepEqual(plan.gaps, [], path);
  }
});
