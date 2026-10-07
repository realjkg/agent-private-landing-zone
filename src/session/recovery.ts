import type {
  AgentState,
} from "../agent/types.js";
import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import {
  compareRecoveryDrift,
  createSimulatedRecoveryPoint,
  runSimulatedRestoreDrill,
  verifyRecoveryPoint,
} from "../recovery/operations.js";
import {
  createRecoveryPolicy,
} from "../recovery/policy.js";
import type {
  RecoveryDriftComparison,
  RecoveryPoint,
  RecoveryPolicy,
  RecoveryVerification,
  SimulatedRestoreDrill,
} from "../recovery/types.js";
import type {
  SessionCommand,
} from "./types.js";

export type RecoverySessionArtifacts = {
  recoveryPolicy?: RecoveryPolicy;
  recoveryPoint?: RecoveryPoint;
  recoveryVerification?: RecoveryVerification;
  recoveryDrill?: SimulatedRestoreDrill;
  recoveryDrift?: RecoveryDriftComparison;
};

export type RecoveryCommandResult =
  RecoverySessionArtifacts & {
    response: string;
  };

function observedRecovery(
  command: SessionCommand,
  result: RecoveryCommandResult,
): RecoveryCommandResult {
  emitDebugDiagnostic({
    kind: "RECOVERY",
    component:
      "session-recovery",
    status: "OK",
    attributes: {
      command,
      hasPolicy:
        Boolean(
          result.recoveryPolicy,
        ),
      hasPoint:
        Boolean(
          result.recoveryPoint,
        ),
      hasVerification:
        Boolean(
          result
            .recoveryVerification,
        ),
      hasDrill:
        Boolean(
          result.recoveryDrill,
        ),
      hasDrift:
        Boolean(
          result.recoveryDrift,
        ),
      responseBytes:
        Buffer.byteLength(
          result.response,
        ),
    },
  });

  return result;
}

export function isRecoveryCommand(
  command: SessionCommand,
): boolean {
  return [
    "RECOVERY_STATUS",
    "RECOVERY_PREPARE",
    "RECOVERY_VERIFY",
    "RECOVERY_DRILL",
    "RECOVERY_BLOCKERS",
    "RECOVERY_DRIFT",
    "RECOVERY_NEXT",
  ].includes(command);
}

function missingAssessment(): RecoveryCommandResult {
  return {
    response: [
      "I need a discovered and assessed environment before I can evaluate recovery operations.",
      'Start with: "Inspect this environment and assess its resiliency and recovery posture."',
      "No cloud changes were made. ACT is disabled.",
    ].join("\n"),
  };
}

function currentPolicy(
  state: AgentState,
): RecoveryPolicy | undefined {
  if (
    !state.environment ||
    !state.postureAssessment
  ) {
    return undefined;
  }

  return createRecoveryPolicy({
    environment: state.environment,
    design: state.design,
  });
}

function currentPoint(
  state: AgentState,
  policy: RecoveryPolicy,
): RecoveryPoint | undefined {
  if (
    !state.environment ||
    !state.postureAssessment
  ) {
    return undefined;
  }

  return createSimulatedRecoveryPoint({
    environment: state.environment,
    assessment:
      state.postureAssessment,
    design: state.design,
    policy,
  });
}

function listLines(
  title: string,
  values: string[],
): string[] {
  if (values.length === 0) {
    return [title + ": none recorded."];
  }

  return [
    title + ":",
    ...values.map(
      (value) => "  • " + value,
    ),
  ];
}

function statusResponse(
  state: AgentState,
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  const policy =
    artifacts.recoveryPolicy ??
    currentPolicy(state);

  if (!policy) {
    return missingAssessment();
  }

  const posture =
    state.postureAssessment;

  if (!posture) {
    return missingAssessment();
  }

  const point =
    artifacts.recoveryPoint;

  const lines = [
    "Recovery posture is evidence-backed; UNKNOWN values stay UNKNOWN.",
    "Assessment recovery coverage: " +
      posture.recoverySnapshot.coverage +
      ".",
    "Configuration backup posture: " +
      posture.resiliency
        .configurationBackup +
      ".",
    "Restore evidence: " +
      posture.resiliency
        .restoreEvidence +
      ".",
    "RPO: " + policy.rpo + ".",
    "RTO: " + policy.rto + ".",
    "Recovery owner: " +
      policy.owner +
      ".",
  ];

  if (point) {
    lines.push(
      "Prepared simulated recovery point: " +
        point.coverage +
        "; verification remains " +
        (artifacts
          .recoveryVerification
          ?.status ??
          "NOT_RUN") +
        ".",
    );
  } else {
    lines.push(
      "No simulated recovery point has been prepared in this session.",
    );
  }

  if (
    posture.recoverySnapshot
      .coverage === "MANIFEST_ONLY"
  ) {
    lines.push(
      "The current recovery snapshot is an inventory manifest, not a backup.",
    );
  }

  lines.push(
    "No cloud changes were made. ACT is disabled.",
  );

  return {
    ...artifacts,
    recoveryPolicy: policy,
    response: lines.join("\n"),
  };
}

