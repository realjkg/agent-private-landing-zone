import type {
  DiscoveryAssessment,
} from "../assessment/types.js";
import {
  assessEnvironment,
} from "../assessment/posture.js";
import type {
  DesignSpec,
} from "../design/types.js";
import {
  discoverEnvironment,
} from "../discovery/discover.js";
import type {
  EnvironmentState,
} from "../discovery/types.js";
import {
  readEncryptedEvidence,
  writeEncryptedEvidence,
} from "../evidence/vault.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import {
  evaluateBuiltinSecurityPolicy,
} from "../security/policy/builtin.js";
import type {
  CompromiseState,
  SecurityPolicyEvaluator,
} from "../security/policy/types.js";
import {
  compareRecoveryDrift,
  createSimulatedRecoveryPoint,
  runSimulatedRestoreDrill,
  verifyRecoveryPoint,
} from "./operations.js";
import {
  createRecoveryPolicy,
} from "./policy.js";
import {
  validateRecoveryTarget,
  type RecoveryTargetSpec,
} from "./target.js";
import type {
  RecoveryDriftComparison,
  RecoveryPoint,
  RecoveryVerification,
  SimulatedRestoreDrill,
} from "./types.js";

export type RecoveryAutomationAction =
  | "CAPTURE"
  | "VERIFY"
  | "DRILL"
  | "DRIFT";

export type RecoveryAutomationStep = {
  action: RecoveryAutomationAction;
  status:
    | "COMPLETED"
    | "BLOCKED"
    | "SKIPPED";
  detail: string;
};

export type RecoveryAutomationStatus =
  | "HEALTHY"
  | "ATTENTION"
  | "BLOCKED"
  | "IDLE"
  | "DISABLED";

export type RecoveryAutomationState = {
  targetId: string;
  lastCaptureAt?: string;
  lastVerifyAt?: string;
  lastDrillAt?: string;
  lastDriftAt?: string;
  recoveryPoint?: RecoveryPoint;
  verification?: RecoveryVerification;
  drill?: SimulatedRestoreDrill;
  drift?: RecoveryDriftComparison;
};

export type RecoveryAutomationContext = {
  environment: EnvironmentState;
  assessment: DiscoveryAssessment;
  design: DesignSpec;
};

export type RecoveryAutomationCycleResult = {
  targetId: string;
  status: RecoveryAutomationStatus;
  startedAt: string;
  completedAt: string;
  target: RecoveryTargetSpec;
  steps: RecoveryAutomationStep[];
  blockers: string[];
  state: RecoveryAutomationState;
  evidencePath?: string;
  actEnabled: false;
};

export type RecoveryTargetContextProvider = (
  target: RecoveryTargetSpec,
) => Promise<RecoveryAutomationContext>;

export type RecoveryDesignResolver = (
  target: RecoveryTargetSpec,
) => Promise<DesignSpec>;

export type RecoveryAutomationControllerOptions = {
  targets: RecoveryTargetSpec[];
  contextProvider: RecoveryTargetContextProvider;
  grantedCapabilities:
    SovereignCapability[];
  initialStates?: RecoveryAutomationState[];
  securityPolicyEvaluator?: SecurityPolicyEvaluator;
  compromiseState?: CompromiseState;
  pollIntervalMs?: number;
  persistEvidence?: boolean;
};

function elapsedMinutes(
  previous: string | undefined,
  now: Date,
): number {
  if (!previous) {
    return Number.POSITIVE_INFINITY;
  }

  const elapsed =
    now.getTime() -
    new Date(previous).getTime();

  return Math.max(
    0,
    elapsed / 60_000,
  );
}

function due(
  previous: string | undefined,
  cadenceMinutes: number,
  now: Date,
): boolean {
  return (
    elapsedMinutes(
      previous,
      now,
    ) >= cadenceMinutes
  );
}

function missingCapabilities(
  requested: SovereignCapability[],
  granted: SovereignCapability[],
): SovereignCapability[] {
  const grantSet =
    new Set(granted);

  return requested.filter(
    (capability) =>
      !grantSet.has(capability),
  );
}

