import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureThinker } from "../src/agent/fixture.js";
import { runAgentKernel } from "../src/agent/graph.js";
import { DemoLifecycle, rehearseDemoAct } from "../src/demo/lifecycle.js";

const state = await runAgentKernel({
  request: "Design the safest additive landing-zone delta using Terraform.",
  provider: "AWS", engine: "TERRAFORM", mock: "brownfield", thinker: fixtureThinker,
});

test("simulated ACT builds a canary and removes only that canary, preserving all discovered resources", () => {
  const { built, cleaned } = rehearseDemoAct(state);
  assert.equal(built.phase, "BUILT");
  assert.equal(built.demoResourcesRemaining.length, 1);
  assert.equal(cleaned.phase, "DESTROYED");
  assert.equal(cleaned.cleanupVerified, true);
  assert.equal(cleaned.baselinePreserved, true);
  assert.deepEqual(cleaned.inventory, state.environment!.resources.map((r) => r.resourceId).sort());
  assert.deepEqual(cleaned.demoResourcesRemaining, []);
  assert.equal(cleaned.liveActEnabled, false);
  assert.equal(cleaned.cloudMutation, false);
  assert.equal(cleaned.liveQualification, false);
  assert.deepEqual(cleaned.events, ["DISCOVER_SIMULATED", "PLAN_SIMULATED", "BUILD_APPROVAL_SIMULATED",
    "ACT_BUILD_SIMULATED", "VERIFY_BUILD_SIMULATED", "CLEANUP_APPROVAL_SIMULATED",
    "ACT_DESTROY_SIMULATED", "VERIFY_CLEANUP_SIMULATED"]);
});

test("build and cleanup require distinct matching simulated approvals and valid ordering", () => {
  const demo = new DemoLifecycle(state);
  assert.throws(() => demo.build(), /DEMO_BUILD_NOT_APPROVED/);
  assert.throws(() => demo.approveBuild("stale-plan"), /DEMO_APPROVAL_MISMATCH/);
  assert.throws(() => demo.approveCleanup(demo.cleanupHash), /DEMO_CLEANUP_APPROVAL_MISMATCH/);
  demo.approveBuild(demo.planHash);
  demo.build();
  assert.throws(() => demo.build(), /DEMO_BUILD_NOT_APPROVED/);
  assert.throws(() => demo.destroy(), /DEMO_CLEANUP_NOT_APPROVED/);
  assert.throws(() => demo.approveCleanup(demo.planHash), /DEMO_CLEANUP_APPROVAL_MISMATCH/);
  demo.approveCleanup(demo.cleanupHash);
  demo.destroy();
  assert.throws(() => demo.destroy(), /DEMO_CLEANUP_NOT_APPROVED/);
  assert.equal(demo.evidence().cleanupVerified, true);
});

test("live, unknown, failed, ineligible and conflicting discovery cannot enter demo ACT", () => {
  for (const change of [
    (s: typeof state) => { s.mock = undefined; },
    (s: typeof state) => { s.mock = "unknown"; },
    (s: typeof state) => { s.environment!.classification = "UNKNOWN"; },
    (s: typeof state) => { s.design!.status = "BLOCKED"; },
    (s: typeof state) => { s.design!.plugin.buildEligible = false; },
    (s: typeof state) => { s.phase = "FAILED"; },
    (s: typeof state) => { s.environment!.conflicts.push({ code: "UNKNOWN_OWNER", message: "Unowned" }); },
  ]) {
    const refused = structuredClone(state);
    change(refused);
    assert.throws(() => new DemoLifecycle(refused), /DEMO_ACT_BLOCKED/);
  }
  const collision = structuredClone(state);
  collision.environment!.resources[0].resourceId = "demo://aws/canary";
  assert.throws(() => new DemoLifecycle(collision), /DEMO_ACT_OWNERSHIP_CONFLICT/);
});

test("plan and evidence cannot mutate baseline; interrupted rehearsal restarts without persistent resources", () => {
  const demo = new DemoLifecycle(state);
  assert.throws(() => (demo.plan.baseline as string[]).push("foreign-resource"), TypeError);
  demo.approveBuild(demo.planHash);
  demo.build();
  const snapshot = demo.evidence();
  snapshot.inventory.length = 0;
  snapshot.events.length = 0;
  assert.equal(demo.evidence().demoResourcesRemaining.length, 1);
  const restarted = new DemoLifecycle(state);
  assert.deepEqual(restarted.evidence().inventory, restarted.plan.baseline);
  assert.equal(restarted.evidence().cleanupVerified, false);
  assert.throws(() => restarted.build(), /DEMO_BUILD_NOT_APPROVED/);
});

test("greenfield rehearses cleanup while unknown discovery stays blocked", async () => {
  for (const mock of ["greenfield", "unknown"] as const) {
    const discovered = await runAgentKernel({
      request: "Design the safest additive landing-zone delta using Terraform.",
      provider: "AWS", engine: "TERRAFORM", mock, thinker: fixtureThinker,
    });
    if (mock === "unknown") {
      assert.throws(() => rehearseDemoAct(discovered), /DEMO_ACT_BLOCKED/);
    } else {
      assert.equal(rehearseDemoAct(discovered).cleaned.cleanupVerified, true);
    }
  }
});

test("existing demo entry shows complete simulated ACT without cloud access, inference or filesystem writes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "alz-act-demo-"));
  try {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/demo.ts"),
      "--provider", "aws", "--engine", "terraform", "--scenario", "brownfield"], {
      cwd, encoding: "utf8", timeout: 30000,
      env: { PATH: "", HOME: cwd, AGENT_SKIP_LOCAL_MODEL: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ACT DEMO — IN-MEMORY SIMULATION/);
    assert.match(result.stdout, /Live infrastructure ACT\s+DISABLED/);
    const line = result.stdout.split("\n").find((item) => item.startsWith("Synthetic ACT evidence"));
    assert.ok(line);
    const evidence = JSON.parse(line.slice(line.indexOf("{")));
    assert.equal(evidence.cleaned.cleanupVerified, true);
    assert.equal(evidence.cleaned.cloudMutation, false);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