function prepareResponse(
  state: AgentState,
): RecoveryCommandResult {
  const policy =
    currentPolicy(state);

  if (
    !policy ||
    !state.environment ||
    !state.postureAssessment
  ) {
    return missingAssessment();
  }

  const point =
    createSimulatedRecoveryPoint({
      environment: state.environment,
      assessment:
        state.postureAssessment,
      design: state.design,
      policy,
    });

  const lines = [
    "Prepared a simulated platform recovery point.",
    "Coverage: " +
      point.coverage +
      ".",
    "Recovery point hash: " +
      point.recoveryPointHash +
      ".",
    "Restore status: " +
      point.restoreStatus +
      ".",
    ...listLines(
      "Blockers",
      point.blockers,
    ),
    ...listLines(
      "UNKNOWNs",
      point.unknowns,
    ),
  ];

  if (
    point.coverage ===
    "MANIFEST_ONLY"
  ) {
    lines.push(
      "This is still a manifest-backed recovery point, not proof of a recoverable backup.",
    );
  }

  lines.push(
    "Verification is a separate deterministic step.",
    "No restore or cloud mutation was attempted. ACT is disabled.",
  );

  return {
    recoveryPolicy: policy,
    recoveryPoint: point,
    recoveryVerification: undefined,
    recoveryDrill: undefined,
    recoveryDrift: undefined,
    response: lines.join("\n"),
  };
}

function verifyResponse(
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  if (
    !artifacts.recoveryPoint ||
    !artifacts.recoveryPolicy
  ) {
    return {
      ...artifacts,
      response: [
        "There is no simulated recovery point to verify yet.",
        'Ask: "Prepare a simulated recovery point."',
        "ACT remains disabled.",
      ].join("\n"),
    };
  }

  const verification =
    verifyRecoveryPoint({
      point:
        artifacts.recoveryPoint,
      policy:
        artifacts.recoveryPolicy,
    });

  return {
    ...artifacts,
    recoveryVerification:
      verification,
    response: [
      "Recovery-point verification: " +
        verification.status +
        ".",
      ...listLines(
        "Blockers",
        verification.blockers,
      ),
      ...listLines(
        "UNKNOWNs",
        verification.unknowns,
      ),
      "Verification checked evidence and hashes only; it did not restore infrastructure.",
      "ACT remains disabled.",
    ].join("\n"),
  };
}

function drillResponse(
  state: AgentState,
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  if (
    !artifacts.recoveryPoint ||
    !artifacts.recoveryVerification
  ) {
    return {
      ...artifacts,
      response: [
        "A recovery point must be prepared and verified before a simulated restore drill.",
        "No restore was attempted. ACT remains disabled.",
      ].join("\n"),
    };
  }

  if (!state.design) {
    return {
      ...artifacts,
      response: [
        "A DesignSpec is required to compare the simulated restore against approved platform intent.",
        "Create or review the design first; no restore was attempted.",
        "ACT remains disabled.",
      ].join("\n"),
    };
  }

  const drill =
    runSimulatedRestoreDrill({
      point:
        artifacts.recoveryPoint,
      verification:
        artifacts.recoveryVerification,
      design: state.design,
    });

  return {
    ...artifacts,
    recoveryDrill: drill,
    response: [
      "Simulated restore drill: " +
        drill.status +
        ".",
      "Design hash match: " +
        (drill.designHashMatches
          ? "YES"
          : "NO") +
        ".",
      "Decisions reviewed: " +
        drill.decisions.length +
        ".",
      ...listLines(
        "Blockers",
        drill.blockers,
      ),
      "Mutation attempted: NO.",
      "ACT remains disabled.",
    ].join("\n"),
  };
}

function blockersResponse(
  state: AgentState,
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  const policy =
    artifacts.recoveryPolicy ??
    currentPolicy(state);

  if (!policy) {
    return missingAssessment();
  }

  const point =
    artifacts.recoveryPoint ??
    currentPoint(
      state,
      policy,
    );

  if (!point) {
    return missingAssessment();
  }

  const verification =
    artifacts.recoveryVerification;

  const blockers = [
    ...point.blockers,
    ...(verification?.blockers ??
      []),
  ];
  const unknowns = [
    ...point.unknowns,
    ...(verification?.unknowns ??
      []),
  ];

  return {
    ...artifacts,
    recoveryPolicy: policy,
    response: [
      "Recovery readiness is constrained by deterministic evidence gaps.",
      ...listLines(
        "Blockers",
        [
          ...new Set(blockers),
        ],
      ),
      ...listLines(
        "UNKNOWNs",
        [
          ...new Set(unknowns),
        ],
      ),
      "A missing value is not treated as proof.",
      "ACT remains disabled.",
    ].join("\n"),
  };
}

