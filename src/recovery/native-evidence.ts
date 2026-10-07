import type {
  EnvironmentState,
  Provider,
} from "../discovery/types.js";

export type ProviderRecoveryEvidence = {
  provider: Provider;
  configurationExportRefs: string[];
  encryptionEvidenceRefs: string[];
  storageEvidenceRefs: string[];
  missingEvidence: string[];
  secretFree: true;
};

const PROVIDER_KEYS:
  Record<
    Provider,
    {
      configurationExport: string[];
      encryption: string[];
      storage: string[];
    }
  > = {
    AWS: {
      configurationExport: [
        "aws.configuration_export",
        "aws.backup.configuration_export",
      ],
      encryption: [
        "aws.backup.encryption",
        "aws.recovery_encryption",
      ],
      storage: [
        "aws.backup.vault",
        "aws.backup.recovery_point",
      ],
    },
    AZURE: {
      configurationExport: [
        "azure.configuration_export",
        "azure.backup.configuration_export",
      ],
      encryption: [
        "azure.backup.encryption",
        "azure.recovery_encryption",
      ],
      storage: [
        "azure.recovery_services_vault",
        "azure.backup.recovery_point",
      ],
    },
  };

function evidenceRefsFor(
  environment: EnvironmentState,
  keys: string[],
): string[] {
  const allowed =
    new Set(keys);

  return environment.evidence
    .filter(
      (item) =>
        item.value.toLowerCase() !==
          "unknown" &&
        allowed.has(item.key),
    )
    .map(
      (item) =>
        item.source +
        ":" +
        item.key,
    )
    .sort();
}

function genericEncryptionRefs(
  environment: EnvironmentState,
): string[] {
  const keys =
    new Set([
      "recovery_encryption",
      "backup_encryption",
      "state_encryption",
      "evidence_encryption",
    ]);

  return environment.evidence
    .filter(
      (item) =>
        item.value.toLowerCase() !==
          "unknown" &&
        keys.has(item.key),
    )
    .map(
      (item) =>
        item.source +
        ":" +
        item.key,
    )
    .sort();
}

export function captureProviderRecoveryEvidence(
  environment: EnvironmentState,
): ProviderRecoveryEvidence {
  const keys =
    PROVIDER_KEYS[
      environment.provider
    ];

  const configurationExportRefs =
    evidenceRefsFor(
      environment,
      keys.configurationExport,
    );

  const encryptionEvidenceRefs = [
    ...new Set([
      ...evidenceRefsFor(
        environment,
        keys.encryption,
      ),
      ...genericEncryptionRefs(
        environment,
      ),
    ]),
  ].sort();

  const storageEvidenceRefs =
    evidenceRefsFor(
      environment,
      keys.storage,
    );

  const missingEvidence:
    string[] = [];

  if (
    configurationExportRefs
      .length === 0
  ) {
    missingEvidence.push(
      "Provider-native configuration export evidence is UNKNOWN.",
    );
  }

  if (
    storageEvidenceRefs.length === 0
  ) {
    missingEvidence.push(
      "Provider-native recovery storage evidence is UNKNOWN.",
    );
  }

  if (
    encryptionEvidenceRefs
      .length === 0
  ) {
    missingEvidence.push(
      "Recovery encryption evidence is UNKNOWN.",
    );
  }

  return {
    provider:
      environment.provider,
    configurationExportRefs,
    encryptionEvidenceRefs,
    storageEvidenceRefs,
    missingEvidence,
    secretFree: true,
  };
}
