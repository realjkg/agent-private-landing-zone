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

export function assertProductionDeploymentContract(
  contract: ProductionDeploymentContract =
    PRODUCTION_DEPLOYMENT_CONTRACT,
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
}
