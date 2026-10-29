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
      /**
       * ACT is disabled globally (actEnabled above). The one exception is the
       * internal pilot: a human-initiated apply of a sealed plan, allowed only
       * while a valid pilot contract file has enabled === true
       * (docs/act-pilot-plan.md). Nothing here enables it.
       */
      actPilot: {
        contract:
          "config/act-pilot-contract.json",
        requiresEnabledPilotContract:
          true,
        initiatedBy:
          "HUMAN_OPERATOR",
        /**
         * The only provider/engine pairs a pilot contract may name, each
         * validated on its own. Nothing is inferred and nothing is a wildcard:
         * a pair not listed here is not a pilot.
         */
        combinations: [
          {
            provider: "AZURE",
            engine: "TERRAFORM",
            mutation:
              "TERRAFORM_APPLY_OF_SEALED_PLAN",
          },
          {
            provider: "AWS",
            engine: "TERRAFORM",
            mutation:
              "TERRAFORM_APPLY_OF_SEALED_PLAN",
          },
          {
            provider: "AWS",
            engine: "CDK",
            mutation:
              "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET",
          },
          // Owner decision 6483993252 on #39 (code and review only): the two paths admitted for DEV only in code
          // (Azure Bicep, E2; GCP Terraform, #339). Each names its own engine's mutation. The contract validator keeps
          // both DEV-only (enabledEnvironments ["DEV"]). GCP / GCP_API follows below, added by its own integration step (INT-2).
          {
            provider: "AZURE",
            engine: "BICEP",
            mutation:
              "AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE",
          },
          {
            provider: "GCP",
            engine: "TERRAFORM",
            mutation:
              "TERRAFORM_APPLY_OF_SEALED_PLAN",
          },
          // Owner decision 6483993252 on #39: GCP / GCP_API (path 6) through INT-2 only, once its engine integration, release
          // gate, journey, lifecycle reporting and evidence validation are implemented and independently reviewed. DEV only
          // (the contract validator requires enabledEnvironments ["DEV"]). Its own mutation: one sealed Pub/Sub topic create,
          // never GCP Terraform's.
          {
            provider: "GCP",
            engine: "GCP_API",
            mutation:
              "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST",
          },
        ],
      },
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

/** The pilot exception is exactly this and nothing wider. */
function pilotScopePinned(
  actPilot: unknown,
): boolean {
  return (
    JSON.stringify(actPilot) ===
    JSON.stringify(
      PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actPilot,
    )
  );
}

/** The mutation the static contract names for this exact provider/engine pair, or undefined for a pair it does not list. */
export function pilotMutationOf(
  provider: unknown,
  engine: unknown,
): string | undefined {
  return PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actPilot.combinations.find(
    (c) => c.provider === provider && c.engine === engine,
  )?.mutation;
}

/** Whether the static contract lists this exact provider/engine pair. */
export function pilotCombinationListed(
  provider: unknown,
  engine: unknown,
): boolean {
  return PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actPilot.combinations.some(
    (c) => c.provider === provider && c.engine === engine,
  );
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
      "prohibited" ||
    !pilotScopePinned(
      contract.spec.release.actPilot,
    )
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
