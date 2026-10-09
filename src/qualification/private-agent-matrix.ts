import { runAgentKernel } from "../agent/graph.js";
import { fixtureThinker } from "../agent/fixture.js";
import type { AgentState } from "../agent/types.js";
import { sha256 } from "../build/provenance.js";
import { loadConfig } from "../config.js";
import { getLocalModelMetadata } from "../ollama.js";
import { PHASE_E_SCENARIOS, type PhaseEScenario } from "./phase-e.js";
import { createSessionGraph } from "../session/graph.js";

export type MatrixMode = "OFFLINE_FIXTURE" | "LIVE_PRIVATE_MODELS";
export type MatrixLaneStatus = "PASS" | "BLOCKED";
export type MatrixEvidence = {
  scenario: string;
  provider: string;
  engine: string;
  estate: string;
  execution: "DIRECT" | "CONVERSATIONAL";
  status: MatrixLaneStatus;
  assessment: "FIXTURE" | "ACTUAL_PRIVATE_MODELS" | "NOT_VERIFIED";
  buildArtifactOrigin: "FIXTURE_GENERATOR" | "NONE";
  designHash?: string;
  designContentHash?: string;
  policyHash?: string;
  artifactHash?: string;
  planHash?: string;
  modelRoles: string[];
  modelNames: string[];
  actEnabled: false;
  mutationObserved: false;
  errorCode?: string;
};
export type MatrixScenarioResult = {
  id: string;
  direct: MatrixEvidence;
  conversational: MatrixEvidence;
  converged: boolean;
};
export type MatrixReport = {
  sourceCommit: string;
  mode: MatrixMode;
  scenarioCount: number;
  models: Array<{ role: string; tag: string; digest: string }>;
  results: MatrixScenarioResult[];
  passed: boolean;
  agentAuthoredIacQualified: false;
  infrastructureAct: "DISABLED";
  note: string;
  evidenceHash: string;
};

export type MatrixRunnerDeps = {
  direct: typeof runAgentKernel;
  metadata: typeof getLocalModelMetadata;
  conversation: (
    scenario: PhaseEScenario,
    fixture: boolean,
  ) => Promise<AgentState | undefined>;
};

const defaultDeps: MatrixRunnerDeps = {
  direct: runAgentKernel,
  metadata: getLocalModelMetadata,
  conversation: async (scenario, fixture) => {
    const { graph } = createSessionGraph(":memory:");
    const result = await graph.invoke({
      request: scenario.request,
      provider: scenario.provider,
      engine: scenario.engine,
      mock: scenario.mock,
      approveBuild: false,
      fixture,
    }, { configurable: { thread_id: "matrix-" + scenario.id } });
    return result.agentState;
  },
};

function evidence(
  scenario: PhaseEScenario,
  execution: "DIRECT" | "CONVERSATIONAL",
  state: AgentState | undefined,
  mode: MatrixMode,
): MatrixEvidence {
  const base = {
    scenario: scenario.id,
    provider: scenario.provider,
    engine: scenario.engine,
    estate: scenario.mock,
    execution,
    buildArtifactOrigin: state?.build ? "FIXTURE_GENERATOR" : "NONE",
    modelRoles: state?.assessment?.modelInvocations?.map((x) => x.role) ?? [],
    modelNames: state?.assessment?.modelInvocations?.map((x) => x.model) ?? [],
    actEnabled: false as const,
    mutationObserved: false as const,
  };
  const live = mode === "LIVE_PRIVATE_MODELS";
  const roles = ["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"];
  const modelsValid = !live || roles.every((role) =>
    state?.assessment?.modelInvocations?.some((x) =>
      x.role === role && x.schemaValid));
  const safe = state?.action?.executed === false &&
    state?.observation?.mutationObserved === false &&
    state?.orchestration?.actEnabled === false;
  const complete = Boolean(
    state?.provider === scenario.provider &&
    state?.environment?.classification === scenario.mock.toUpperCase() &&
    state?.design?.plugin.plugin === scenario.engine &&
    state?.build?.executionMode === "PREVIEW_ONLY" &&
    state?.build?.candidate.artifact.contentHash &&
    state?.build?.candidate.evidence.planHash &&
    state?.assessment?.status === "OK" &&
    safe && modelsValid,
  );
  const d = state?.design;
  const designContentHash = d ? sha256(JSON.stringify({
    provider: d.provider, environment: d.environment,
    objective: d.objective, status: d.status, plugin: d.plugin,
    entries: d.entries, constraints: d.constraints, reuse: d.reuse,
    additions: d.additions, forbiddenChanges: d.forbiddenChanges,
    policyHash: d.policies.bundleHash, securityControls: d.securityControls,
    resiliencyControls: d.resiliencyControls, assumptions: d.assumptions,
    evidenceRefs: d.evidenceRefs.filter((ref) => !ref.startsWith("assessment:")).sort(),
  })) : undefined;
  return {
    ...base,
    designContentHash,
    buildArtifactOrigin: base.buildArtifactOrigin as "FIXTURE_GENERATOR" | "NONE",
    status: complete ? "PASS" : "BLOCKED",
    assessment: state?.assessment?.status === "OK"
      ? live ? "ACTUAL_PRIVATE_MODELS" : "FIXTURE"
      : "NOT_VERIFIED",
    designHash: state?.design?.designHash,
    policyHash: state?.design?.policies.bundleHash,
    artifactHash: state?.build?.candidate.artifact.contentHash,
    planHash: state?.build?.candidate.evidence.planHash,
    errorCode: complete ? undefined :
      (state?.error?.slice(0, 120) ?? "INCOMPLETE_EVIDENCE_OR_AGENT_REVIEW"),
  };
}