function driftResponse(
  state: AgentState,
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  if (
    !artifacts.recoveryPoint
  ) {
    return {
      ...artifacts,
      response: [
        "There is no prepared recovery point to compare against current state.",
        'Ask: "Prepare a simulated recovery point."',
        "ACT remains disabled.",
      ].join("\n"),
    };
  }

  if (
    !state.environment ||
    !state.postureAssessment ||
    !state.design
  ) {
    return {
      ...artifacts,
      response: [
        "Recovery drift comparison requires current discovery, assessment, and a DesignSpec.",
        "No remediation was attempted. ACT remains disabled.",
      ].join("\n"),
    };
  }

  const drift =
    compareRecoveryDrift({
      currentEnvironment:
        state.environment,
      currentAssessment:
        state.postureAssessment,
      point:
        artifacts.recoveryPoint,
      design: state.design,
    });

  return {
    ...artifacts,
    recoveryDrift: drift,
    response: [
      "Recovery drift status: " +
        drift.status +
        ".",
      ...listLines(
        "Recoverability risks",
        drift.recoverabilityRisks,
      ),
      ...listLines(
        "Current resources not represented in the recovery point",
        drift.currentNotProtected,
      ),
      ...listLines(
        "Expected DesignSpec delta",
        drift.expectedDesignDelta,
      ),
      "No drift was remediated automatically. ACT remains disabled.",
    ].join("\n"),
  };
}

function nextResponse(
  state: AgentState,
  artifacts: RecoverySessionArtifacts,
): RecoveryCommandResult {
  if (
    !state.environment ||
    !state.postureAssessment
  ) {
    return missingAssessment();
  }

  if (!artifacts.recoveryPoint) {
    return {
      ...artifacts,
      response:
        'Next recovery step: prepare a simulated recovery point. Ask: "Prepare a simulated recovery point." ACT remains disabled.',
    };
  }

  if (
    !artifacts.recoveryVerification
  ) {
    return {
      ...artifacts,
      response:
        'Next recovery step: verify the prepared recovery point. Ask: "Verify this recovery point." ACT remains disabled.',
    };
  }

  if (
    artifacts.recoveryVerification
      .status !== "VERIFIED"
  ) {
    return {
      ...artifacts,
      response: [
        "The recovery point is not fully verified.",
        "Resolve the recorded blockers and UNKNOWN evidence before treating the platform as recoverable.",
        "ACT remains disabled.",
      ].join("\n"),
    };
  }

  if (!state.design) {
    return {
      ...artifacts,
      response:
        "Next recovery step: establish an approved DesignSpec so the restore simulation can be compared against intended platform state. ACT remains disabled.",
    };
  }

  if (!artifacts.recoveryDrill) {
    return {
      ...artifacts,
      response:
        'Next recovery step: run the simulated restore drill. Ask: "Run a simulated restore drill." ACT remains disabled.',
    };
  }

  if (
    artifacts.recoveryDrill.status ===
    "BLOCKED"
  ) {
    return {
      ...artifacts,
      response:
        "The simulated restore drill is blocked. Resolve its evidence or reconstruction blockers before release-ready status. ACT remains disabled.",
    };
  }

  return {
    ...artifacts,
    response:
      'The simulated recovery path is ready for review. Ask: "What changed since the recovery point?" to compare current state before release readiness. ACT remains disabled.',
  };
}

export function runRecoveryCommand(input: {
  command: SessionCommand;
  state?: AgentState;
  artifacts: RecoverySessionArtifacts;
}): RecoveryCommandResult {
  if (!input.state) {
    return observedRecovery(
      input.command,
      missingAssessment(),
    );
  }

  switch (input.command) {
    case "RECOVERY_STATUS":
      return observedRecovery(
        input.command,
        statusResponse(
          input.state,
          input.artifacts,
        ),
      );
    case "RECOVERY_PREPARE":
      return observedRecovery(
        input.command,
        prepareResponse(
          input.state,
        ),
      );
    case "RECOVERY_VERIFY":
      return observedRecovery(
        input.command,
        verifyResponse(
          input.artifacts,
        ),
      );
    case "RECOVERY_DRILL":
      return observedRecovery(
        input.command,
        drillResponse(
          input.state,
          input.artifacts,
        ),
      );
    case "RECOVERY_BLOCKERS":
      return observedRecovery(
        input.command,
        blockersResponse(
          input.state,
          input.artifacts,
        ),
      );
    case "RECOVERY_DRIFT":
      return observedRecovery(
        input.command,
        driftResponse(
          input.state,
          input.artifacts,
        ),
      );
    case "RECOVERY_NEXT":
      return observedRecovery(
        input.command,
        nextResponse(
          input.state,
          input.artifacts,
        ),
      );
    default:
      emitDebugDiagnostic({
        kind: "RECOVERY",
        component:
          "session-recovery",
        status: "FAILED",
        detail:
          "unsupported recovery command",
        attributes: {
          command:
            input.command,
        },
      });
      throw new Error(
        "RECOVERY_COMMAND_ERROR: unsupported recovery command.",
      );
  }
}