function requireCompatibleContext(
  target: RecoveryTargetSpec,
  context: RecoveryAutomationContext,
): string[] {
  const blockers: string[] = [];

  if (
    context.environment.provider !==
    target.provider
  ) {
    blockers.push(
      "Automation context provider does not match the target provider.",
    );
  }

  if (
    context.design.designHash !==
    target.source.approvedDesignHash
  ) {
    blockers.push(
      "Resolved DesignSpec hash does not match the approved target design hash.",
    );
  }

  if (
    context.design.plugin.plugin !==
    target.source.engine
  ) {
    blockers.push(
      "Resolved DesignSpec engine does not match the recovery target source engine.",
    );
  }

  return blockers;
}

function policyFromTarget(
  target: RecoveryTargetSpec,
  context: RecoveryAutomationContext,
) {
  return createRecoveryPolicy({
    environment: context.environment,
    design: context.design,
    overrides: {
      retentionDays:
        target.objectives
          .retentionDays,
      rpo:
        target.objectives
          .rpoMinutes + "m",
      rto:
        target.objectives
          .rtoMinutes + "m",
      owner: target.owner,
      immutability:
        target.protection
          .immutability,
      offlineCopy:
        target.protection
          .offlineCopy,
      requiredArtifacts:
        target.protectedArtifacts,
    },
  });
}

function statusFromState(
  state: RecoveryAutomationState,
  steps: RecoveryAutomationStep[],
  blockers: string[],
): RecoveryAutomationStatus {
  if (blockers.length > 0) {
    return "BLOCKED";
  }

  if (
    steps.length === 0
  ) {
    return "IDLE";
  }

  if (
    state.verification?.status ===
      "VERIFIED" &&
    (!state.drill ||
      state.drill.status ===
        "READY_FOR_REVIEW") &&
    (!state.drift ||
      state.drift.status ===
        "MATCHED")
  ) {
    return "HEALTHY";
  }

  return "ATTENTION";
}

export function planRecoveryAutomationActions(
  target: RecoveryTargetSpec,
  state: RecoveryAutomationState | undefined,
  now: Date = new Date(),
): RecoveryAutomationAction[] {
  const actions: RecoveryAutomationAction[] = [];

  if (
    due(
      state?.lastCaptureAt,
      target.schedule.captureEveryMinutes,
      now,
    )
  ) {
    actions.push("CAPTURE");
  }

  if (
    due(
      state?.lastVerifyAt,
      target.schedule.verifyEveryMinutes,
      now,
    )
  ) {
    actions.push("VERIFY");
  }

  if (
    due(
      state?.lastDrillAt,
      target.schedule.drillEveryMinutes,
      now,
    )
  ) {
    actions.push("DRILL");
  }

  if (
    due(
      state?.lastDriftAt,
      target.schedule.driftEveryMinutes,
      now,
    )
  ) {
    actions.push("DRIFT");
  }

  return actions;
}

function actionBlocked(
  steps: RecoveryAutomationStep[],
  action: RecoveryAutomationAction,
  detail: string,
): void {
  steps.push({
    action,
    status: "BLOCKED",
    detail,
  });
}

async function persistCycle(
  result: RecoveryAutomationCycleResult,
): Promise<string> {
  if (
    result.target
      .evidenceDestination.kind !==
    "LOCAL_ENCRYPTED_VAULT"
  ) {
    throw new Error(
      "RECOVERY_EVIDENCE_DESTINATION_UNSUPPORTED: external encrypted store adapter is not implemented.",
    );
  }

  const timestamp =
    result.completedAt
      .replace(/[:.]/g, "-");

  const namespace =
    result.target
      .evidenceDestination.kind ===
      "LOCAL_ENCRYPTED_VAULT"
      ? result.target
          .evidenceDestination
          .namespace
      : "external";

  return writeEncryptedEvidence(
    "recovery-automation",
    namespace +
      "-" +
      result.target.targetId +
      "-" +
      timestamp,
    {
      targetId:
        result.target.targetId,
      provider:
        result.target.provider,
      scope:
        result.target.scope,
      owner:
        result.target.owner,
      source:
        result.target.source,
      protectedArtifacts:
        result.target
          .protectedArtifacts,
      schedule:
        result.target.schedule,
      objectives:
        result.target.objectives,
      protection:
        result.target.protection,
      capabilityRequests:
        result.target
          .capabilityRequests,
      status: result.status,
      steps: result.steps,
      blockers: result.blockers,
      state: result.state,
      actEnabled: false,
    },
  );
}

export async function loadRecoveryAutomationState(
  targetId: string,
): Promise<
  RecoveryAutomationState | undefined
