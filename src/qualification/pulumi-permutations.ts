import { performance } from "node:perf_hooks";

import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import { sha256 } from "../build/provenance.js";
import type { Provider } from "../discovery/types.js";
import { PLUGIN_CATALOG } from "../plugins/catalog.js";
import { runChaosPillarQualification } from "./chaos-pillars.js";
import { PHASE_E_SCENARIOS, type PhaseEScenario } from "./phase-e.js";
import { runPrivateAgentMatrix, type MatrixScenarioResult } from "./private-agent-matrix.js";
import { buildPulumiTraceMatrix, type PulumiTraceRow } from "./pulumi-traceability.js";

export const PULUMI_CLOUD_PROVIDERS = ["AWS", "AZURE"] as const;
export const PULUMI_ESTATE_MODES = ["greenfield", "brownfield", "unknown"] as const;
export const PULUMI_OUT_OF_SCOPE_PROVIDERS = ["PRIVATE", "KUBERNETES"] as const;

type Estate = (typeof PULUMI_ESTATE_MODES)[number];
type PulumiProvider = (typeof PULUMI_CLOUD_PROVIDERS)[number] |
  (typeof PULUMI_OUT_OF_SCOPE_PROVIDERS)[number];
type ScenarioDisposition = "PASS" | "BLOCKED" | "PLAN_REQUIRED" | "FAILED";

export type PulumiCase = {
  id: string;
  provider: PulumiProvider;
  estate: Estate;
  disposition: ScenarioDisposition;
  reason: string;
  direct: "PASS" | "BLOCKED" | "NOT_RUN";
  conversational: "PASS" | "BLOCKED" | "NOT_RUN";
  directDesignHash?: string;
  conversationalDesignHash?: string;
  designContentHash?: string;
  policyHash?: string;
  artifactHash?: string;
  previewHash?: string;
  buildOrigin: "FIXTURE_GENERATOR" | "NONE";
  chaos: "CONTAINED" | "FAILED" | "NOT_RUN";
  faultCount: number;
  chaosFaults: Array<{ fault: string; outcome: "CONTAINED" | "UNDETECTED" | "NOT_APPLICABLE"; evidenceHash: string }>;
  pillarPosture: Record<string, string>;
  applicableFaultCount: number;
  notApplicableFaultCount: number;
  costEvidence: "SYNTHETIC_ONLY" | "NOT_RUN";
  performanceEvidence: "SYNTHETIC_ONLY" | "NOT_RUN";
  sustainabilityEvidence: "SYNTHETIC_ONLY" | "NOT_RUN";
  operationalExcellence: "UNKNOWN" | "NOT_RUN";
  mutationObserved: false | "UNKNOWN";
  infrastructureAct: "DISABLED";
  evidenceHash: string;
};

export type PulumiPermutationReport = {
  sourceCommit: string;
  mode: "OFFLINE_FIXTURE_ONLY";
  supportedProviderEstatePairs: number;
  unknownOwnershipPairs: number;
  planRequiredProviderEstatePairs: number;
  directAndConversationalLanes: number;
  chaosFaultCases: number;
  applicableChaosFaultCases: number;
  notApplicableChaosFaultCases: number;
  cases: PulumiCase[];
  traceRows: PulumiTraceRow[];
  traceRowCount: number;
  tracePassed: number;
  traceFailed: number;
  traceUnverified: number;
  tracePlanRequired: number;
  passed: boolean;
  elapsedMs: number;
  localModelInference: "NOT_RUN";
  actualPulumiCliValidation: "NOT_RUN";
  actualPulumiPreview: "NOT_RUN";
  liveAwsAzureDiscovery: "NOT_RUN";
  realBackupRestore: "NOT_RUN";
  productionMutation: "DISABLED";
  scope: "AWS_AZURE_PROVIDER_ONLY";
  evidenceHash: string;
};

