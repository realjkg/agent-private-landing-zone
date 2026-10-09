import { performance } from "node:perf_hooks";

import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import type { AgentState } from "../agent/types.js";
import { sha256 } from "../build/provenance.js";
import type { IaCEngine } from "../build/types.js";
import type { Provider, MockScenario } from "../discovery/types.js";
import { createSessionGraph } from "../session/graph.js";
import { CHAOS_FAULTS, runChaosPillarQualification } from "./chaos-pillars.js";
import { catalogOfflineCases, type OfflineCase } from "./coverage-catalog.js";
import { PHASE_E_SCENARIOS, type PhaseEScenario } from "./phase-e.js";
import { runPrivateAgentMatrix } from "./private-agent-matrix.js";

export type OfflineGateRow = {
  id: string;
  caseId: string;
  gate: string;
  expected: "PASS" | "BLOCKED" | "CONTAINED" | "NOT_APPLICABLE" |
    "ASSESSED" | "NOT_RUN" | "PLAN_REQUIRED";
  observed: "PASS" | "BLOCKED" | "CONTAINED" | "NOT_APPLICABLE" |
    "ASSESSED" | "NOT_RUN" | "PLAN_REQUIRED" | "FAILED";
  status: "VERIFIED_OFFLINE" | "FAILED" | "NOT_APPLICABLE" |
    "NOT_RUN" | "PLAN_REQUIRED";
  evidenceMode: "FIXTURE_KERNEL" | "SYNTHETIC_FAULT" | "PILLAR_POLICY" |
    "NOT_EXECUTED" | "OUTSIDE_PROVIDER_CONTRACT";
  sourceCommit: string;
  evidenceHash?: string;
  pillarPosture?: string;
  rowHash: string;
};
export type OfflineCoverageReport = {
  sourceCommit: string;
  mode: "OFFLINE_FIXTURE_ONLY";
  cases: OfflineCase[];
  executedCases: string[];
  excludedCases: string[];
  rows: OfflineGateRow[];
  count: { cases: number; previews: number; ownershipDenied: number;
    existingStackDenied: number; notApplicable: number;
    planRequired: number; offlineVerified: number; failed: number;
    liveNotRun: number; applicableFaults: number; faultNotApplicable: number };
  passed: boolean;
  elapsedMs: number;
  actualPrivateModelInference: "NOT_RUN";
  actualProviderIaCPreview: "NOT_RUN";
  actualCloudDiscovery: "NOT_RUN";
  actualPhysicalRecovery: "NOT_RUN";
  actualInfrastructureMutation: false;
  evidenceHash: string;
};

const PILLARS = [
  "COST", "SECURITY", "PERFORMANCE", "SUSTAINABILITY", "RELIABILITY",
  "RECOVERY", "OPERATIONAL_EXCELLENCE",
] as const;
const LIVE_GATES = [
  "PRIVATE_MODEL_INFERENCE", "PROVIDER_SUBSTITUTE_CLI",
  "ACTUAL_CLOUD_PLAN", "PHYSICAL_RECOVERY",
] as const;

function scenario(item: OfflineCase): PhaseEScenario {
  return PHASE_E_SCENARIOS.find((s) => s.engine === item.engine &&
    s.provider === item.provider && s.mock === item.estate) ?? {
    id: item.id,
    engine: item.engine as IaCEngine,
    provider: item.provider as Provider,
    mock: item.estate as PhaseEScenario["mock"],
    request: "Build a governed " + item.provider + " " + item.estate +
      " landing zone using " + item.engine.replaceAll("_", " ") +
      ". Preview only and preserve ownership.",
    requiredCapabilities: ["EVIDENCE_READ", "BUILD_PREVIEW"],
  };
}
function safe(state: AgentState | undefined): boolean {
  return state?.action?.executed === false &&
    state.observation?.mutationObserved === false &&
    state.orchestration?.actEnabled === false;
}
async function deniedLanes(s: PhaseEScenario): Promise<(AgentState | undefined)[]> {
  const options = {
    request: s.request, provider: s.provider, engine: s.engine,
    mock: s.mock as MockScenario, approveBuild: false,
  };
  let direct: AgentState | undefined;
  let conversation: AgentState | undefined;
  try {
    direct = await runAgentKernel({ ...options, thinker: fixtureThinker });
  } catch { /* An error is a failed denial gate, not an expected block. */ }
  try {
    const { graph } = createSessionGraph(":memory:");
    const session = await graph.invoke({ ...options, fixture: true }, {
      configurable: { thread_id: "coverage-" + s.id },
    });
    conversation = session.agentState;
  } catch { /* A missing conversation is a failed denial gate. */ }
  return [direct, conversation];
}

