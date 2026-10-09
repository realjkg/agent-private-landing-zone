import { performance } from "node:perf_hooks";

import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import { sha256 } from "../build/provenance.js";
import { PLUGIN_CATALOG } from "../plugins/catalog.js";
import { runChaosPillarQualification, type ChaosOutcome } from "./chaos-pillars.js";
import { PHASE_E_SCENARIOS, type PhaseEScenario } from "./phase-e.js";
import { runPrivateAgentMatrix, type MatrixScenarioResult } from "./private-agent-matrix.js";

export type PreliveCompatibility = {
  otherProvider: "AWS" | "AZURE";
  result: "BLOCKED" | "NOT_APPLICABLE" | "FAILED";
  reason: string;
};

export type PreliveScenarioResult = {
  id: string;
  adapter: string;
  provider: string;
  estate: string;
  baseline: "PASS" | "FAILED";
  unknownOwnership: "BLOCKED" | "FAILED";
  alternateProvider: PreliveCompatibility;
  chaosStatus: "PASS" | "FAILED";
  applicableFaults: number;
  notApplicableFaults: number;
  faultResults: Array<Pick<ChaosOutcome, "fault" | "pillar" | "outcome" | "evidenceHash">>;
  pillarPosture: Record<string, string>;
  recoveryVerification: string;
  designContentHash?: string;
  policyHash?: string;
  artifactHash?: string;
  localElapsedMs: number;
  evidenceHash: string;
};

export type PreliveCampaignReport = {
  sourceCommit: string;
  mode: "OFFLINE_DETERMINISTIC_ONLY";
  scenarioCount: number;
  alternativeProviderChecks: number;
  incompatibleProviderChecks: number;
  expectedNonApplicablePairs: number;
  totalChaosFaults: number;
  applicableChaosFaults: number;
  notApplicableChaosFaults: number;
  results: PreliveScenarioResult[];
  passed: boolean;
  overallElapsedMs: number;
  outcome: "PRELIVE_OFFLINE_COMPLETE" | "PRELIVE_BLOCKED";
  liveModelEvidence: "NOT_RUN";
  liveCloudDiscovery: "NOT_RUN";
  measuredCloudCost: "NOT_RUN";
  measuredCloudPerformance: "NOT_RUN";
  measuredCarbon: "NOT_RUN";
  physicalRestore: "NOT_RUN";
  infrastructureAct: "DISABLED";
  evidenceHash: string;
};

function outcomeConsistent(item: MatrixScenarioResult | undefined): boolean {
  return item?.converged === true &&
    item.direct.status === "PASS" &&
    item.conversational.status === "PASS" &&
    item.direct.mutationObserved === false &&
    item.conversational.mutationObserved === false &&
    item.direct.actionExecuted === false &&
    item.conversational.actionExecuted === false &&
    item.direct.actEnabled === false &&
    item.conversational.actEnabled === false;
}

function isSafelyBlocked(item: MatrixScenarioResult | undefined): boolean {
  if (!item) return false;
  return item.direct.status === "BLOCKED" &&
    item.conversational.status === "BLOCKED" &&
    [item.direct, item.conversational].every((lane) =>
      lane.mutationObserved !== true &&
      lane.actionExecuted !== true && lane.actEnabled !== true &&
      lane.buildArtifactOrigin === "NONE");
}

/**
 * Exhaustive over existing Phase E scenario/provider pairs; never infer a
 * new supported deployment workflow from a plugin's broad provider list.
 */
