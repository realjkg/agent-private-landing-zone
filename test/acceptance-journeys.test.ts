import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JOURNEY_STEPS, REQUIRED_ROWS, checkJourneyMatrix, loadJourneyMatrix, type JourneyMatrix, type StepClaim } from "../src/release/acceptance.js";

// The tracked delivery plan (config/acceptance/journeys.json) is executable: every status is a claim checked against the code
// and tests in this repository. These tests fail when a claim is not backed, whatever the matrix says.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("the shipped journey matrix holds only claims the repository backs", () => {
  const result = checkJourneyMatrix(loadJourneyMatrix(repoRoot), repoRoot);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows.map((row) => row.cloud + "/" + row.path), REQUIRED_ROWS.map((row) => row.cloud + "/" + row.path));
  // The focus row (AWS Terraform) is implemented end to end synthetically: every step and every proof passes with a fake engine
  // and a fake AWS CLI. Nothing is live, and every other row still has open steps.
  for (const row of result.rows) {
    const focus = row.cloud === "AWS" && row.path === "TERRAFORM";
    assert.equal(row.implemented, focus, row.cloud + "/" + row.path);
    assert.equal(row.steps.observe === "SYNTHETIC_PASS" && row.steps.cleanup === "SYNTHETIC_PASS", focus, row.cloud + "/" + row.path);
    assert.notEqual(row.live, "LIVE_PASS");
    assert.equal(row.status === "SYNTHETIC_PASS", focus, row.cloud + "/" + row.path);
  }
});

// --- the validator refuses every overclaim ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "alz-acceptance-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "test"), { recursive: true });
writeFileSync(join(root, "src", "step.ts"), "export const step = 1;\n");
writeFileSync(join(root, "test", "console.test.ts"), 'import { createPilotRouter } from "x";\ntest("console journey", () => {});\n');
writeFileSync(join(root, "test", "mocked.test.tsx"), 'vi.stubGlobal("fetch", () => {});\ntest("mocked page", () => {});\n');
writeFileSync(join(root, "test", "unit.test.ts"), ['positive', 'denied', 'interrupted', 'recovery', 'proof'].map((t) => 'test("' + t + '", () => {});').join("\n"));

const ref = (title: string, file = "test/unit.test.ts", scope?: "ROW" | "SHARED_ENGINE") => ({ file, title, ...(scope ? { scope } : {}) });
const passing = (): StepClaim => ({
  status: "SYNTHETIC_PASS", code: ["src/step.ts"],
  tests: { ui: [ref("console journey", "test/console.test.ts")], positive: [ref("positive")], denied: [ref("denied")], interrupted: [ref("interrupted")], recovery: [ref("recovery")] },
});
const proof = () => ({ status: "SYNTHETIC_PASS" as const, code: ["src/step.ts"], tests: [ref("proof")] });
/** Six rows, every step and proof passing synthetically, live not done: the strongest honest synthetic matrix. */
function matrix(edit: (m: JourneyMatrix) => void = () => undefined): JourneyMatrix {
  const m: JourneyMatrix = {
    schemaVersion: 1, focus: { cloud: "AWS", path: "TERRAFORM" },
    rows: REQUIRED_ROWS.map((row) => ({
      ...row,
      steps: Object.fromEntries(JOURNEY_STEPS.map((step) => [step, passing()])) as JourneyMatrix["rows"][number]["steps"],
      proofs: { blueprint: proof(), independentVerification: proof(), cleanupDisposition: proof(), sourceBoundEvidence: proof() },
      live: { status: "BLOCKED", blockedBy: "Owner-supervised DEV run not authorized yet." },
    })),
  };
  edit(m);
  return m;
}
const problemsOf = (m: unknown) => checkJourneyMatrix(m, root).problems;
const refused = (m: unknown, pattern: RegExp) => {
  const problems = problemsOf(m);
  assert.ok(problems.some((p) => pattern.test(p)), "expected " + pattern + ", got " + JSON.stringify(problems));
};

test("a fully backed synthetic matrix passes and reports every row implemented but not live", () => {
  const result = checkJourneyMatrix(matrix(), root);
  assert.deepEqual(result.problems, []);
  assert.ok(result.rows.every((row) => row.implemented && row.status === "SYNTHETIC_PASS" && row.live === "BLOCKED"));
});