export async function runOfflineCoverage(input: {
  sourceCommit: string;
  onProgress?: (caseId: string) => void;
}): Promise<OfflineCoverageReport> {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit))
    throw new Error("OFFLINE_COVERAGE_REQUIRES_EXACT_SOURCE_COMMIT");
  const started = performance.now();
  const cases = catalogOfflineCases();
  const rows: OfflineGateRow[] = [];
  const executedCases: string[] = [];
  const excludedCases: string[] = [];
  let applicableFaults = 0, faultNotApplicable = 0;
  const add = (c: OfflineCase, gate: string,
    expected: OfflineGateRow["expected"],
    observed: OfflineGateRow["observed"],
    evidenceMode: OfflineGateRow["evidenceMode"],
    evidenceHash?: string,
    pillarPosture?: string,
  ) => {
    const status: OfflineGateRow["status"] =
      expected === "NOT_APPLICABLE" && observed === "NOT_APPLICABLE" &&
        (evidenceMode === "NOT_EXECUTED" ||
          (evidenceMode === "SYNTHETIC_FAULT" && Boolean(evidenceHash)))
          ? "NOT_APPLICABLE" :
      expected === "PLAN_REQUIRED" && observed === "PLAN_REQUIRED" &&
        evidenceMode === "OUTSIDE_PROVIDER_CONTRACT" ? "PLAN_REQUIRED" :
      expected === "NOT_RUN" && observed === "NOT_RUN" &&
        evidenceMode === "NOT_EXECUTED" ? "NOT_RUN" :
      expected === observed && Boolean(evidenceHash) ? "VERIFIED_OFFLINE" : "FAILED";
    const base = {
      id: [c.id, gate].join(":").toUpperCase(), caseId: c.id,
      gate, expected, observed, status, evidenceMode,
      sourceCommit: input.sourceCommit, evidenceHash, pillarPosture,
    };
    rows.push({ ...base, rowHash: sha256(JSON.stringify(base)) });
  };

  // Cataloged-but-unsupported pairs are recorded and NEVER passed to the agent.
  const positives = cases.filter((c) => c.expected === "PREVIEW");
  const previewScenarios = positives.map(scenario);
  const positiveReport = await runPrivateAgentMatrix({
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE",
    scenarios: previewScenarios,
    onProgress: input.onProgress,
  });
  const byId = new Map(positiveReport.results.map((r) => [r.id, r]));
  const byScenario = new Map(previewScenarios.map((s, i) => [positives[i].id, s]));

  for (const c of cases) {
    if (c.expected === "NOT_APPLICABLE" || c.expected === "PLAN_REQUIRED") {
      excludedCases.push(c.id);
      add(c, "PROVIDER_SCOPE", c.expected, c.expected,
        c.expected === "NOT_APPLICABLE" ? "NOT_EXECUTED" :
          "OUTSIDE_PROVIDER_CONTRACT");
      continue;
    }
    executedCases.push(c.id);
    input.onProgress?.("Coverage: " + c.id);
    const s = c.expected === "PREVIEW" ? byScenario.get(c.id)! : scenario(c);
    if (c.expected === "PREVIEW") {
      const r = byId.get(s.id);
      for (const [label, e] of [
        ["DIRECT", r?.direct], ["CONVERSATIONAL", r?.conversational],
      ] as const) {
        const valid = r?.converged === true && e?.status === "PASS" &&
          e.assessment === "FIXTURE" &&
          e.buildArtifactOrigin === "FIXTURE_GENERATOR" &&
          e.actEnabled === false && e.actionExecuted === false &&
          e.mutationObserved === false &&
          Boolean(e.designContentHash && e.policyHash &&
            e.artifactHash && e.planHash);
        add(c, label, "PASS", valid ? "PASS" : "FAILED",
          "FIXTURE_KERNEL", e ? sha256(JSON.stringify(e)) : undefined);
      }
      let state: AgentState | undefined;
      try {
        state = await runAgentKernel({
          request: s.request, provider: s.provider, engine: s.engine,
          mock: s.mock, thinker: fixtureThinker, approveBuild: false,
        });
      } catch { /* Record each absent fault and policy observation as FAILED. */ }
      let chaos: ReturnType<typeof runChaosPillarQualification> | undefined;
      if (state?.build && safe(state)) {
        try {
          chaos = runChaosPillarQualification({
            sourceCommit: input.sourceCommit, state,
          });
        } catch { /* Explicitly fail every missing observation below. */ }
      }
      for (const f of CHAOS_FAULTS) {
        const observed = chaos?.faults.find((x) => x.fault === f.id);
        const expectsState = ["TERRAFORM", "OPENTOFU", "PULUMI"].includes(c.engine);
        const expected = f.id === "MISSING_IAC_STATE" && !expectsState
          ? "NOT_APPLICABLE" as const : "CONTAINED" as const;
        const outcome = observed?.outcome === "UNDETECTED"
          ? "FAILED" as const : (observed?.outcome ?? "FAILED");
        if (expected === "NOT_APPLICABLE" && outcome === "NOT_APPLICABLE") {
          faultNotApplicable++;
          // This is an inspected recovery policy applicability result, not
          // an unsupported provider pair; provenance is mandatory.
          add(c, "CHAOS:" + f.id, "NOT_APPLICABLE", outcome,
            "SYNTHETIC_FAULT", observed?.evidenceHash);
        } else {
          if (expected === "CONTAINED") applicableFaults++;
          add(c, "CHAOS:" + f.id, expected, outcome,
            "SYNTHETIC_FAULT", observed?.evidenceHash);
        }
      }
      for (const pillar of PILLARS) {
        const posture = chaos?.pillarPosture[pillar];
        add(c, "PILLAR:" + pillar, "ASSESSED",
          posture === undefined ? "FAILED" : "ASSESSED",
          "PILLAR_POLICY", posture === undefined ? undefined :
            sha256(JSON.stringify({ sourceCommit: input.sourceCommit,
              pillar, posture, policy: chaos?.policyHash })),
          posture);
      }
      for (const gate of LIVE_GATES) {
        add(c, "LIVE:" + gate, "NOT_RUN", "NOT_RUN", "NOT_EXECUTED");
      }
      continue;
    }
    const denied = await deniedLanes(s);
    for (const [i, state] of denied.entries()) {
      const correctlyBlocked = state?.phase === "BLOCKED" &&
        !state.build && !state.error && safe(state) &&
        (c.expected === "DENY_UNKNOWN"
          ? state.environment?.classification === "UNKNOWN"
          : state.environment?.classification === "GREENFIELD" &&
            state.events.some((x) => x.event === "BUILD_BLOCKED"));
      const hash = state ? sha256(JSON.stringify({
        phase: state.phase, environment: state.environment?.classification,
        design: state.design?.status, plugin: state.design?.plugin,
        action: state.action, observation: state.observation,
      })) : undefined;
      add(c, i === 0 ? "DIRECT_DENIAL" : "CONVERSATIONAL_DENIAL",
        "BLOCKED", correctlyBlocked ? "BLOCKED" : "FAILED",
        "FIXTURE_KERNEL", hash);
    }
  }

  const tally = (expected: OfflineCase["expected"]) =>
    cases.filter((c) => c.expected === expected).length;
  const tallyRows = (status: OfflineGateRow["status"]) =>
    rows.filter((r) => r.status === status).length;
  const passed = cases.length === 78 && positives.length === 24 &&
    tally("DENY_UNKNOWN") === 13 && tally("DENY_GREENFIELD") === 2 &&
    tally("NOT_APPLICABLE") === 9 && tally("PLAN_REQUIRED") === 30 &&
    executedCases.length === 39 && excludedCases.length === 39 &&
    rows.length === 645 &&
    applicableFaults === 252 && faultNotApplicable === 12 &&
    tallyRows("VERIFIED_OFFLINE") === 498 &&
    tallyRows("NOT_APPLICABLE") === 21 &&
    tallyRows("NOT_RUN") === 96 && tallyRows("PLAN_REQUIRED") === 30 &&
    tallyRows("FAILED") === 0 &&
    new Set(rows.map((r) => r.id)).size === rows.length;
  const body = {
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE_ONLY" as const,
    cases, executedCases, excludedCases, rows,
    count: {
      cases: cases.length, previews: positives.length,
      ownershipDenied: tally("DENY_UNKNOWN"),
      existingStackDenied: tally("DENY_GREENFIELD"),
      notApplicable: tally("NOT_APPLICABLE"), planRequired: tally("PLAN_REQUIRED"),
      offlineVerified: tallyRows("VERIFIED_OFFLINE"),
      failed: tallyRows("FAILED"), liveNotRun: tallyRows("NOT_RUN"),
      applicableFaults, faultNotApplicable,
    },
    passed, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    actualPrivateModelInference: "NOT_RUN" as const,
    actualProviderIaCPreview: "NOT_RUN" as const,
    actualCloudDiscovery: "NOT_RUN" as const,
    actualPhysicalRecovery: "NOT_RUN" as const,
    actualInfrastructureMutation: false as const,
  };
  return { ...body, evidenceHash: sha256(JSON.stringify(body)) };
}