export async function runPreliveCampaign(input: {
  sourceCommit: string;
  onProgress?: (message: string) => void;
}): Promise<PreliveCampaignReport> {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error("PRELIVE_SOURCE_COMMIT_REQUIRED");
  }
  const start = performance.now();
  const cases = PHASE_E_SCENARIOS;
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("DUPLICATE_SCENARIO_ID");
  }
  input.onProgress?.("Evaluating eight existing direct/conversational scenarios");
  const baseline = await runPrivateAgentMatrix({
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE", scenarios: cases,
  });
  input.onProgress?.("Fault-injecting UNKNOWN environment evidence");
  const unknown = await runPrivateAgentMatrix({
    sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE",
    scenarios: cases.map((item) => ({
      ...item, mock: "unknown" as PhaseEScenario["mock"],
    })),
  });
  const compatibility = cases.map((item) => {
    const otherProvider: "AWS" | "AZURE" =
      item.provider === "AWS" ? "AZURE" : "AWS";
    const plugin = PLUGIN_CATALOG.find((entry) => entry.id === item.engine);
    if (!plugin || plugin.status !== "IMPLEMENTED") {
      throw new Error("PLUGIN_CATALOG_INCOMPLETE:" + item.engine);
    }
    const eligible = plugin.providers.includes(otherProvider);
    return { scenario: item, otherProvider, eligible };
  });
  const invalid = compatibility.filter((item) => !item.eligible);
  input.onProgress?.("Checking incompatible provider/engine combinations");
  const incompatibility = invalid.length
    ? await runPrivateAgentMatrix({
      sourceCommit: input.sourceCommit, mode: "OFFLINE_FIXTURE",
      scenarios: invalid.map(({ scenario, otherProvider }) => ({
        ...scenario, provider: otherProvider,
      })),
    })
    : undefined;
  const baselineById = new Map(baseline.results.map((item) => [item.id, item]));
  const unknownById = new Map(unknown.results.map((item) => [item.id, item]));
  const invalidById = new Map(
    (incompatibility?.results ?? []).map((item) => [item.id, item]));

  const results: PreliveScenarioResult[] = [];
  for (const config of compatibility) {
    const item = config.scenario;
    const started = performance.now();
    input.onProgress?.("Fault injection and pillar posture: " + item.id);
    const positive = baselineById.get(item.id);
    const negative = unknownById.get(item.id);
    const incompatible = invalidById.get(item.id);
    const baselineStatus = outcomeConsistent(positive) ? "PASS" as const : "FAILED" as const;
    const unknownStatus = isSafelyBlocked(negative) ? "BLOCKED" as const : "FAILED" as const;
    const alternateProvider: PreliveCompatibility = config.eligible ? {
      otherProvider: config.otherProvider,
      result: "NOT_APPLICABLE",
      reason: "Plugin allows this provider, but this is not an approved Phase E scenario; requires PLAN before qualification",
    } : {
      otherProvider: config.otherProvider,
      result: isSafelyBlocked(incompatible) ? "BLOCKED" : "FAILED",
      reason: "Provider is disallowed by the existing plugin catalog",
    };
    let chaosStatus: "PASS" | "FAILED" = "FAILED";
    let applicableFaults = 0;
    let notApplicableFaults = 0;
    let faultResults: PreliveScenarioResult["faultResults"] = [];
    let pillarPosture: Record<string, string> = {};
    let recoveryVerification = "NOT_RUN";
    try {
      const state = await runAgentKernel({
        request: item.request, provider: item.provider, engine: item.engine,
        mock: item.mock, thinker: fixtureThinker, approveBuild: false,
      });
      const chaos = runChaosPillarQualification({
        sourceCommit: input.sourceCommit, state,
      });
      chaosStatus = chaos.passed ? "PASS" : "FAILED";
      applicableFaults = chaos.applicableFaults;
      notApplicableFaults = chaos.notApplicableFaults;
      faultResults = chaos.faults.map((fault) => ({
        fault: fault.fault, pillar: fault.pillar,
        outcome: fault.outcome, evidenceHash: fault.evidenceHash,
      }));
      pillarPosture = chaos.pillarPosture;
      recoveryVerification = chaos.recoveryVerification;
    } catch {
      // A failed scenario is still recorded as FAILED and never hidden.
      chaosStatus = "FAILED";
    }
    const localElapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const details = {
      id: item.id, adapter: item.engine, provider: item.provider,
      estate: item.mock, baseline: baselineStatus,
      unknownOwnership: unknownStatus, alternateProvider,
      chaosStatus, applicableFaults, notApplicableFaults, faultResults,
      pillarPosture, recoveryVerification,
      designContentHash: positive?.direct.designContentHash,
      policyHash: positive?.direct.policyHash,
      artifactHash: positive?.direct.artifactHash,
      localElapsedMs,
    };
    results.push({ ...details, evidenceHash: sha256(JSON.stringify(details)) });
  }

  const totalChaosFaults = results.reduce((sum, item) =>
    sum + item.faultResults.length, 0);
  const applicableChaosFaults = results.reduce((sum, item) =>
    sum + item.applicableFaults, 0);
  const notApplicableChaosFaults = results.reduce((sum, item) =>
    sum + item.notApplicableFaults, 0);
  const passed = baseline.passed &&
    results.length === cases.length &&
    results.every((item) =>
      item.baseline === "PASS" && item.unknownOwnership === "BLOCKED" &&
      item.alternateProvider.result !== "FAILED" && item.chaosStatus === "PASS" &&
      item.applicableFaults + item.notApplicableFaults === 11);
  const body = {
    sourceCommit: input.sourceCommit,
    mode: "OFFLINE_DETERMINISTIC_ONLY" as const,
    scenarioCount: results.length,
    alternativeProviderChecks: compatibility.length,
    incompatibleProviderChecks: invalid.length,
    expectedNonApplicablePairs: compatibility.length - invalid.length,
    totalChaosFaults, applicableChaosFaults, notApplicableChaosFaults,
    results,
    passed,
    overallElapsedMs: Math.round((performance.now() - start) * 100) / 100,
    outcome: passed ? "PRELIVE_OFFLINE_COMPLETE" as const : "PRELIVE_BLOCKED" as const,
    liveModelEvidence: "NOT_RUN" as const,
    liveCloudDiscovery: "NOT_RUN" as const,
    measuredCloudCost: "NOT_RUN" as const,
    measuredCloudPerformance: "NOT_RUN" as const,
    measuredCarbon: "NOT_RUN" as const,
    physicalRestore: "NOT_RUN" as const,
    infrastructureAct: "DISABLED" as const,
  };
  return { ...body, evidenceHash: sha256(JSON.stringify(body)) };
}