function matched(a: MatrixEvidence, b: MatrixEvidence): boolean {
  return a.status === "PASS" && b.status === "PASS" &&
    Boolean(a.designContentHash) && a.designContentHash === b.designContentHash &&
    a.policyHash === b.policyHash &&
    a.artifactHash === b.artifactHash &&
    a.planHash === b.planHash;
}

export async function runPrivateAgentMatrix(
  input: {
    sourceCommit: string;
    mode: MatrixMode;
    scenarios?: readonly PhaseEScenario[];
    onProgress?: (message: string) => void;
  },
  deps: MatrixRunnerDeps = defaultDeps,
): Promise<MatrixReport> {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error("MATRIX_SOURCE_COMMIT_REQUIRED");
  }
  const cfg = loadConfig();
  const models: MatrixReport["models"] = [];
  if (input.mode === "LIVE_PRIVATE_MODELS") {
    if (process.env.AGENT_SKIP_LOCAL_MODEL === "1") {
      throw new Error("LIVE_MODELS_DISABLED");
    }
    const url = new URL(cfg.ollamaBaseUrl);
    if (url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("LOOPBACK_PRIVATE_MODEL_ENDPOINT_REQUIRED");
    }
    const targets = [
      { role: "ROUTER", tag: cfg.routerModel },
      { role: "PRIMARY", tag: cfg.primaryModel },
      { role: "VALIDATOR", tag: cfg.validatorModel },
    ];
    if (!cfg.routerModel.startsWith("qwen3:") ||
        !cfg.primaryModel.startsWith("qwen3:") ||
        !cfg.validatorModel.startsWith("mistral-nemo:")) {
      throw new Error("QWEN_MISTRAL_PROFILE_REQUIRED");
    }
    for (const target of targets) {
      const meta = await deps.metadata(cfg.ollamaBaseUrl, target.tag);
      if (!/^[a-f0-9]{64}$/i.test(meta.digest)) {
        throw new Error("MODEL_DIGEST_NOT_ATTESTED:" + target.role);
      }
      models.push({ ...target, digest: meta.digest });
    }
  }

  const results: MatrixScenarioResult[] = [];
  const scenarios = input.scenarios ?? PHASE_E_SCENARIOS;
  for (const scenario of scenarios) {
    input.onProgress?.("Assessing " + scenario.id);
    let directState: AgentState | undefined;
    let conversationalState: AgentState | undefined;
    const fixture = input.mode === "OFFLINE_FIXTURE";
    try {
      directState = await deps.direct({
        request: scenario.request,
        provider: scenario.provider,
        engine: scenario.engine,
        mock: scenario.mock,
        ...(fixture ? { thinker: fixtureThinker } : {}),
        approveBuild: false,
      });
    } catch {
      directState = undefined;
    }
    try {
      conversationalState = await deps.conversation(scenario, fixture);
    } catch {
      conversationalState = undefined;
    }
    const direct = evidence(scenario, "DIRECT", directState, input.mode);
    const conversational = evidence(
      scenario, "CONVERSATIONAL", conversationalState, input.mode);
    // Live execution also has to prove model tags, not merely role strings.
    if (!fixture) {
      for (const item of [direct, conversational]) {
        if (item.status === "PASS" && (
          !item.modelNames.includes(cfg.routerModel) ||
          !item.modelNames.includes(cfg.primaryModel) ||
          !item.modelNames.includes(cfg.validatorModel)
        )) {
          item.status = "BLOCKED";
          item.errorCode = "MODEL_IDENTITY_UNVERIFIED";
        }
      }
    }
    results.push({
      id: scenario.id,
      direct,
      conversational,
      converged: matched(direct, conversational),
    });
  }
  const report = {
    sourceCommit: input.sourceCommit,
    mode: input.mode,
    scenarioCount: scenarios.length,
    models,
    results,
    passed: results.length > 0 && results.every((r) => r.converged),
    agentAuthoredIacQualified: false as const,
    infrastructureAct: "DISABLED" as const,
    note: "Model-assisted risk review with deterministic fixture-generated IaC previews. These are NOT model-authored Terraform/Bicep/Pulumi artifacts or live provider plans. Scenario 01 has a separate strict model-proposal qualification path.",
  };
  return { ...report, evidenceHash: sha256(JSON.stringify(report)) };
}
