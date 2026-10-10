export const PRODUCTION_QUALIFICATION_PHASES = [
  "PLAN",
  "DO",
  "CONVERGE",
  "VERIFY",
  "RELEASE",
] as const;

export type ProductionQualificationPhase =
  typeof PRODUCTION_QUALIFICATION_PHASES[number];

export function productionQualificationTransitionAllowed(
  current: ProductionQualificationPhase,
  next: ProductionQualificationPhase,
): boolean {
  if (current === "PLAN") {
    return next === "DO";
  }

  if (current === "DO") {
    return next === "DO" || next === "CONVERGE";
  }

  if (current === "CONVERGE") {
    return next === "DO" || next === "VERIFY";
  }

  if (current === "VERIFY") {
    return (
      next === "DO" ||
      next === "CONVERGE" ||
      next === "RELEASE"
    );
  }

  return false;
}

export const PRODUCTION_DEPLOYMENT_CONTRACT = {
  apiVersion:
    "alz.io/production-qualification/v1",
  kind:
    "ProductionDeploymentContract",
  metadata: {
    id:
      "ALZ-PRODUCTION-PREVIEW-OPERATE",
    version: "1.0.0",
    phase:
      "PRODUCTION_QUALIFICATION",
  },
  spec: {
    operatingMode:
      "PREVIEW_OPERATE",
    infrastructureMutation:
      "DISABLED",
    supportedHosts: {
      classes: [
        "LINUX_AMD64",
        "LINUX_ARM64",
        "PRIVATE_CLOUD_VM",
        "SOVEREIGN_EDGE",
      ],
      requiredCapabilities: [
        "encrypted-local-storage",
        "process-isolation",
        "outbound-allowlisting",
        "local-model-runtime",
      ],
    },
    identity: {
      longLivedCloudCredentials:
        "PROHIBITED",
      aws: {
        modes: [
          "WORKLOAD_IDENTITY",
          "FEDERATED_IDENTITY",
          "ASSUME_ROLE",
        ],
      },
      azure: {
        modes: [
          "MANAGED_IDENTITY",
          "WORKLOAD_IDENTITY",
          "FEDERATED_IDENTITY",
        ],
      },
      secretMaterial: {
        modelVisibility:
          "PROHIBITED",
        opaqueReferencesRequired:
          true,
      },
    },
    securityPolicy: {
      defaultEvaluator:
        "BUILTIN",
      optionalEvaluator:
        "LOCAL_OPA",
      remoteOpaEndpointAllowed:
        false,
      failClosedWhenOpaEnabled:
        true,
      builtinOpaParityRequired:
        true,
      pinnedOpaVersionRequiredForQualification:
        true,
    },
    evidence: {
      encrypted: true,
      location:
        "CUSTOMER_CONTROLLED",
      hashLinked: true,
      retentionFromRecoveryPolicy:
        true,
      centralControlCanDecryptCustomerRecoveryData:
        false,
    },
    providers: {
      aws: {
        realEnvironmentQualification:
          "required",
        operatingModes: [
          "READ_ONLY_DISCOVERY",
          "GOVERNED_PREVIEW",
        ],
      },
      azure: {
        realEnvironmentQualification:
          "required",
        operatingModes: [
          "READ_ONLY_DISCOVERY",
          "GOVERNED_PREVIEW",
        ],
      },
      private: {
        operatingModes: [
          "LOCAL_DISCOVERY",
          "GOVERNED_PREVIEW",
        ],
      },
    },
    models: {
      runtime: "LOCAL",
      qualificationOnTargetHardware:
        "required",
      requirements: [
        "structured-output",
        "restart-recovery",
        "memory-pressure-handling",
        "long-running-graph-execution",
        "validator-independence",
        "no-cloud-inference-dependency",
      ],
    },
    recovery: {
      infrastructureRecovery:
        "required",
      controlPlaneRecovery:
        "required",
      isolatedRestoreVerification:
        "required",
      objectivesFromTargetProfile:
        true,
    },
    packaging: {
      versionedArtifact:
        "required",
      cleanInstall: "required",
      upgrade: "required",
      rollback: "required",
      uninstall: "required",
      configurationMigration:
        "required",
      sbom: "required",
      provenance: "required",
      integrityVerification:
        "required",
    },
    observability: {
      structuredLogs: "required",
      healthEndpoint: "required",
      readinessEndpoint:
        "required",
      signals: [
        "model-latency",
        "model-restarts",
        "adapter-failures",
        "policy-denials",
        "provider-discovery-health",
        "recovery-state",
        "recovery-objective-status",
        "evidence-lifecycle",
      ],
      secretRedaction:
        "required",
    },
    release: {
      qualificationRequired:
        true,
      actEnabled: false,
      genericCloudWriteCredentials:
        "prohibited",
      genericIacApply:
        "prohibited",
    },
  },
} as const;

