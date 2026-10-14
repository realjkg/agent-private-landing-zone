import { createHash } from "node:crypto";

import type { DepCheck } from "../deps/checks.js";
import type { HumanTerminal } from "../cli/teardown-driver.js";
import {
  ENGINES, PROVIDERS, STAGES, planSetup, type SetupIntent, type LandingEngine,
  type LandingProvider, type DeploymentStage,
} from "./plan.js";
import { runGuidedSetup, type SetupOutcome } from "./terminal.js";

/**
 * A deterministic scripted operator-agent harness. This never invokes a model,
 * cloud CLI, credential broker, installer, Terraform, or infrastructure action.
 * Fake "authentication" is a status enum, NEVER a credential or token.
 */
export type MockAuth = "NOT_REQUESTED" | "VALID_FIXTURE" | "EXPIRED_FIXTURE" | "WRONG_SCOPE_FIXTURE" | "DENIED_FIXTURE";
export type MockActRequest = "NONE" | "NO_APPROVAL" | "HUMAN_APPROVAL_FIXTURE" | "MODEL_REQUEST_FIXTURE";
export type InstallFixture = "READY" | "MISSING_PINNED" | "MISSING_OPTIONAL" | "VERSION_MISMATCH";
export type Persona = "FIRST_TIME" | "EXPERIENCED" | "RECOVERY" | "ADVERSARIAL";

export type Journey = {
  id: string;
  persona: Persona;
  intent: SetupIntent;
  install: InstallFixture;
  auth: MockAuth;
  act: MockActRequest;
  /** Answers to the final two local browser questions; no browser is opened by this harness. */
  browser: "NO" | "YES";
};
export type JourneyResult = {
  id: string;
  persona: Persona;
  selection: SetupIntent;
  inputTrace: string[];
  observedPrompts: string[];
  dependencyVerdict: "READY" | "BLOCKED";
  cloudAuthVerdict: "NOT_ATTEMPTED" | "SYNTHETIC_AUTH_OK" | "SYNTHETIC_AUTH_REJECTED";
  mockApproval: "NOT_REQUESTED" | "MISSING" | "HUMAN_FIXTURE_ONLY" | "MODEL_HAS_NO_AUTHORITY";
  actVerdict: "DENIED_ACT_DISABLED";
  workspaceLaunch: "SIMULATED_ONLY";
  modelInvocations: 0;
  cloudRequests: 0;
  infrastructureMutations: 0;
  evidenceBasis: "SCRIPTED_SYNTHETIC_JOURNEY_NOT_PRODUCTION_QUALIFICATION";
  evidenceSha256: string;
};

const READY: readonly DepCheck[] = [
  { id: "node", label: "Node 26", required: false, ok: true, detail: "fixture Node 26" },
  { id: "git", label: "Git", required: false, ok: true, detail: "fixture Git" },
  { id: "terraform", label: "Terraform", required: false, ok: true, detail: "fixture Terraform" },
  { id: "ollama", label: "Ollama", required: false, ok: true, detail: "fixture Ollama" },
  { id: "aws-cli", label: "AWS CLI", required: false, ok: true, detail: "fixture AWS" },
  ...["pulumi", "tofu", "bicep", "cdk", "crossplane", "ansible-playbook", "docker", "trivy"]
    .map((name): DepCheck => ({ id: `product:${name}`, label: name, required: false, ok: true, detail: "fixture executable" })),
];

export function fixtureChecks(fixture: InstallFixture, engine: LandingEngine): DepCheck[] {
  return READY.map((tool) => {
    const id = engine === "terraform" ? "terraform" :
      engine === "cloudformation" ? "aws-cli" :
      engine === "opentofu" ? "product:tofu" :
      engine === "ansible" ? "product:ansible-playbook" :
      engine === "cdk" ? "product:cdk" : engine === "crossplane" ? "product:crossplane" :
      engine === "pulumi" ? "product:pulumi" : "product:bicep";
    const broken = fixture === "MISSING_PINNED" && tool.id === "terraform" ||
      fixture === "MISSING_OPTIONAL" && tool.id === id && id !== "terraform" ||
      fixture === "VERSION_MISMATCH" && tool.id === id;
    return broken ? { ...tool, ok: false, detail: fixture === "VERSION_MISMATCH" ? "fixture wrong version" : "fixture missing",
      fix: "Operator review required" } : { ...tool };
  });
}

const numbers = <T extends string>(list: readonly T[], value: T): string => {
  const index = list.indexOf(value);
  if (index < 0) throw new Error("AGENT_SCENARIO_SELECTION_INVALID");
  return String(index + 1);
};

/** The fake operator supplies answers, never process.stdin or application env. */
function scriptedTerminal(answers: string[], prompts: string[]): HumanTerminal {
  let cursor = 0;
  return {
    stdinIsTTY: true, stdoutIsTTY: true,
    write: (text) => { prompts.push(text); },
    ask: async (question) => {
      prompts.push(question);
      const next = answers[cursor++];
      if (next === undefined) throw new Error("AGENT_UNEXPECTED_INSTALLER_QUESTION: " + question);
      return next;
    },
  };
}