function scenarioFor(provider: Provider, estate: "greenfield" | "brownfield"): PhaseEScenario {
  return {
    id: "pulumi-" + provider.toLowerCase() + "-" + estate,
    provider,
    mock: estate,
    engine: "PULUMI",
    request: "Build a governed " + provider + " " + estate +
      " landing zone using Pulumi. Preserve customer ownership; preview only.",
    requiredCapabilities: ["EVIDENCE_READ", "BUILD_PREVIEW"],
  };
}

function safeBlocked(result: MatrixScenarioResult | undefined): boolean {
  if (!result) return false;
  return [result.direct, result.conversational].every((lane) =>
    lane.status === "BLOCKED" && lane.buildArtifactOrigin === "NONE" &&
    lane.actionExecuted === false && lane.mutationObserved === false &&
    lane.actEnabled === false);
}

function affirmative(result: MatrixScenarioResult | undefined): boolean {
  if (!result?.converged) return false;
  return [result.direct, result.conversational].every((lane) =>
    lane.status === "PASS" && lane.assessment === "FIXTURE" &&
    lane.buildArtifactOrigin === "FIXTURE_GENERATOR" &&
    lane.actionExecuted === false && lane.mutationObserved === false &&
    lane.actEnabled === false) &&
    Boolean(result.direct.designContentHash && result.direct.policyHash &&
      result.direct.artifactHash && result.direct.planHash);
}

function hashedCase(value: Omit<PulumiCase, "evidenceHash">): PulumiCase {
  return { ...value, evidenceHash: sha256(JSON.stringify(value)) };
}

