import assert from "node:assert/strict";
import test from "node:test";

import { PLUGIN_CATALOG } from "../src/plugins/catalog.js";
import type { DepCheck } from "../src/deps/checks.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";
import { planSetup, type SetupIntent } from "../src/onboarding/plan.js";
import { runGuidedSetup } from "../src/onboarding/terminal.js";

const checks: DepCheck[] = [
  { id: "node", label: "Node 26", required: false, ok: true, detail: "Node 26" },
  { id: "git", label: "Git", required: false, ok: true, detail: "Git ready" },
  { id: "terraform", label: "Terraform", required: false, ok: true, detail: "Managed pinned binary" },
  { id: "ollama", label: "Ollama", required: false, ok: false, detail: "not installed" },
  { id: "product:crossplane", label: "crossplane", required: false, ok: false, detail: "not installed" },
  { id: "product:pulumi", label: "pulumi", required: false, ok: true, detail: "Pulumi ready" },
];

const intent = (over: Partial<SetupIntent> = {}): SetupIntent => ({
  provider: "aws", stage: "development", engine: "terraform", localModels: false, ...over,
});

test("all supported IaC engines including Crossplane remain available as explicit options", () => {
  assert.ok(PLUGIN_CATALOG.find((plugin) => plugin.id === "CROSSPLANE"));
  const plan = planSetup(intent({ engine: "crossplane", stage: "staging" }), checks);
  assert.equal(plan.tools.find((x) => x.id === "product:crossplane")?.status, "REQUIRED");
  assert.equal(plan.tools.find((x) => x.id === "product:crossplane")?.installed, false);
  assert.match(plan.blocked.join(" "), /crossplane/i);
  assert.match(plan.notice, /non-production|Staging|staging/i);
  assert.equal(plan.notice.includes("ACT is disabled"), true);
});

test("required/optional dependencies are selected per workflow, not falsely global", () => {
  const tour = planSetup(intent(), checks, { offlineTour: true });
  assert.equal(tour.tools.find((x) => x.id === "terraform")?.status, "OPTIONAL");
  assert.deepEqual(tour.blocked, []);
  const core = planSetup(intent(), checks);
  assert.deepEqual(core.blocked, []);
  assert.equal(core.tools.find((x) => x.id === "terraform")?.status, "REQUIRED");
  assert.equal(core.tools.find((x) => x.id === "ollama")?.status, "OPTIONAL");
  assert.equal(core.tools.find((x) => x.id === "product:crossplane")?.status, "OPTIONAL");
  const models = planSetup(intent({ localModels: true }), checks);
  assert.equal(models.tools.find((x) => x.id === "ollama")?.status, "REQUIRED");
  assert.match(models.blocked.join(" "), /ollama/i);
});

test("dev/staging/prod are distinct planning contexts, never an ACT grant", () => {
  for (const stage of ["development", "staging", "production"] as const) {
    const plan = planSetup(intent({ stage }), checks);
    assert.equal(plan.intent.stage, stage);
    assert.match(plan.notice, /ACT is disabled/);
    assert.equal("actEnabled" in plan, false);
    assert.equal("credentials" in plan, false);
  }
  const gcp = planSetup(intent({ provider: "gcp", stage: "production" }), checks);
  assert.equal(gcp.qualification, "SYNTHETIC_ONLY");
  assert.equal(gcp.supportedDemo, true);
  assert.equal(gcp.tools.find((x) => x.id === "gcloud")?.status, "OPTIONAL");
  assert.ok(planSetup(intent({ provider: "gcp", engine: "crossplane" }), checks).blocked.length > 0);
  assert.throws(() => planSetup(intent({ stage: "pilot" as never }), checks), /SETUP_SELECTION_INVALID/);
});

function terminal(answers: string[], tty = true): HumanTerminal & { shown: string[]; asked: number } {
  const shown: string[] = [];
  const instance = {
    stdinIsTTY: tty, stdoutIsTTY: tty, shown, asked: 0,
    write: (text: string) => { shown.push(text); },
    ask: async () => { instance.asked += 1; return answers.shift() ?? "q"; },
  };
  return instance;
}

test("non-interactive setup fails closed without opening the console or invoking dependencies", async () => {
  let probes = 0;
  const t = terminal([], false);
  const result = await runGuidedSetup({ terminal: t, collectChecks: async () => { probes++; return checks; } });
  assert.equal(result.openWorkspace, false);
  assert.equal(result.openBrowser, false);
  assert.equal(t.asked, 0);
  assert.equal(probes, 0);
});

test("single-command tour opens loopback UI only after terminal choices", async () => {
  const t = terminal(["1", "y", "y"]);
  const result = await runGuidedSetup({ terminal: t, checks });
  assert.deepEqual([result.openWorkspace, result.openBrowser], [true, true]);
  assert.match(t.shown.join(" "), /ACT disabled/);
  assert.match(t.shown.join(" "), /Crossplane/);
});

test("staging/GCP configuration is a reviewable dry-run: no installer, login or auto-launch", async () => {
  // configure, staging, GCP, terraform, offline fixtures, decline browser UI.
  const t = terminal(["2", "2", "3", "1", "1", "n"]);
  const result = await runGuidedSetup({ terminal: t, checks });
  assert.equal(result.openWorkspace, false);
  assert.deepEqual(result.selected, intent({ provider: "gcp", stage: "staging" }));
  assert.match(t.shown.join(" "), /staging \/ GCP \/ TERRAFORM/);
  assert.match(t.shown.join(" "), /No installation, cloud login, Terraform plan/);
});

test("dependency-only inspection never installs optional Crossplane or other tools", async () => {
  const t = terminal(["3"]);
  const result = await runGuidedSetup({ terminal: t, checks });
  assert.equal(result.openWorkspace, false);
  assert.match(t.shown.join(" "), /Crossplane|crossplane/i);
  assert.match(t.shown.join(" "), /Nothing installed here/);
});
