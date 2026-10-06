import { randomUUID } from "node:crypto";

import type {
  DiscoveredResource,
  EnvironmentState,
} from "../discovery/types.js";
import {
  createConfigurationRecoverySnapshot,
} from "./recovery.js";
import type {
  DiscoveryAssessment,
  PostureFinding,
  PostureStatus,
} from "./types.js";

function evidenceRef(
  source: string,
  key: string,
): string {
  return source + ":" + key;
}

function inventoryKind(
  resource: DiscoveredResource,
): "PHYSICAL" | "VIRTUAL" | "CLOUD" {
  const raw =
    resource.metadata?.assetKind;

  if (raw === "PHYSICAL") {
    return "PHYSICAL";
  }

  if (raw === "VIRTUAL") {
    return "VIRTUAL";
  }

  return "CLOUD";
}

function securityFindings(
  environment: EnvironmentState,
): PostureFinding[] {
  const findings: PostureFinding[] = [];

  for (const observation of
    environment.scannerObservations) {
    if (
      observation.status === "PASS"
    ) {
      continue;
    }

    findings.push({
      id: observation.id,
      domain: observation.domain,
      severity:
        observation.severity,
      title: observation.title,
      detail: observation.detail,
      resourceId:
        observation.resourceId,
      evidenceRefs: [
        evidenceRef(
          observation.source,
          observation.id,
        ),
      ],
    });
  }

  for (const component of
    environment.sbomComponents) {
    if (
      component.vulnerabilities > 0
    ) {
      findings.push({
        id:
          "sbom-vulnerability-" +
          component.name,
        domain: "SUPPLY_CHAIN",
        severity: "MEDIUM",
        title:
          "SBOM component has reported vulnerabilities",
        detail:
          component.name +
          " has " +
          component.vulnerabilities +
          " reported vulnerability reference(s); severity must be resolved from vulnerability evidence before acceptance.",
        evidenceRefs:
          component.evidenceRefs,
      });
    }
  }

  for (const resource of
    environment.resources) {
    if (
      resource.ownership === "UNKNOWN"
    ) {
      findings.push({
        id:
          "ownership-unknown-" +
          resource.resourceId,
        domain: "OWNERSHIP",
        severity: "HIGH",
        title:
          "Resource ownership is unknown",
        detail:
          "Unknown ownership prevents safe configuration or adoption.",
        resourceId:
          resource.resourceId,
        evidenceRefs: [],
      });
    }
  }

  return findings;
}

function deriveSecurityStatus(
  findings: PostureFinding[],
  scannerCoverageKnown: boolean,
): PostureStatus {
  if (
    findings.some(
      (finding) =>
        finding.severity === "CRITICAL" ||
        finding.severity === "HIGH",
    )
  ) {
    return "INSECURE";
  }

  if (findings.length > 0) {
    return "PARTIAL";
  }

  if (!scannerCoverageKnown) {
    return "UNKNOWN";
  }

  return "SECURE";
}