export async function runPulumiPermutations(input: {
  sourceCommit: string;
  onProgress?: (message: string) => void;
}): Promise<PulumiPermutationReport> {
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) {
    throw new Error("PULUMI_SOURCE_COMMIT_REQUIRED");
  }
  const catalog = PLUGIN_CATALOG.find((item) => item.id === "PULUMI");
  if (!catalog || catalog.status !== "IMPLEMENTED" ||
    !PULUMI_CLOUD_PROVIDERS.every((provider) => catalog.providers.includes(provider)) ||
    !PULUMI_OUT_OF_SCOPE_PROVIDERS.every((provider) => catalog.providers.includes(provider))) {
    throw new Error("PULUMI_PLUGIN_SCOPE_DRIFT");
  }
  const start = performance.now();
  const validScenarios = PULUMI_CLOUD_PROVIDERS.flatMap((provider) =>
    (["greenfield", "brownfield"] as const).map((estate) =>
      scenarioFor(provider, estate)));
  // The established Azure greenfield scenario must remain the exact same contract.
  const prior = PHASE_E_SCENARIOS.find((scenario) =>
    scenario.provider === "AZURE" && scenario.engine === "PULUMI" &&
    scenario.mock === "greenfield");
  if (!prior) throw new Error("PULUMI_ESTABLISHED_BASELINE_MISSING");
  const originalIndex = validScenarios.findIndex((scenario) => scenario.id === prior.id);
  if (originalIndex < 0) throw new Error("PULUMI_BASELINE_NOT_ENUMERATED");
  validScenarios[originalIndex] = prior;
  input.onProgress?.("Running four existing-provider Pulumi fixture workflows");
  const positives = await runPrivateAgentMatrix({
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE",
    scenarios: validScenarios,
  });
  const unknowns = validScenarios.filter((scenario) => scenario.mock === "greenfield");
  // Exactly one UNKNOWN per currently supported provider, no duplicate UNKNOWN testing.
  const negative = await runPrivateAgentMatrix({
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE",
    scenarios: unknowns.map((scenario) => ({
      ...scenario, mock: "unknown" as PhaseEScenario["mock"],
    })),
  });
  const positiveMap = new Map(positives.results.map((item) => [item.id, item]));
  const negativeMap = new Map(negative.results.map((item) => [item.id, item]));
  const cases: PulumiCase[] = [];

  for (const scenario of validScenarios) {
    input.onProgress?.("Assessing Pulumi: " + scenario.id);
    const result = positiveMap.get(scenario.id);
    let chaos: PulumiCase["chaos"] = "FAILED";
    let faultCount = 0;
    let applicableFaultCount = 0;
    let notApplicableFaultCount = 0;
    let chaosFaults: PulumiCase["chaosFaults"] = [];
    let pillarPosture: Record<string, string> = {};
    try {
      const state = await runAgentKernel({
        request: scenario.request,
        provider: scenario.provider,
        engine: scenario.engine,
        mock: scenario.mock,
        thinker: fixtureThinker,
        approveBuild: false,
      });
      const faultReport = runChaosPillarQualification({
        state, sourceCommit: input.sourceCommit,
      });
      chaos = faultReport.passed ? "CONTAINED" : "FAILED";
      faultCount = faultReport.faults.length;
      applicableFaultCount = faultReport.applicableFaults;
      notApplicableFaultCount = faultReport.notApplicableFaults;
      chaosFaults = faultReport.faults.map((fault) => ({
        fault: fault.fault, outcome: fault.outcome, evidenceHash: fault.evidenceHash,
      }));
      pillarPosture = faultReport.pillarPosture;
    } catch {
      chaos = "FAILED";
    }
    const verified = affirmative(result) && chaos === "CONTAINED" &&
      faultCount === 11 &&
      applicableFaultCount + notApplicableFaultCount === faultCount &&
      notApplicableFaultCount === 0 &&
      chaosFaults.every((fault) => fault.outcome === "CONTAINED") &&
      ["COST", "SECURITY", "PERFORMANCE", "SUSTAINABILITY",
        "RELIABILITY", "RECOVERY", "OPERATIONAL_EXCELLENCE"].every(
          (pillar) => pillar in pillarPosture);
    cases.push(hashedCase({
      id: scenario.id,
      provider: scenario.provider,
      estate: scenario.mock,
      disposition: verified ? "PASS" : "FAILED",
      reason: verified
        ? "Direct and conversational fixture paths converge; recovery/Well-Architected faults contained"
        : "Functional parity, preview integrity, or applicable chaos evidence incomplete",
      direct: result?.direct.status ?? "BLOCKED",
      conversational: result?.conversational.status ?? "BLOCKED",
      directDesignHash: result?.direct.designHash,
      conversationalDesignHash: result?.conversational.designHash,
      designContentHash: result?.direct.designContentHash,
      policyHash: result?.direct.policyHash,
      artifactHash: result?.direct.artifactHash,
      previewHash: result?.direct.planHash,
      buildOrigin: result?.direct.buildArtifactOrigin ?? "NONE",
      chaos, faultCount, applicableFaultCount, notApplicableFaultCount,
      chaosFaults, pillarPosture,
      costEvidence: "SYNTHETIC_ONLY",
      performanceEvidence: "SYNTHETIC_ONLY",
      sustainabilityEvidence: "SYNTHETIC_ONLY",
      operationalExcellence: "UNKNOWN",
      mutationObserved: result?.direct.mutationObserved === false &&
        result?.conversational.mutationObserved === false ? false : "UNKNOWN",
      infrastructureAct: "DISABLED",
    }));
  }
  for (const provider of PULUMI_CLOUD_PROVIDERS) {
    const source = unknowns.find((scenario) => scenario.provider === provider);
    if (!source) throw new Error("PULUMI_UNKNOWN_SOURCE_MISSING");
    const result = negativeMap.get(source.id);
    const denied = safeBlocked(result);
    cases.push(hashedCase({
      id: "pulumi-" + provider.toLowerCase() + "-unknown",
      provider, estate: "unknown",
      disposition: denied ? "BLOCKED" : "FAILED",
      reason: denied
        ? "Unknown environment/ownership denied before Build Preview"
        : "Unknown environment did not fail closed in both lanes",
      direct: result?.direct.status ?? "BLOCKED",
      conversational: result?.conversational.status ?? "BLOCKED",
      directDesignHash: result?.direct.designHash,
      conversationalDesignHash: result?.conversational.designHash,
      policyHash: result?.direct.policyHash,
      buildOrigin: result?.direct.buildArtifactOrigin ?? "NONE",
      chaos: "NOT_RUN", faultCount: 0, applicableFaultCount: 0,
      notApplicableFaultCount: 0, chaosFaults: [], pillarPosture: {},
      costEvidence: "NOT_RUN",
      performanceEvidence: "NOT_RUN", sustainabilityEvidence: "NOT_RUN",
      operationalExcellence: "NOT_RUN",
      mutationObserved: denied ? false : "UNKNOWN",
      infrastructureAct: "DISABLED",
    }));
  }
  for (const provider of PULUMI_OUT_OF_SCOPE_PROVIDERS) {
    for (const estate of PULUMI_ESTATE_MODES) {
      cases.push(hashedCase({
        id: "pulumi-" + provider.toLowerCase() + "-" + estate,
        provider, estate,
        disposition: "PLAN_REQUIRED",
        reason: "Pulumi plugin advertises this target but ALZ kernel/discovery Provider contract is AWS|AZURE only. PLAN approval required.",
        direct: "NOT_RUN", conversational: "NOT_RUN",
        buildOrigin: "NONE", chaos: "NOT_RUN",
        faultCount: 0, applicableFaultCount: 0, notApplicableFaultCount: 0,
        chaosFaults: [], pillarPosture: {}, costEvidence: "NOT_RUN", performanceEvidence: "NOT_RUN",
        sustainabilityEvidence: "NOT_RUN", operationalExcellence: "NOT_RUN",
        mutationObserved: "UNKNOWN", infrastructureAct: "DISABLED",
      }));
    }
  }

  const supportedProviderEstatePairs = cases.filter((item) =>
    item.disposition === "PASS").length;
  const unknownOwnershipPairs = cases.filter((item) =>
    item.disposition === "BLOCKED").length;
  const planRequiredProviderEstatePairs = cases.filter((item) =>
    item.disposition === "PLAN_REQUIRED").length;
  const chaosFaultCases = cases.reduce((sum, item) => sum + item.faultCount, 0);
  const applicableChaosFaultCases =
    cases.reduce((sum, item) => sum + item.applicableFaultCount, 0);
  const notApplicableChaosFaultCases =
    cases.reduce((sum, item) => sum + item.notApplicableFaultCount, 0);
  const passed = cases.length === 12 &&
    supportedProviderEstatePairs === 4 &&
    unknownOwnershipPairs === 2 &&
    planRequiredProviderEstatePairs === 6 &&
    chaosFaultCases === 44 &&
    cases.every((item) => item.disposition !== "FAILED");
  const traceRows = buildPulumiTraceMatrix({ sourceCommit: input.sourceCommit, cases });
  const tracePassed = traceRows.filter((row) => row.status === "VERIFIED_OFFLINE").length;
  const traceFailed = traceRows.filter((row) => row.status === "FAILED").length;
  const traceUnverified = traceRows.filter((row) => row.status === "UNVERIFIED").length;
  const tracePlanRequired = traceRows.filter((row) => row.status === "PLAN_REQUIRED").length;
  const allGood = passed && traceFailed === 0 && traceUnverified === 32 &&
    tracePlanRequired === 6;
  const body = {
    sourceCommit: input.sourceCommit,
    mode: "OFFLINE_FIXTURE_ONLY" as const,
    supportedProviderEstatePairs,
    unknownOwnershipPairs,
    planRequiredProviderEstatePairs,
    directAndConversationalLanes: (supportedProviderEstatePairs +
      unknownOwnershipPairs) * 2,
    chaosFaultCases, applicableChaosFaultCases, notApplicableChaosFaultCases,
    cases, traceRows, traceRowCount: traceRows.length,
    tracePassed, traceFailed, traceUnverified, tracePlanRequired,
    passed: allGood, elapsedMs: Math.round((performance.now()-start)*100)/100,
    localModelInference: "NOT_RUN" as const,
    actualPulumiCliValidation: "NOT_RUN" as const,
    actualPulumiPreview: "NOT_RUN" as const,
    liveAwsAzureDiscovery: "NOT_RUN" as const,
    realBackupRestore: "NOT_RUN" as const,
    productionMutation: "DISABLED" as const,
    scope: "AWS_AZURE_PROVIDER_ONLY" as const,
  };
  return { ...body, evidenceHash: sha256(JSON.stringify(body)) };
}
