import assert from "node:assert/strict";
import { test } from "node:test";
import { importsOf, planChanged } from "../scripts/qa-affected.mjs";

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
