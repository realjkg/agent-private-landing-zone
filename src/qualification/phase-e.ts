import {
  fixtureThinker,
} from "../agent/fixture.js";
import {
  runAgentKernel,
} from "../agent/graph.js";
import type {
  AgentState,
} from "../agent/types.js";
import type {
  IaCEngine,
} from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import {
  ORCHESTRATION_PHASE_ORDER,
} from "../orchestration/plan.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import {
  PLUGIN_CATALOG,
} from "../plugins/catalog.js";
import {
  createSessionGraph,
} from "../session/graph.js";

export type PhaseEScenario = {
  id: string;
  provider: Provider;
  mock: Exclude<
    MockScenario,
    "unknown"
  >;
  engine: IaCEngine;
  request: string;
  requiredCapabilities:
    SovereignCapability[];
};

export const PHASE_E_SCENARIOS:
  PhaseEScenario[] = [
    {
      id:
        "terraform-aws-brownfield",
      provider: "AWS",
      mock: "brownfield",
      engine: "TERRAFORM",
      request:
        "Build a governed AWS brownfield landing zone using Terraform.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
      ],
    },
    {
      id:
        "pulumi-azure-greenfield",
      provider: "AZURE",
      mock: "greenfield",
      engine: "PULUMI",
      request:
        "Build a governed Azure greenfield landing zone using Pulumi.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
        "PROJECT_CODE_EXECUTION",
      ],
    },
    {
      id:
        "opentofu-aws-brownfield",
      provider: "AWS",
      mock: "brownfield",
      engine: "OPENTOFU",
      request:
        "Build a governed AWS brownfield landing zone using OpenTofu.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
      ],
    },
    {
      id:
        "bicep-azure-brownfield",
      provider: "AZURE",
      mock: "brownfield",
      engine: "BICEP",
      request:
        "Build the approved Azure brownfield landing-zone delta using Bicep.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
      ],
    },
    {
      id:
        "cloudformation-aws-existing",
      provider: "AWS",
      mock: "brownfield",
      engine: "CLOUDFORMATION",
      request:
        "Build the existing AWS landing-zone stack update using CloudFormation.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
        "PREVIEW_WRITE",
      ],
    },
    {
      id:
        "cdk-aws-brownfield",
      provider: "AWS",
      mock: "brownfield",
      engine: "AWS_CDK",
      request:
        "Build the approved AWS brownfield landing-zone delta using AWS CDK.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "CLOUD_READ",
        "PROJECT_CODE_EXECUTION",
        "PREVIEW_WRITE",
      ],
    },
    {
      id:
        "ansible-existing-hosts",
      provider: "AWS",
      mock: "brownfield",
      engine: "ANSIBLE",
      request:
        "Build the bounded existing-host landing-zone configuration using Ansible.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "PROJECT_CODE_EXECUTION",
        "MANAGED_ACCESS",
      ],
    },
    {
      id:
        "crossplane-local-render",
      provider: "AWS",
      mock: "brownfield",
      engine: "CROSSPLANE",
      request:
        "Build the approved platform composition using Crossplane local render.",
      requiredCapabilities: [
        "EVIDENCE_READ",
        "BUILD_PREVIEW",
        "PROJECT_CODE_EXECUTION",
      ],
    },
  ];

export type PhaseELaneSummary = {
  adapter: IaCEngine;
  provider: Provider;
  environment: string;
  executionMode: string;
  designStatus: string;
  policyBundleHash: string;
  artifactHash: string;
  planHash: string;
  previewSummary: string;
  gateReasons: string[];
  assumptions: string[];
  unknownEvidence: string[];
  actionExecuted: boolean;
  mutationObserved: boolean;
  actEnabled: boolean;
  durationMs: number;
};

export type PhaseELaneResult = {
  scenario:
    PhaseEScenario;
  direct:
    PhaseELaneSummary;
  conversational:
    PhaseELaneSummary;
  materiallyConsistent: boolean;
  adapterLimitation: string;
};

export type PhaseEQualification = {
  phaseOrder:
    typeof ORCHESTRATION_PHASE_ORDER;
  doMode:
    "PARALLEL_NON_OVERLAPPING";
  lanes: PhaseELaneResult[];
  converged: boolean;
  actEnabled: false;
};