export function assessEnvironment(
  environment: EnvironmentState,
): DiscoveryAssessment {
  const findings =
    securityFindings(environment);

  const kinds =
    environment.resources.map(
      inventoryKind,
    );

  const sbomRefs =
    environment.sbomComponents.flatMap(
      (component) =>
        component.evidenceRefs,
    );

  const sbomFormats = [
    ...new Set(
      environment.sbomComponents
        .map(
          (component) =>
            component.format,
        )
        .filter(Boolean),
    ),
  ];

  const recoverySnapshot =
    createConfigurationRecoverySnapshot(
      environment,
    );

  const resiliencyEvidence =
    environment.resiliencyObservations;

  const configBackup =
    resiliencyEvidence.find(
      (item) =>
        item.key ===
        "configuration_backup",
    )?.value;

  const restoreEvidence =
    resiliencyEvidence.find(
      (item) =>
        item.key ===
        "restore_test",
    )?.value;

  const redundantControlPlane =
    resiliencyEvidence.find(
      (item) =>
        item.key ===
        "redundant_control_plane",
    )?.value;

  const rpoKnown =
    resiliencyEvidence.some(
      (item) =>
        item.key === "rpo" &&
        item.value !== "unknown",
    );

  const rtoKnown =
    resiliencyEvidence.some(
      (item) =>
        item.key === "rto" &&
        item.value !== "unknown",
    );

  const resiliencyStatus: PostureStatus =
    restoreEvidence === "verified" &&
    configBackup === "present" &&
    redundantControlPlane === "present" &&
    rpoKnown &&
    rtoKnown
      ? "SECURE"
      : resiliencyEvidence.length === 0
        ? "UNKNOWN"
        : "PARTIAL";

  const scannerCoverageKnown =
    environment.scannerObservations.length >
      0 &&
    environment.sbomComplete;

  const evidenceRefs = [
    ...environment.evidence.map(
      (item) =>
        evidenceRef(
          item.source,
          item.key,
        ),
    ),
    ...sbomRefs,
    ...resiliencyEvidence.map(
      (item) =>
        evidenceRef(
          item.source,
          item.key,
        ),
    ),
  ];

  return {
    assessmentId:
      "assess-" + randomUUID(),
    assessedAt:
      new Date().toISOString(),
    inventory: {
      totalAssets:
        environment.resources.length,
      physicalAssets:
        kinds.filter(
          (kind) =>
            kind === "PHYSICAL",
        ).length,
      virtualAssets:
        kinds.filter(
          (kind) =>
            kind === "VIRTUAL",
        ).length,
      cloudAssets:
        kinds.filter(
          (kind) =>
            kind === "CLOUD",
        ).length,
      customerManaged:
        environment.resources.filter(
          (resource) =>
            resource.ownership ===
            "MANAGED_BY_CUSTOMER",
        ).length,
      acceleratorManaged:
        environment.resources.filter(
          (resource) =>
            resource.ownership ===
            "MANAGED_BY_ACCELERATOR",
        ).length,
      otherIaCManaged:
        environment.resources.filter(
          (resource) =>
            resource.ownership ===
            "MANAGED_BY_OTHER_IAC",
        ).length,
      unknownOwnership:
        environment.resources.filter(
          (resource) =>
            resource.ownership ===
            "UNKNOWN",
        ).length,
    },
    securityStatus:
      deriveSecurityStatus(
        findings,
        scannerCoverageKnown,
      ),
    findings,
    sbom: {
      status:
        environment.sbomComponents.length ===
        0
          ? "UNKNOWN"
          : environment.sbomComplete
            ? "PRESENT"
            : "PARTIAL",
      formats: sbomFormats,
      componentCount:
        environment.sbomComponents.length,
      vulnerableComponents:
        environment.sbomComponents.filter(
          (component) =>
            component.vulnerabilities >
            0,
        ).length,
      evidenceRefs: sbomRefs,
    },
    resiliency: {
      status: resiliencyStatus,
      configurationBackup:
        configBackup === "present"
          ? "PRESENT"
          : configBackup === "partial"
            ? "PARTIAL"
            : configBackup === "missing"
              ? "MISSING"
              : "UNKNOWN",
      restoreEvidence:
        restoreEvidence === "verified"
          ? "VERIFIED"
          : restoreEvidence ===
              "unverified"
            ? "UNVERIFIED"
            : restoreEvidence ===
                "missing"
              ? "MISSING"
              : "UNKNOWN",
      redundantControlPlane:
        redundantControlPlane ===
        "present"
          ? "PRESENT"
          : redundantControlPlane ===
              "missing"
            ? "MISSING"
            : "UNKNOWN",
      rpoKnown,
      rtoKnown,
      evidenceRefs:
        resiliencyEvidence.map(
          (item) =>
            evidenceRef(
              item.source,
              item.key,
            ),
        ),
    },
    recoverySnapshot,
    evidenceRefs,
  };
}