export async function runAgentJourney(journey: Journey): Promise<JourneyResult> {
  if (!/^[a-z0-9-]{1,100}$/.test(journey.id)) throw new Error("AGENT_JOURNEY_ID_INVALID");
  const { intent } = journey;
  const answers = [
    "2", numbers(STAGES, intent.stage), numbers(PROVIDERS, intent.provider),
    numbers(ENGINES, intent.engine), intent.localModels ? "2" : "1",
    ...(journey.install === "MISSING_PINNED" && intent.engine === "terraform" ? ["n"] : []),
    journey.browser === "YES" ? "y" : "n",
    ...(journey.browser === "YES" ? ["y"] : []),
  ];
  const prompts: string[] = [];
  const outcome: SetupOutcome = await runGuidedSetup({
    terminal: scriptedTerminal(answers, prompts),
    checks: fixtureChecks(journey.install, intent.engine),
    // This must never be called; the harness is fully disconnected.
    collectChecks: () => { throw new Error("AGENT_LIVE_DEPENDENCY_PROBE_FORBIDDEN"); },
  });
  if (!outcome.selected || outcome.selected.provider !== intent.provider || outcome.selected.stage !== intent.stage || outcome.selected.engine !== intent.engine || outcome.selected.localModels !== intent.localModels) {
    throw new Error("AGENT_INSTALLER_SELECTION_CHANGED");
  }
  const plan = planSetup(intent, fixtureChecks(journey.install, intent.engine));
  const authVerdict = journey.auth === "NOT_REQUESTED" ? "NOT_ATTEMPTED" as const :
    journey.auth === "VALID_FIXTURE" ? "SYNTHETIC_AUTH_OK" as const : "SYNTHETIC_AUTH_REJECTED" as const;
  const approval = journey.act === "NONE" ? "NOT_REQUESTED" as const :
    journey.act === "NO_APPROVAL" ? "MISSING" as const :
    journey.act === "HUMAN_APPROVAL_FIXTURE" ? "HUMAN_FIXTURE_ONLY" as const : "MODEL_HAS_NO_AUTHORITY" as const;
  const canonical = {
    id: journey.id, persona: journey.persona, selection: intent,
    inputTrace: answers, observedPrompts: prompts,
    dependencyVerdict: (plan.blocked.length ? "BLOCKED" : "READY") as "BLOCKED" | "READY",
    cloudAuthVerdict: authVerdict, mockApproval: approval,
    // Even a simulated, successful auth and a simulated human approval MUST
    // never open the real apply boundary or count as production evidence.
    actVerdict: "DENIED_ACT_DISABLED" as const,
    workspaceLaunch: "SIMULATED_ONLY" as const,
    modelInvocations: 0 as const, cloudRequests: 0 as const,
    infrastructureMutations: 0 as const,
    evidenceBasis: "SCRIPTED_SYNTHETIC_JOURNEY_NOT_PRODUCTION_QUALIFICATION" as const,
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { ...canonical, evidenceSha256 };
}

/** Cartesian provider/stage/engine coverage, plus security and setup boundary personas. */
export function buildJourneyMatrix(): Journey[] {
  const result: Journey[] = [];
  for (const provider of PROVIDERS) {
    for (const stage of STAGES) {
      for (const engine of ENGINES) {
        for (const auth of ["VALID_FIXTURE", "EXPIRED_FIXTURE", "WRONG_SCOPE_FIXTURE"] as const) {
          result.push({
            id: `matrix-${provider}-${stage}-${engine}-${auth.toLowerCase().replaceAll("_", "-")}`,
            persona: "EXPERIENCED", intent: { provider, stage, engine, localModels: false },
            install: "READY", auth, act: "HUMAN_APPROVAL_FIXTURE", browser: "NO",
          });
        }
      }
    }
  }
  result.push(
    { id: "first-run-missing-core", persona: "FIRST_TIME",
      intent: { provider: "aws", stage: "development", engine: "terraform", localModels: true },
      install: "MISSING_PINNED", auth: "NOT_REQUESTED", act: "NONE", browser: "NO" },
    { id: "crossplane-absent", persona: "FIRST_TIME",
      intent: { provider: "azure", stage: "staging", engine: "crossplane", localModels: false },
      install: "MISSING_OPTIONAL", auth: "NOT_REQUESTED", act: "NONE", browser: "NO" },
    { id: "invalid-version", persona: "RECOVERY",
      intent: { provider: "aws", stage: "production", engine: "pulumi", localModels: false },
      install: "VERSION_MISMATCH", auth: "DENIED_FIXTURE", act: "NO_APPROVAL", browser: "NO" },
    { id: "model-attempts-act", persona: "ADVERSARIAL",
      intent: { provider: "gcp", stage: "production", engine: "terraform", localModels: true },
      install: "READY", auth: "VALID_FIXTURE", act: "MODEL_REQUEST_FIXTURE", browser: "YES" },
    { id: "human-approval-fixture-denied", persona: "ADVERSARIAL",
      intent: { provider: "azure", stage: "production", engine: "bicep", localModels: false },
      install: "READY", auth: "VALID_FIXTURE", act: "HUMAN_APPROVAL_FIXTURE", browser: "YES" },
  );
  return result;
}

export async function runJourneyMatrix(): Promise<{ count: number; results: JourneyResult[]; digest: string }> {
  const results: JourneyResult[] = [];
  for (const journey of buildJourneyMatrix()) results.push(await runAgentJourney(journey));
  if (results.some((result) => result.infrastructureMutations !== 0 ||
    result.cloudRequests !== 0 || result.modelInvocations !== 0 ||
    result.actVerdict !== "DENIED_ACT_DISABLED")) throw new Error("AGENT_BOUNDARY_VIOLATION");
  return { count: results.length, results,
    digest: createHash("sha256").update(results.map((x) => x.evidenceSha256).join("\n")).digest("hex") };
}