function summarize(
  state: AgentState,
): PhaseELaneSummary {
  if (
    !state.design ||
    !state.build
  ) {
    throw new Error(
      "PHASE_E_LANE_INCOMPLETE: design and preview build are required.",
    );
  }

  const unknownEvidence =
    state.environment?.evidence
      .filter(
        (item) =>
          item.value.toLowerCase() ===
          "unknown",
      )
      .map(
        (item) => item.key,
      )
      .sort() ?? [];

  return {
    adapter:
      state.design.plugin.plugin,
    provider:
      state.provider,
    environment:
      state.environment
        ?.classification ??
      "UNKNOWN",
    executionMode:
      state.build.executionMode,
    designStatus:
      state.design.status,
    policyBundleHash:
      state.design.policies
        .bundleHash,
    artifactHash:
      state.build.candidate
        .artifact.contentHash,
    planHash:
      state.build.candidate
        .evidence.planHash ??
      "MISSING",
    previewSummary:
      state.build.previewSummary,
    gateReasons: [
      ...state.build.gate.reasons,
    ].sort(),
    assumptions: [
      ...state.design.assumptions,
    ].sort(),
    unknownEvidence,
    actionExecuted:
      state.action?.executed ??
      false,
    mutationObserved:
      state.observation
        ?.mutationObserved ??
      false,
    actEnabled:
      state.orchestration
        ?.actEnabled ??
      false,
    durationMs:
      state.durationMs ?? 0,
  };
}

function materiallyConsistent(
  left: PhaseELaneSummary,
  right: PhaseELaneSummary,
): boolean {
  return (
    left.adapter ===
      right.adapter &&
    left.provider ===
      right.provider &&
    left.environment ===
      right.environment &&
    left.executionMode ===
      right.executionMode &&
    left.designStatus ===
      right.designStatus &&
    left.policyBundleHash ===
      right.policyBundleHash &&
    left.artifactHash ===
      right.artifactHash &&
    left.planHash ===
      right.planHash &&
    left.previewSummary ===
      right.previewSummary &&
    left.actionExecuted ===
      right.actionExecuted &&
    left.mutationObserved ===
      right.mutationObserved &&
    left.actEnabled ===
      right.actEnabled
  );
}

function limitationFor(
  engine: IaCEngine,
): string {
  return (
    PLUGIN_CATALOG.find(
      (plugin) =>
        plugin.id === engine,
    )?.notes ??
    "No adapter limitation recorded."
  );
}

async function runLane(
  scenario: PhaseEScenario,
): Promise<PhaseELaneResult> {
  const directState =
    await runAgentKernel({
      request:
        scenario.request,
      provider:
        scenario.provider,
      engine:
        scenario.engine,
      mock: scenario.mock,
      thinker: fixtureThinker,
      approveBuild: false,
    });

  const { graph } =
    createSessionGraph(
      ":memory:",
    );

  const conversational =
    await graph.invoke(
      {
        request:
          scenario.request,
        provider:
          scenario.provider,
        engine:
          scenario.engine,
        mock:
          scenario.mock,
        approveBuild: false,
        fixture: true,
      },
      {
        configurable: {
          thread_id:
            "phase-e-" +
            scenario.id,
        },
      },
    );

  if (
    !conversational.agentState
  ) {
    throw new Error(
      "PHASE_E_CHAT_INCOMPLETE: conversational lane did not produce agent state.",
    );
  }

  const direct =
    summarize(
      directState,
    );
  const chat =
    summarize(
      conversational.agentState,
    );

  return {
    scenario,
    direct,
    conversational: chat,
    materiallyConsistent:
      materiallyConsistent(
        direct,
        chat,
      ),
    adapterLimitation:
      limitationFor(
        scenario.engine,
      ),
  };
}

export async function runPhaseEQualification():
  Promise<PhaseEQualification> {
  const lanes =
    await Promise.all(
      PHASE_E_SCENARIOS.map(
        (scenario) =>
          runLane(
            scenario,
          ),
      ),
    );

  const converged =
    lanes.every(
      (lane) =>
        lane.materiallyConsistent &&
        lane.direct
          .executionMode ===
          "PREVIEW_ONLY" &&
        lane.conversational
          .executionMode ===
          "PREVIEW_ONLY" &&
        !lane.direct
          .actionExecuted &&
        !lane.conversational
          .actionExecuted &&
        !lane.direct
          .mutationObserved &&
        !lane.conversational
          .mutationObserved &&
        !lane.direct.actEnabled &&
        !lane.conversational
          .actEnabled,
    );

  return {
    phaseOrder:
      ORCHESTRATION_PHASE_ORDER,
    doMode:
      "PARALLEL_NON_OVERLAPPING",
    lanes,
    converged,
    actEnabled: false,
  };
}
