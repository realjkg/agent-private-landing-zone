import type {
  DesignSpec,
} from "../design/types.js";
import {
  readEncryptedEvidence,
} from "../evidence/vault.js";
import type {
  SovereignCapability,
} from "../orchestration/types.js";
import type {
  CompromiseState,
  SecurityPolicyEvaluator,
} from "../security/policy/types.js";
import {
  RecoveryAutomationController,
  createDiscoveryRecoveryContextProvider,
  loadRecoveryAutomationState,
  type RecoveryAutomationState,
  type RecoveryDesignResolver,
} from "./automation.js";
import {
  loadRecoveryTargets,
} from "./target-loader.js";

export type RecoveryAutomationServiceOptions = {
  targetFile?: string;
  grantedCapabilities:
    SovereignCapability[];
  pollIntervalMs?: number;
  persistEvidence?: boolean;
  securityPolicyEvaluator?: SecurityPolicyEvaluator;
  compromiseState?: CompromiseState;
  resolveDesign?: RecoveryDesignResolver;
};

async function resolveEncryptedDesign(
  target: Parameters<
    RecoveryDesignResolver
  >[0],
): Promise<DesignSpec> {
  const design =
    await readEncryptedEvidence<DesignSpec>(
      target.source.designRef,
    );

  if (
    design.designHash !==
    target.source.approvedDesignHash
  ) {
    throw new Error(
      "RECOVERY_TARGET_DESIGN_MISMATCH: encrypted DesignSpec does not match target approval hash.",
    );
  }

  return design;
}

export async function createRecoveryAutomationService(
  options: RecoveryAutomationServiceOptions,
): Promise<RecoveryAutomationController> {
  const targetFile =
    options.targetFile ??
    process.env
      .AGENTIC_RECOVERY_TARGETS_FILE ??
    "config/recovery-targets.json";

  const targets =
    await loadRecoveryTargets(
      targetFile,
    );

  const resolveDesign =
    options.resolveDesign ??
    resolveEncryptedDesign;

  const initialStates =
    (
      await Promise.all(
        targets.map(
          (target) =>
            loadRecoveryAutomationState(
              target.targetId,
            ),
        ),
      )
    ).filter(
      (
        state,
      ): state is RecoveryAutomationState =>
        Boolean(state),
    );

  return new RecoveryAutomationController({
    targets,
    initialStates,
    contextProvider:
      createDiscoveryRecoveryContextProvider(
        resolveDesign,
      ),
    grantedCapabilities:
      options.grantedCapabilities,
    securityPolicyEvaluator:
      options.securityPolicyEvaluator,
    compromiseState:
      options.compromiseState,
    pollIntervalMs:
      options.pollIntervalMs,
    persistEvidence:
      options.persistEvidence,
  });
}

export async function startRecoveryAutomationService(
  options: RecoveryAutomationServiceOptions,
): Promise<{
  controller: RecoveryAutomationController;
  stop: () => void;
}> {
  const controller =
    await createRecoveryAutomationService(
      options,
    );

  const running =
    controller.start();

  return {
    controller,
    stop: running.stop,
  };
}