> {
  const path =
    ".runs/evidence/recovery-automation-state/" +
    targetId +
    ".evidence";

  try {
    return await readEncryptedEvidence<RecoveryAutomationState>(
      path,
    );
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error
        ? String(error.code)
        : "";

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function persistAutomationState(
  state: RecoveryAutomationState,
): Promise<void> {
  await writeEncryptedEvidence(
    "recovery-automation-state",
    state.targetId,
    state,
  );
}

export async function runRecoveryAutomationCycle(input: {
  target: RecoveryTargetSpec;
  context: RecoveryAutomationContext;
  previous?: RecoveryAutomationState;
  grantedCapabilities:
    SovereignCapability[];
  now?: Date;
  persistEvidence?: boolean;
}): Promise<RecoveryAutomationCycleResult> {
  const now =
    input.now ??
    new Date();
  const startedAt =
    now.toISOString();
  const validation =
    validateRecoveryTarget(
      input.target,
    );

  const state:
    RecoveryAutomationState = {
      targetId:
        input.target.targetId,
      ...input.previous,
    };

  const steps:
    RecoveryAutomationStep[] = [];
  const blockers = [
    ...validation.blockers,
  ];

  if (!input.target.enabled) {
    return {
      targetId:
        input.target.targetId,
      status: "DISABLED",
      startedAt,
      completedAt:
        now.toISOString(),
      target: input.target,
      steps,
      blockers: [],
      state,
      actEnabled: false,
    };
  }

  const missing =
    missingCapabilities(
      input.target
        .capabilityRequests,
      input.grantedCapabilities,
    );

  if (missing.length > 0) {
    blockers.push(
      "Missing externally granted capabilities: " +
        missing.join(", ") +
        ".",
    );
  }

  blockers.push(
    ...requireCompatibleContext(
      input.target,
      input.context,
    ),
  );

  if (
    input.target
      .evidenceDestination.kind ===
    "EXTERNAL_ENCRYPTED_STORE"
  ) {
    blockers.push(
      "External encrypted evidence destination requires an installed storage adapter.",
    );
  }

  if (blockers.length > 0) {
    const result:
      RecoveryAutomationCycleResult = {
        targetId:
          input.target.targetId,
        status: "BLOCKED",
        startedAt,
        completedAt:
          now.toISOString(),
        target: input.target,
        steps,
        blockers: [
          ...new Set(blockers),
        ],
        state,
        actEnabled: false,
      };

    if (
      input.persistEvidence !==
      false &&
      input.target
        .evidenceDestination.kind ===
        "LOCAL_ENCRYPTED_VAULT"
    ) {
      result.evidencePath =
        await persistCycle(result);
      await persistAutomationState(
        result.state,
      );
    }

    return result;
  }

  const policy =
    policyFromTarget(
      input.target,
      input.context,
    );

  const dueActions =
    new Set(
      planRecoveryAutomationActions(
        input.target,
        state,
        now,
      ),
    );

  if (
    dueActions.has("CAPTURE")
  ) {
    const recoveryPoint =
      createSimulatedRecoveryPoint({
        environment:
          input.context.environment,
        assessment:
          input.context.assessment,
        design:
          input.context.design,
        policy,
        capturedAt:
          now.toISOString(),
      });

    state.recoveryPoint =
      recoveryPoint;
    state.verification =
      undefined;
    state.drill = undefined;
    state.drift = undefined;
    state.lastCaptureAt =
      now.toISOString();

    steps.push({
      action: "CAPTURE",
      status: "COMPLETED",
      detail:
        "Prepared simulated recovery point " +
        recoveryPoint.recoveryPointId +
        " with coverage " +
        recoveryPoint.coverage +
        ".",
    });
  }

  if (
    dueActions.has("VERIFY")
  ) {
    if (!state.recoveryPoint) {
      actionBlocked(
        steps,
        "VERIFY",
        "No recovery point is available to verify.",
      );
    } else {
      state.verification =
        verifyRecoveryPoint({
          point:
            state.recoveryPoint,
          policy,
        });
      state.lastVerifyAt =
        now.toISOString();

      steps.push({
        action: "VERIFY",
        status:
          state.verification
            .status ===
          "BLOCKED"
            ? "BLOCKED"
            : "COMPLETED",
        detail:
          "Recovery verification status: " +
          state.verification.status +
          ".",
      });

      blockers.push(
        ...state.verification
          .blockers,
      );
    }
  }

  if (
    dueActions.has("DRILL")
  ) {
    if (
      !state.recoveryPoint ||
      !state.verification
    ) {
      actionBlocked(
        steps,
        "DRILL",
        "A recovery point and verification result are required before the simulated restore drill.",
      );
    } else {
      state.drill =
        runSimulatedRestoreDrill({
          point:
            state.recoveryPoint,
          verification:
            state.verification,
          design:
            input.context.design,
        });
      state.lastDrillAt =
        now.toISOString();

      steps.push({
        action: "DRILL",
        status:
          state.drill.status ===
          "BLOCKED"
            ? "BLOCKED"
            : "COMPLETED",
        detail:
          "Simulated restore drill status: " +
          state.drill.status +
          "; mutation attempted: NO.",
      });

      blockers.push(
        ...state.drill.blockers,
      );
    }
  }

  if (
    dueActions.has("DRIFT")
  ) {
    if (!state.recoveryPoint) {
      actionBlocked(
        steps,
        "DRIFT",
        "A recovery point is required for drift comparison.",
      );
    } else {
      state.drift =
        compareRecoveryDrift({
          currentEnvironment:
            input.context
              .environment,
          currentAssessment:
            input.context
              .assessment,
          point:
            state.recoveryPoint,
          design:
            input.context.design,
        });
      state.lastDriftAt =
        now.toISOString();

      steps.push({
        action: "DRIFT",
        status: "COMPLETED",
        detail:
          "Recovery drift status: " +
          state.drift.status +
          "; no remediation attempted.",
      });

      blockers.push(
        ...state.drift
          .recoverabilityRisks,
      );
    }
  }

  const uniqueBlockers = [
    ...new Set(blockers),
  ];

  const result:
    RecoveryAutomationCycleResult = {
      targetId:
        input.target.targetId,
      status:
        statusFromState(
          state,
          steps,
          uniqueBlockers,
        ),
      startedAt,
      completedAt:
        now.toISOString(),
      target: input.target,
      steps,
      blockers:
        uniqueBlockers,
      state,
      actEnabled: false,
    };

  if (
    input.persistEvidence !== false
  ) {
    result.evidencePath =
      await persistCycle(result);
    await persistAutomationState(
      result.state,
    );
  }

  return result;
}

export function createDiscoveryRecoveryContextProvider(
  resolveDesign: RecoveryDesignResolver,
): RecoveryTargetContextProvider {
  return async (
    target: RecoveryTargetSpec,
  ): Promise<RecoveryAutomationContext> => {
    const environment =
      await discoverEnvironment({
        provider: target.provider,
        mock:
          target.environment
            .mode === "FIXTURE"
            ? target.environment
                .fixture
            : undefined,
      });

    const assessment =
      assessEnvironment(environment);
    const design =
      await resolveDesign(target);

    return {
      environment,
      assessment,
      design,
    };
  };
}

export class RecoveryAutomationController {
  private readonly states =
    new Map<
      string,
      RecoveryAutomationState
    >();

  private timer:
    ReturnType<typeof setInterval> |
    undefined;

  private running = false;

  constructor(
    private readonly options:
      RecoveryAutomationControllerOptions,
  ) {
    for (const state of
      options.initialStates ?? []) {
      this.states.set(
        state.targetId,
        state,
      );
    }
  }

  getState(
    targetId: string,
  ): RecoveryAutomationState | undefined {
    return this.states.get(
      targetId,
    );
  }

  async tick(
    now: Date = new Date(),
  ): Promise<
    RecoveryAutomationCycleResult[]
  > {
    if (this.running) {
      return [];
    }

    this.running = true;

    try {
      const results:
        RecoveryAutomationCycleResult[] =
        [];

      for (const target of
        this.options.targets) {
        if (!target.enabled) {
          results.push({
            targetId:
              target.targetId,
            status: "DISABLED",
            startedAt:
              now.toISOString(),
            completedAt:
              now.toISOString(),
            target,
            steps: [],
            blockers: [],
            state: {
              targetId:
                target.targetId,
              ...this.states.get(
                target.targetId,
              ),
            },
            actEnabled: false,
          });
          continue;
        }

        const validation =
          validateRecoveryTarget(
            target,
          );

        if (
          !validation.valid
        ) {
          const blocked:
            RecoveryAutomationCycleResult = {
              targetId:
                target.targetId,
              status: "BLOCKED",
              startedAt:
                now.toISOString(),
              completedAt:
                now.toISOString(),
              target,
              steps: [],
              blockers:
                validation.blockers,
              state: {
                targetId:
                  target.targetId,
                ...this.states.get(
                  target.targetId,
                ),
              },
              actEnabled: false,
            };

          results.push(blocked);
          continue;
        }

        const previous =
          this.states.get(
            target.targetId,
          );
        const dueActions =
          planRecoveryAutomationActions(
            target,
            previous,
            now,
          );

        if (
          dueActions.length === 0
        ) {
          results.push({
            targetId:
              target.targetId,
            status: "IDLE",
            startedAt:
              now.toISOString(),
            completedAt:
              now.toISOString(),
            target,
            steps: [],
            blockers: [],
            state: {
              targetId:
                target.targetId,
              ...previous,
            },
            actEnabled: false,
          });
          continue;
        }

        const operationFor = (
          action: RecoveryAutomationAction,
        ):
          | "RECOVERY_CAPTURE"
          | "RECOVERY_VERIFY"
          | "RECOVERY_DRILL"
          | "RECOVERY_DRIFT" => {
          switch (action) {
            case "CAPTURE":
              return "RECOVERY_CAPTURE";
            case "VERIFY":
              return "RECOVERY_VERIFY";
            case "DRILL":
              return "RECOVERY_DRILL";
            case "DRIFT":
              return "RECOVERY_DRIFT";
          }
        };

        const compromiseState =
          this.options
            .compromiseState ??
          "NORMAL";

        const securityDenials:
          string[] = [];

        for (const action of
          dueActions) {
          const input = {
            kind: "AUTOMATION" as const,
            compromiseState,
            operation:
              operationFor(action),
          };

          const securityDecision =
            this.options
              .securityPolicyEvaluator
              ? await this.options
                  .securityPolicyEvaluator
                  .evaluate(input)
              : evaluateBuiltinSecurityPolicy(
                  input,
                );

          if (!securityDecision.allow) {
            securityDenials.push(
              ...securityDecision.reasons,
            );
          }
        }

        if (
          securityDenials.length > 0
        ) {
          results.push({
            targetId:
              target.targetId,
            status: "BLOCKED",
            startedAt:
              now.toISOString(),
            completedAt:
              now.toISOString(),
            target,
            steps:
              dueActions.map(
                (action) => ({
                  action,
                  status:
                    "BLOCKED" as const,
                  detail:
                    "Security policy suspended scheduled recovery work.",
                }),
              ),
            blockers: [
              ...new Set(
                securityDenials,
              ),
            ],
            state: {
              targetId:
                target.targetId,
              ...previous,
            },
            actEnabled: false,
          });
          continue;
        }

        try {
          const context =
            await this.options
              .contextProvider(target);

          const result =
            await runRecoveryAutomationCycle({
              target,
              context,
              previous,
              grantedCapabilities:
                this.options
                  .grantedCapabilities,
              now,
              persistEvidence:
                this.options
                  .persistEvidence,
            });

          this.states.set(
            target.targetId,
            result.state,
          );

          results.push(result);
        } catch (error) {
          results.push({
            targetId:
              target.targetId,
            status: "BLOCKED",
            startedAt:
              now.toISOString(),
            completedAt:
              now.toISOString(),
            target,
            steps: [],
            blockers: [
              "Recovery automation context collection failed: " +
                (error instanceof Error
                  ? error.message
                  : "unknown error"),
            ],
            state: {
              targetId:
                target.targetId,
              ...previous,
            },
            actEnabled: false,
          });
        }
      }

      return results;
    } finally {
      this.running = false;
    }
  }

  start(): {
    stop: () => void;
  } {
    if (this.timer) {
      throw new Error(
        "RECOVERY_AUTOMATION_ALREADY_RUNNING",
      );
    }

    const pollIntervalMs =
      this.options
        .pollIntervalMs ??
      60_000;

    if (
      !Number.isFinite(
        pollIntervalMs,
      ) ||
      pollIntervalMs < 60_000
    ) {
      throw new Error(
        "RECOVERY_AUTOMATION_INTERVAL_INVALID: minimum polling interval is 60000ms.",
      );
    }

    void this.tick();

    this.timer =
      setInterval(() => {
        void this.tick();
      }, pollIntervalMs);

    return {
      stop: () => {
        if (this.timer) {
          clearInterval(
            this.timer,
          );
          this.timer =
            undefined;
        }
      },
    };
  }
}