test("there is no COMPLETE status, and every row and step must be present in order", () => {
  refused(matrix((m) => { (m.rows[0].steps.prepare as { status: string }).status = "COMPLETE"; }), /prepare: status must be one of/);
  refused(matrix((m) => { m.rows.pop(); }), /rows must be exactly/);
  refused(matrix((m) => { m.rows.reverse(); }), /rows must be exactly/);
  refused(matrix((m) => { delete (m.rows[0].steps as Partial<typeof m.rows[0]["steps"]>).cleanup; }), /cleanup: status must be one of/);
  refused({ schemaVersion: 2, rows: [] }, /schemaVersion 1/);
});

test("SYNTHETIC_PASS needs code that exists and a resolvable test of every kind", () => {
  for (const kind of ["ui", "positive", "denied", "interrupted", "recovery"] as const) {
    refused(matrix((m) => { delete m.rows[0].steps.preview.tests![kind]; }), new RegExp("preview: SYNTHETIC_PASS needs a " + kind + " test"));
  }
  refused(matrix((m) => { m.rows[0].steps.preview.code = ["src/missing.ts"]; }), /code src\/missing\.ts does not exist/);
  refused(matrix((m) => { m.rows[0].steps.preview.code = ["../outside.ts"]; }), /does not exist/);
  refused(matrix((m) => { m.rows[0].steps.preview.tests!.positive = [ref("a title nobody wrote")]; }), /has no test titled/);
  refused(matrix((m) => { m.rows[0].steps.preview.tests!.denied = [ref("denied", "test/gone.test.ts")]; }), /test file test\/gone\.test\.ts does not exist/);
});

test("a stale citation is refused even on an unfinished step", () => {
  refused(matrix((m) => { m.rows[1].steps.observe = { status: "NOT_IMPLEMENTED", missing: "Nothing reads the cloud back yet.", tests: { positive: [ref("renamed away")] } }; }), /has no test titled/);
});

