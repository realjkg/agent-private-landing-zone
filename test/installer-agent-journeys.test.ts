import assert from "node:assert/strict";
import test from "node:test";

import { buildJourneyMatrix, runAgentJourney, runJourneyMatrix, fixtureChecks, type Journey } from "../src/onboarding/agent-journeys.js";
import { mockBoundary, MOCK_AUTH_CHOICES, MOCK_ACT_CHOICES } from "../src/onboarding/mock-boundary.js";
import { ENGINES, PROVIDERS, STAGES } from "../src/onboarding/plan.js";
import { runGuidedSetup } from "../src/onboarding/terminal.js";
import type { HumanTerminal } from "../src/cli/teardown-driver.js";

const matrix = buildJourneyMatrix();

test("scripted setup agents exhaustively walk all stage/provider/engine and auth-fixture combinations", async () => {
  const results = await runJourneyMatrix();
  assert.equal(results.count, PROVIDERS.length * STAGES.length * ENGINES.length * 3 + 5);
  assert.equal(results.results.length, new Set(results.results.map(x => x.id)).size);
  assert.match(results.digest, /^[a-f0-9]{64}$/);
  for (const result of results.results) {
    assert.equal(result.actVerdict, "DENIED_ACT_DISABLED");
    assert.equal(result.workspaceLaunch, "SIMULATED_ONLY");
    assert.equal(result.cloudRequests, 0);
    assert.equal(result.modelInvocations, 0);
    assert.equal(result.infrastructureMutations, 0);
    assert.equal(result.evidenceBasis, "SCRIPTED_SYNTHETIC_JOURNEY_NOT_PRODUCTION_QUALIFICATION");
    assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/);
    assert.ok(result.observedPrompts.some(x => x.includes("ACT disabled")));
    assert.ok(!result.observedPrompts.some(x => /access_token|private_key|refresh_token|secret=[a-z]/i.test(x)));
  }
});

test("expired/wrong-scope/denied fake sign-ins are refused; valid fake sign-in still cannot enable ACT", () => {
  for (const auth of MOCK_AUTH_CHOICES) for (const act of MOCK_ACT_CHOICES) {
    const result = mockBoundary(auth, act);
    assert.equal(result.infrastructureResult, "DENIED_ACT_DISABLED");
    assert.equal(result.evidence, "SYNTHETIC_NOT_QUALIFIED");
    if (auth === "VALID_FIXTURE") assert.equal(result.authResult, "SYNTHETIC_AUTH_OK");
    if (["EXPIRED_FIXTURE", "WRONG_SCOPE_FIXTURE", "DENIED_FIXTURE"].includes(auth))
      assert.equal(result.authResult, "SYNTHETIC_AUTH_REJECTED");
    if (act === "MODEL_REQUEST_FIXTURE") assert.equal(result.approvalResult, "MODEL_HAS_NO_AUTHORITY");
  }
  assert.throws(() => mockBoundary("LIVE_AUTH" as never, "NONE"), /MOCK_BOUNDARY_INPUT_INVALID/);
  assert.throws(() => mockBoundary("VALID_FIXTURE", "APPLY" as never), /MOCK_BOUNDARY_INPUT_INVALID/);
});

test("all engines appear, and missing Crossplane/pinned Terraform are independently blocked", async () => {
  const crossplane = await runAgentJourney(matrix.find(x => x.id === "crossplane-absent")!);
  assert.equal(crossplane.dependencyVerdict, "BLOCKED");
  assert.equal(crossplane.cloudRequests, 0);
  const core = await runAgentJourney(matrix.find(x => x.id === "first-run-missing-core")!);
  assert.equal(core.dependencyVerdict, "BLOCKED");
  assert.match(core.observedPrompts.join(""), /Installation skipped/);
  assert.ok(fixtureChecks("READY", "terraform").some(x => x.id === "product:crossplane"));
});

test("identical scripted agent inputs always produce the same evidence digest", async () => {
  const scenario = matrix.find((x) => x.id === "model-attempts-act")!;
  const first = await runAgentJourney(scenario);
  const second = await runAgentJourney(scenario);
  assert.equal(first.evidenceSha256, second.evidenceSha256);
  assert.equal(first.mockApproval, "MODEL_HAS_NO_AUTHORITY");
  assert.equal(first.actVerdict, "DENIED_ACT_DISABLED");
});

function fakeTerminal(answers: string[]): HumanTerminal & { output: string[]; prompts: string[] } {
  const output: string[] = [];
  const prompts: string[] = [];
  const term = {
    stdinIsTTY: true, stdoutIsTTY: true, output, prompts,
    write: (value: string) => { output.push(value); },
    ask: async (question: string) => { prompts.push(question); return answers.shift() ?? "q"; },
  };
  return term;
}

test("dependency inspection offers follow-through paths; no install or browser without consent", async () => {
  const checks = fixtureChecks("MISSING_OPTIONAL", "crossplane");
  const term = fakeTerminal(["3", "1", "2", "2", "7", "1", "n"]);
  let installs = 0;
  const result = await runGuidedSetup({
    terminal: term, checks,
    installPinned: async () => { installs++; return { installed: [], skipped: [] }; },
  });
  assert.equal(installs, 0);
  assert.equal(result.openWorkspace, false);
  assert.equal(result.selected?.engine, "crossplane");
  assert.equal(result.selected?.stage, "staging");
  assert.match(term.output.join(""), /Crossplane|crossplane/i);
  assert.match(term.output.join(""), /REQUIRED|Required dependencies/i);
});

test("approved pin installation path is selectable, cancellation never calls installer", async () => {
  const checks = fixtureChecks("MISSING_PINNED", "terraform");
  let invoked = 0;
  const cancel = fakeTerminal(["3", "2", "q"]);
  await runGuidedSetup({ terminal: cancel, checks,
    installPinned: async () => { invoked++; return { installed: [], skipped: [] }; } });
  assert.equal(invoked, 0);
  const select = fakeTerminal(["3", "2", "1"]);
  const result = await runGuidedSetup({ terminal: select, checks,
    installPinned: async (selected) => {
      invoked++;
      assert.deepEqual(selected, ["terraform"]);
      return { installed: [], skipped: ["terraform"] };
    },
  });
  assert.equal(result.openWorkspace, false);
  assert.equal(invoked, 1);
});

test("malicious installer choices cannot inject commands, bypass prompts or open browser", async () => {
  const checks = fixtureChecks("READY", "terraform");
  const terminal = fakeTerminal(["2", "1; export ALZ_ACT=1", "../apply", "999"]);
  const result = await runGuidedSetup({ terminal, checks });
  assert.equal(result.openWorkspace, false);
  assert.equal(result.openBrowser, false);
  assert.match(terminal.output.join(""), /Too many invalid entries/);
  const wrong = { ...matrix[0]!, id: "../escape" } as Journey;
  await assert.rejects(() => runAgentJourney(wrong), /AGENT_JOURNEY_ID_INVALID/);
});