export type ProductionDeploymentContract =
  typeof PRODUCTION_DEPLOYMENT_CONTRACT;

/**
 * Runtime evidence for the contract's observability block. Each claim
 * describes observed process behavior — a wired bus, an active sink, serving
 * endpoints — not configuration presence. The endpoint fields are optional
 * because a one-shot process does not serve them: `undefined` means "not
 * evaluated for this process type" and is never treated as failing.
 */
export type ObservabilityRuntimeEvidence = {
  busWired: boolean;
  structuredLogsActive: boolean;
  secretRedactionActive: boolean;
  signals: readonly string[];
  healthEndpointServing?: boolean;
  readinessEndpointServing?: boolean;
  metricsEndpointServing?: boolean;
};

export type ObservabilityContractVerdict = {
  satisfied: boolean;
  failures: readonly string[];
};

/**
 * Checks the contract's observability block against runtime evidence.
 * Pure so both assertProductionDeploymentContract (throwing) and
 * readinessSnapshot (check-folding) enforce the same verdict.
 */
export function evaluateObservabilityContract(
  evidence: ObservabilityRuntimeEvidence,
  contract: ProductionDeploymentContract = PRODUCTION_DEPLOYMENT_CONTRACT,
): ObservabilityContractVerdict {
  const failures: string[] = [];

  if (!evidence.busWired) {
    failures.push("event bus is not wired");
  }
  if (!evidence.structuredLogsActive) {
    failures.push("structured event sink is not active");
  }
  if (!evidence.secretRedactionActive) {
    failures.push("secret redaction is not active on emitted events");
  }
  if (evidence.healthEndpointServing === false) {
    failures.push("health endpoint is not serving");
  }
  if (evidence.readinessEndpointServing === false) {
    failures.push("readiness endpoint is not serving");
  }
  if (evidence.metricsEndpointServing === false) {
    failures.push("metrics endpoint is not serving");
  }

  const known = new Set(evidence.signals);
  const missing = contract.spec.observability.signals.filter(
    (signal) => !known.has(signal),
  );
  if (missing.length > 0) {
    failures.push(
      "required signals not covered by this runtime: " + missing.join(", "),
    );
  }

  return { satisfied: failures.length === 0, failures };
}

export function assertProductionDeploymentContract(
  contract: ProductionDeploymentContract =
    PRODUCTION_DEPLOYMENT_CONTRACT,
  observability?: ObservabilityRuntimeEvidence,
): void {
  if (
    contract.spec.infrastructureMutation !==
      "DISABLED" ||
    contract.spec.release.actEnabled !==
      false ||
    contract.spec.release.genericCloudWriteCredentials !==
      "prohibited" ||
    contract.spec.release.genericIacApply !==
      "prohibited"
  ) {
    throw new Error(
      "PRODUCTION_CONTRACT_AUTHORITY_INVALID",
    );
  }

  if (
    contract.spec.identity.longLivedCloudCredentials !==
      "PROHIBITED" ||
    contract.spec.identity.secretMaterial.modelVisibility !==
      "PROHIBITED" ||
    contract.spec.identity.secretMaterial.opaqueReferencesRequired !==
      true
  ) {
    throw new Error(
      "PRODUCTION_CONTRACT_IDENTITY_INVALID",
    );
  }

  if (
    contract.spec.securityPolicy.remoteOpaEndpointAllowed !==
      false ||
    contract.spec.securityPolicy.failClosedWhenOpaEnabled !==
      true ||
    contract.spec.securityPolicy.builtinOpaParityRequired !==
      true
  ) {
    throw new Error(
      "PRODUCTION_CONTRACT_POLICY_INVALID",
    );
  }

  if (
    contract.spec.models.runtime !==
      "LOCAL"
  ) {
    throw new Error(
      "PRODUCTION_CONTRACT_MODEL_RUNTIME_INVALID",
    );
  }

  if (observability) {
    const verdict = evaluateObservabilityContract(
      observability,
      contract,
    );

    if (!verdict.satisfied) {
      throw new Error(
        "PRODUCTION_CONTRACT_OBSERVABILITY_UNMET: " +
          verdict.failures.join("; "),
      );
    }
  }
}
