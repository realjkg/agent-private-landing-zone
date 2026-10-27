import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { diffCommand, FIXTURE_OWNERS, importsOf, planChanged, SOURCE_SCAN_GUARDS, TEMPLATE_OWNERS, UNIMPORTABLE_OWNERS } from "../scripts/qa-affected.mjs";

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
test("transitively selects importing tests, plus the declared guards that scan its tree, without running the full suite", () => {
  const plan = planChanged(["src/agent/core.ts"], fixture());
  // apply-boundary scans all of src/ (SOURCE_SCAN_GUARDS); nothing else in the fixture imports or scans src/agent.
  assert.deepEqual(plan.nodeTests, ["test/agent-core.test.ts", "test/apply-boundary.test.ts"]);
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
test("a dependency bump runs the tests of the agent runtime framework's consumers, not every importer of every package", () => {
  const files = fixture();
  files.set("src/session/graph.ts", 'import { StateGraph } from "@langchain/langgraph"; import "../agent/core.js";');
  files.set("test/session-graph.test.ts", 'import "../src/session/graph.js";');
  files.set("src/util/schema.ts", 'import { z } from "zod";');
  files.set("test/schema.test.ts", 'import "../src/util/schema.js";');
  for (const manifest of ["package.json", "package-lock.json"]) {
    const plan = planChanged([manifest], files);
    assert.ok(plan.nodeTests.includes("test/session-graph.test.ts"), manifest + " runs the framework consumer's test");
    assert.ok(!plan.nodeTests.includes("test/schema.test.ts"), manifest + " leaves zod to the typecheck");
    assert.deepEqual(plan.gaps, []);
  }
  assert.ok(!planChanged(["tsconfig.json"], files).nodeTests.includes("test/session-graph.test.ts"), "only the dependency manifests");
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

test("Azure bootstrap changes select its focused owner, and a missing owner is a gap", () => {
  const files = fixture();
  const changed = ["bootstrap/azure/variables.tf", "bootstrap/azure/modules/environment/outputs.tf", "bootstrap/azure/tests/environments.tftest.hcl", "bootstrap/azure/terraform.tfvars.example"];
  for (const path of changed) files.set(path, "x");
  files.set("test/bootstrap-azure.test.ts", "bootstrap/azure");
  const plan = planChanged(changed, files);
  assert.deepEqual(plan.nodeTests, ["test/bootstrap-azure.test.ts"]);
  assert.deepEqual(plan.pythonTests, []);
  assert.deepEqual(plan.gaps, []);
  files.delete("test/bootstrap-azure.test.ts");
  assert.deepEqual(planChanged(["bootstrap/azure/variables.tf"], files).gaps, ["The Azure bootstrap has no focused test owner."]);
});

test("DISCOVERY scope bootstrap files select the synthetic checks and the policy-content test", () => {
  const files = fixture();
  for (const path of ["bootstrap/aws/discovery.tf", "bootstrap/aws/discovery-policy.json", "bootstrap/aws/tests/discovery.tftest.hcl", "bootstrap/aws/terraform.tfvars.example"]) files.set(path, "x");
  files.set("test/act-dev1-automation.test.py", "bootstrap/aws/discovery.tf");
  files.set("test/discovery-scope.test.ts", "bootstrap/aws/discovery-policy.json");
  const plan = planChanged(["bootstrap/aws/discovery.tf", "bootstrap/aws/discovery-policy.json", "bootstrap/aws/tests/discovery.tftest.hcl", "bootstrap/aws/terraform.tfvars.example"], files);
  assert.deepEqual(plan.pythonTests, ["test/act-dev1-automation.test.py"]);
  assert.deepEqual(plan.nodeTests, ["test/discovery-scope.test.ts"]);
  assert.deepEqual(plan.gaps, []);
  // A bootstrap file with no owner is still a gap.
  files.set("bootstrap/aws/outputs.tf", "x");
  assert.ok(planChanged(["bootstrap/aws/outputs.tf"], files).gaps.length > 0);
});

test("GCP bootstrap changes select their one focused test, and its absence is a gap", () => {
  const files = fixture();
  files.set("bootstrap/gcp/main.tf", 'resource "google_service_account" "identity" {}');
  files.set("test/bootstrap-gcp.test.ts", "test()");
  const changed = ["bootstrap/gcp/main.tf", "bootstrap/gcp/tests/bootstrap.tftest.hcl", "bootstrap/config.gcp.template.json"];
  const plan = planChanged(changed, files);
  // The template is also read by the contract test (TEMPLATE_OWNERS), which the fixture does not ship.
  assert.deepEqual(plan.nodeTests, ["test/bootstrap-gcp.test.ts"]);
  files.set("test/apply-contract.test.ts", "test()");
  assert.deepEqual(planChanged(changed, files).nodeTests, ["test/apply-contract.test.ts", "test/bootstrap-gcp.test.ts"]);
  files.delete("test/apply-contract.test.ts");
  assert.deepEqual(plan.gaps, []);
  files.delete("test/bootstrap-gcp.test.ts");
  assert.deepEqual(planChanged(changed, files).gaps, ["The GCP bootstrap has no focused test owner."]);
  assert.match(planChanged(["bootstrap/gcpx/main.tf"], fixture()).gaps.join(), /no QA ownership rule/);
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

test("a source change selects every guard that scans its tree, which no import reaches", () => {
  const files = fixture();
  files.set("src/apply/terraform.ts", "export const argv = [];");
  files.set("test/apply-terraform.test.ts", 'import "../src/apply/terraform.js";');
  for (const guard of Object.keys(SOURCE_SCAN_GUARDS)) files.set(guard, "test()");
  // The miss behind #253: a governed -destroy builder under src/apply never ran the whole-tree destroy-literal scan.
  const apply = planChanged(["src/apply/terraform.ts"], files);
  for (const guard of ["test/teardown-adapter-terraform.test.ts", "test/apply-boundary.test.ts", "test/policy-path.test.ts",
    "test/teardown-driver-denials.test.ts"]) assert.ok(apply.nodeTests.includes(guard), guard);
  assert.ok(!apply.nodeTests.includes("test/teardown-driver-cli.test.ts"), "a guard runs only for the roots it scans");
  const agent = planChanged(["src/agent/core.ts"], files);
  assert.ok(agent.nodeTests.includes("test/teardown-driver-cli.test.ts"));
  assert.ok(agent.nodeTests.includes("test/teardown-adapter-terraform.test.ts"));
  assert.deepEqual(agent.gaps, []);
  // The console's plain-words check reads codes out of src/cli and src/apply from disk (types, prepare, the preview-evidence
  // producer, the CLI and the router): a new code in any of them runs it (a UI suite).
  for (const source of ["src/cli/apply.ts", "src/apply/prepare.ts", "src/apply/preview-evidence.ts", "src/cli/ui-channel.ts", "src/apply/types.ts"]) {
    const plan = planChanged([source], files);
    assert.ok(plan.uiTests.includes("test/pilot-wizard.test.tsx"), source + " selects the plain-words check");
  }
  assert.ok(!planChanged(["src/agent/core.ts"], files).uiTests.includes("test/pilot-wizard.test.tsx"), "a guard runs only for the roots it scans");
});

test("every test that scans a source tree from disk is declared with the roots it scans", () => {
  // A listing of src, or of a directory under it, is a scan the import closure cannot see, whatever the quoting or
  // path form: resolve("src"), join(ROOT, "src/learn"), "./src", 'src', an array of roots mapped through a lister, or a
  // constant holding the path that a lister is later called with.
  const LISTER = "(?:readdirSync|walk|sourcesUnder|sourceFiles)";
  const SRC_PATH = "[\"'`](?:\\.\\/)?src(?:\\/[^\"'`]*)?[\"'`]";
  const SCANS_SOURCE = new RegExp(LISTER + "\\([^)\\n]*" + SRC_PATH + "|\\[[^\\]\\n]*" + SRC_PATH + "[^\\]\\n]*\\]\\.(?:flatMap|map)\\(" + LISTER);
  // The path can also reach the lister through a constant: const DIR = join(ROOT, "src/x"); ... readdirSync(DIR).
  // The initializer stops at a semicolon or the next declaration, so code without semicolons binds the right name.
  const SRC_CONSTANT = new RegExp("const\\s+([A-Za-z_$][\\w$]*)\\s*=(?:(?!\\b(?:const|let|var|function)\\b)[^;])*?" + SRC_PATH, "g");
  const scansSource = (text) => SCANS_SOURCE.test(text)
    || [...text.matchAll(SRC_CONSTANT)].some(([, name]) => new RegExp(LISTER + "\\([^)\\n]*\\b" + name + "\\b").test(text));
  for (const spelling of ['readdirSync(join(ROOT, "src/learn"))', "walk('src')", 'sourceFiles("./src")', 'readdirSync(resolve(`src/tools`))',
    '["src/tools", "src/agent"].flatMap(walk)', 'const DIR = join(\n  ROOT,\n  "src/compliance",\n);\nreaddirSync(DIR, { recursive: true })',
    'const ROOT = here()\nconst DIR = join(ROOT, "src/x")\nreaddirSync(DIR)', 'const DIR = "src/x";\nreaddirSync(join(ROOT, DIR))'])
    assert.ok(scansSource(spelling), spelling);
  assert.ok(!scansSource('mkdirSync(join(root, "src"))'), "creating a fixture directory is not a scan");
  assert.ok(!scansSource('readdirSync(join(root, "src-" + label))'), "a src- prefixed scratch folder is not src");
  assert.ok(!scansSource('const FILE = join(ROOT, "src/x.ts"); readFileSync(FILE)'), "reading one named file is not a scan");
  // This file holds the sample spellings above, not a scan.
  const scanners = readdirSync("test").filter((name) => /\.test\.(?:ts|tsx|mjs)$/.test(name) && name !== "qa-affected.test.mjs")
    .filter((name) => scansSource(readFileSync("test/" + name, "utf8"))).map((name) => "test/" + name).sort();
  assert.ok(scanners.includes("test/teardown-adapter-terraform.test.ts"), "the detector finds the known scanners");
  assert.deepEqual(scanners.filter((name) => !Object.hasOwn(SOURCE_SCAN_GUARDS, name)), [],
    "add each source-scanning test to SOURCE_SCAN_GUARDS in scripts/qa-affected.mjs with the roots it scans");
  for (const [guard, roots] of Object.entries(SOURCE_SCAN_GUARDS)) {
    assert.ok(readdirSync("test").includes(guard.slice("test/".length)), guard + " exists");
    assert.ok(roots.length > 0 && roots.every((root) => /^src\/(?:[^/]+\/)?$/.test(root)), guard + " roots are source directories");
  }
});

test("a change under src/lifecycle runs the runner's tests and the release admission review's test it reuses", () => {
  const files = fixture();
  files.set("src/lifecycle/evidence.ts", 'import "../qualification/release-admission.js"; export const e = 1;');
  files.set("src/qualification/release-admission.ts", "export const r = 1;");
  files.set("test/lifecycle-runner.test.ts", 'import "../src/lifecycle/evidence.js";');
  files.set("test/lifecycle-cli.test.ts", "test()");
  files.set("test/release-admission.test.ts", 'import "../src/qualification/release-admission.js";');
  const plan = planChanged(["src/lifecycle/evidence.ts"], files);
  for (const owner of ["test/lifecycle-runner.test.ts", "test/lifecycle-cli.test.ts", "test/release-admission.test.ts"]) assert.ok(plan.nodeTests.includes(owner), owner);
  assert.deepEqual(plan.gaps, []);
});

test("the ./alz dispatcher, which no test can import, is owned by the guards that read it, and an unowned unimportable source is still a gap", () => {
  const files = fixture();
  files.set("src/cli/operator.ts", "const command = process.argv[2]; if (command === \"deps\") {}");
  files.set("test/operator-cli.test.ts", "test()");
  const plan = planChanged(["src/cli/operator.ts"], files);
  assert.deepEqual(plan.gaps, []);
  for (const owner of UNIMPORTABLE_OWNERS["src/cli/operator.ts"]) assert.ok(plan.nodeTests.includes(owner), owner);
  files.set("src/cli/orphan.ts", "export const x = 1;");
  assert.match(planChanged(["src/cli/orphan.ts"], files).gaps.join(" "), /src\/cli\/orphan\.ts has no importing test/);
});

test("the console launcher is owned by the console tests that read it, and the bootstrap templates by the test that reads them; an unowned template is still a gap", () => {
  const files = fixture();
  files.set("src/cli/operator-web.ts", "console.log(1);");
  files.set("test/ui-channel.test.ts", "test()");
  const launcher = planChanged(["src/cli/operator-web.ts"], files);
  assert.deepEqual(launcher.gaps, []);
  assert.ok(launcher.nodeTests.includes("test/ui-channel.test.ts"));
  files.set("test/bootstrap-gcp.test.ts", "test()"); // the GCP template's own package owner, beside the contract test
  for (const [path, owners] of Object.entries(TEMPLATE_OWNERS)) {
    files.set(path, "{}");
    for (const owner of owners) files.set(owner, "test()");
    const plan = planChanged([path], files);
    assert.deepEqual(plan.gaps, [], path);
    for (const owner of owners) assert.ok(plan.nodeTests.includes(owner), owner);
  }
  // A template nothing owns is still a gap (an invented name: every shipped template has an owner).
  files.set("bootstrap/config.unowned.template.json", "{}");
  assert.match(planChanged(["bootstrap/config.unowned.template.json"], files).gaps.join(" "), /config\.unowned\.template\.json has no QA ownership rule/);
});

test("a fixture a test reads from disk is owned by its declared test, an unowned fixture is still a gap, and a deleted module is a note", () => {
  const files = fixture();
  for (const [path, owners] of Object.entries(FIXTURE_OWNERS)) {
    files.set(path, "{}");
    for (const owner of owners) files.set(owner, "test()");
    const plan = planChanged([path], files);
    assert.deepEqual(plan.gaps, [], path);
    for (const owner of owners) assert.ok(plan.nodeTests.includes(owner), owner);
  }
  files.set("test/fixtures/orphan.json", "{}");
  assert.match(planChanged(["test/fixtures/orphan.json"], files).gaps.join(" "), /orphan\.json has no known test owner/);
  const deleted = planChanged(["src/apply/gone.ts"], files);
  assert.deepEqual(deleted.gaps, []);
  assert.match(deleted.notes.join(" "), /src\/apply\/gone\.ts was deleted/);
  files.set("src/apply/orphan.ts", "export const x = 1;");
  assert.match(planChanged(["src/apply/orphan.ts"], files).gaps.join(" "), /src\/apply\/orphan\.ts has no importing test/);
});

test("the construct judge's real Terraform fixtures are owned by its focused test, never a gap", () => {
  const files = fixture();
  const owner = "test/apply-terraform-constructs.test.ts";
  for (const path of Object.keys(FIXTURE_OWNERS).filter((p) => p.startsWith("test/fixtures/live/terraform/"))) {
    assert.deepEqual(FIXTURE_OWNERS[path], [owner], path);
    const plan = planChanged([path], new Map([...files, [owner, ""], [path, ""]]));
    assert.deepEqual(plan.gaps, [], path);
    assert.ok(plan.nodeTests.includes(owner), path);
  }
  const manifest = "test/fixtures/live/MANIFEST.json", manifestOwner = "test/teardown-live-fixtures.test.ts";
  const plan = planChanged([manifest], new Map([...files, [manifestOwner, ""], [manifest, "{}"]]));
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.nodeTests.includes(manifestOwner));
});