test("the console proof must start the real router and run on this row's own cloud and path", () => {
  refused(matrix((m) => { m.rows[0].steps.approve.tests!.ui = [ref("mocked page", "test/mocked.test.tsx")]; }), /does not start the real pilot router/);
  refused(matrix((m) => { m.rows[0].steps.approve.tests!.ui = [ref("console journey", "test/console.test.ts", "SHARED_ENGINE")]; }), /ui test must run on this row's own cloud/);
  refused(matrix((m) => { m.rows[0].steps.approve.tests!.denied = [ref("denied", undefined, "SHARED_ENGINE")]; }), /denied test must run on this row's own cloud/);
  // Shared engine code may prove interruption and recovery.
  assert.deepEqual(problemsOf(matrix((m) => { m.rows[0].steps.approve.tests!.recovery = [ref("recovery", undefined, "SHARED_ENGINE")]; })), []);
});

test("execute, observe and cleanup cannot pass without their row proofs", () => {
  refused(matrix((m) => { m.rows[0].proofs.sourceBoundEvidence = { status: "NOT_IMPLEMENTED", missing: "No commit in the evidence yet." }; }), /execute: SYNTHETIC_PASS needs the row proof sourceBoundEvidence/);
  refused(matrix((m) => { m.rows[0].proofs.blueprint = { status: "NOT_IMPLEMENTED", missing: "No resource ID mapping yet." }; }), /observe: SYNTHETIC_PASS needs the row proof blueprint/);
  refused(matrix((m) => { m.rows[0].proofs.independentVerification = { status: "NOT_IMPLEMENTED", missing: "No independent read yet." }; }), /observe: SYNTHETIC_PASS needs the row proof independentVerification/);
  refused(matrix((m) => { m.rows[0].proofs.cleanupDisposition = { status: "NOT_IMPLEMENTED", missing: "No disposition record yet." }; }), /cleanup: SYNTHETIC_PASS needs the row proof cleanupDisposition/);
  refused(matrix((m) => { m.rows[0].proofs.blueprint = { status: "SYNTHETIC_PASS", code: ["src/step.ts"] }; }), /proof blueprint: SYNTHETIC_PASS needs at least one test/);
});

test("an unfinished claim must say what is missing, and a blocked one its exact dependency", () => {
  refused(matrix((m) => { m.rows[0].steps.observe = { status: "NOT_IMPLEMENTED" }; }), /observe: NOT_IMPLEMENTED needs a sentence/);
  refused(matrix((m) => { m.rows[0].steps.observe = { status: "BLOCKED", blockedBy: "owner" }; }), /observe: BLOCKED needs the exact dependency/);
  refused(matrix((m) => { m.rows[0].live = { status: "BLOCKED" }; }), /live: BLOCKED needs the exact dependency/);
  refused(matrix((m) => { m.rows[0].proofs.blueprint = { status: "NOT_IMPLEMENTED" }; }), /proof blueprint: NOT_IMPLEMENTED needs a sentence/);
  // A row is only as far along as its weakest step.
  const result = checkJourneyMatrix(matrix((m) => { m.rows[0].steps.cleanup = { status: "NOT_IMPLEMENTED", missing: "No owner-supervised destroy yet." }; }), root);
  assert.equal(result.rows[0].status, "NOT_IMPLEMENTED");
  assert.equal(result.rows[0].implemented, false);
});

test("LIVE_PASS needs every synthetic proof first and an evidence file naming commit, cloud, target, engine and outcome", () => {
  const evidence = { label: "LIVE", sourceCommit: "a".repeat(40), cloud: "AWS", target: { account: "111111111111" }, engine: "TERRAFORM", outcome: "SUCCEEDED" };
  writeFileSync(join(root, "test", "live.json"), JSON.stringify(evidence));
  const live = (edit: (m: JourneyMatrix) => void = () => undefined) => matrix((m) => { m.rows[0].live = { status: "LIVE_PASS", evidence: "test/live.json" }; edit(m); });
  assert.deepEqual(problemsOf(live()), []);
  refused(matrix((m) => { m.rows[0].live = { status: "LIVE_PASS" }; }), /LIVE_PASS needs an evidence file/);
  for (const [field, value] of [["label", "SYNTHETIC"], ["sourceCommit", "main"], ["engine", "CDK"], ["cloud", "AZURE"], ["outcome", undefined], ["target", "x"]] as const) {
    writeFileSync(join(root, "test", "bad.json"), JSON.stringify({ ...evidence, [field]: value }));
    refused(matrix((m) => { m.rows[0].live = { status: "LIVE_PASS", evidence: "test/bad.json" }; }), /LIVE_PASS needs an evidence file/);
  }
  refused(live((m) => { m.rows[0].steps.cleanup = { status: "NOT_IMPLEMENTED", missing: "No owner-supervised destroy yet." }; }), /LIVE_PASS needs every step and proof to pass synthetically first/);
});

test("one step can be LIVE_PASS before its row, only with its own matching live record", () => {
  const record = {
    schemaVersion: 1, label: "LIVE", step: "execute", cloud: "AWS", engine: "TERRAFORM", environment: "DEV", target: { account: "111111111111", backend: "b", workspace: "default" },
    sourceCommit: "a".repeat(40), artifactSha256: "1".repeat(64), outcome: "SUCCEEDED", evidenceSha256: "2".repeat(64), contractSha256: "3".repeat(64),
    attestedBy: "operator", attestedAt: "2026-10-25T00:00:00.000Z",
  };
  const withRecord = (over: Record<string, unknown>, step: "execute" | "prepare" = "execute") => {
    writeFileSync(join(root, "test", "step-live.json"), JSON.stringify({ ...record, ...over }));
    return matrix((m) => { m.rows[0].steps[step] = { ...m.rows[0].steps[step], status: "LIVE_PASS", liveEvidence: "test/step-live.json" }; });
  };
  const result = checkJourneyMatrix(withRecord({}), root);
  assert.deepEqual(result.problems, []);
  assert.equal(result.rows[0].steps.execute, "LIVE_PASS");
  assert.equal(result.rows[0].live, "BLOCKED", "the row is not live because one step is");
  refused(matrix((m) => { m.rows[0].steps.execute.status = "LIVE_PASS"; }), /execute: LIVE_PASS needs liveEvidence/);
  for (const [field, value] of [["label", "SYNTHETIC"], ["step", "preview"], ["cloud", "AZURE"], ["engine", "CDK"], ["sourceCommit", "HEAD"],
    ["outcome", "PARTIAL_REQUIRES_REVIEW"], ["artifactSha256", "x"], ["evidenceSha256", undefined], ["attestedBy", ""], ["target", "acct"]] as const) {
    refused(withRecord({ [field]: value }), /execute: LIVE_PASS needs liveEvidence/);
  }
  // The record names its step: an execute record cannot make prepare live.
  refused(withRecord({}, "prepare"), /prepare: LIVE_PASS needs liveEvidence/);
  // A live step still needs every synthetic proof.
  refused(matrix((m) => {
    writeFileSync(join(root, "test", "step-live.json"), JSON.stringify(record));
    m.rows[0].steps.execute = { ...m.rows[0].steps.execute, status: "LIVE_PASS", liveEvidence: "test/step-live.json" };
    delete m.rows[0].steps.execute.tests!.recovery;
  }), /execute: LIVE_PASS needs a recovery test/);
});
