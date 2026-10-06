import type {
  SbomComponentObservation,
} from "../discovery/types.js";

type CycloneDxDocument = {
  bomFormat?: string;
  components?: Array<{
    name?: string;
    version?: string;
    type?: string;
    "bom-ref"?: string;
  }>;
  vulnerabilities?: Array<{
    affects?: Array<{
      ref?: string;
    }>;
  }>;
};

type SpdxDocument = {
  spdxVersion?: string;
  packages?: Array<{
    name?: string;
    versionInfo?: string;
  }>;
};

function cyclonedxComponentType(
  value?: string,
): SbomComponentObservation["componentType"] {
  switch (value) {
    case "container":
      return "CONTAINER";
    case "firmware":
      return "FIRMWARE";
    case "operating-system":
      return "OPERATING_SYSTEM";
    case "device":
      return "DEVICE";
    case "machine-learning-model":
      return "MODEL";
    case "library":
    case "application":
    case "framework":
      return "PACKAGE";
    default:
      return "OTHER";
  }
}

export function parseSbomDocument(
  raw: string,
  evidenceRef: string,
): {
  format: "CYCLONEDX" | "SPDX";
  components: SbomComponentObservation[];
} {
  const document =
    JSON.parse(raw) as
      | CycloneDxDocument
      | SpdxDocument;

  if (
    "bomFormat" in document &&
    document.bomFormat === "CycloneDX"
  ) {
    const vulnerabilityCounts =
      new Map<string, number>();

    for (
      const vulnerability of
      document.vulnerabilities ?? []
    ) {
      for (
        const affected of
        vulnerability.affects ?? []
      ) {
        if (!affected.ref) {
          continue;
        }

        vulnerabilityCounts.set(
          affected.ref,
          (vulnerabilityCounts.get(
            affected.ref,
          ) ?? 0) + 1,
        );
      }
    }

    const components =
      (document.components ?? [])
        .filter(
          (component) =>
            Boolean(component.name),
        )
        .map(
          (component): SbomComponentObservation => ({
            name:
              component.name ??
              "unnamed",
            version:
              component.version,
            componentType:
              cyclonedxComponentType(
                component.type,
              ),
            format:
              "CYCLONEDX",
            vulnerabilities:
              component["bom-ref"]
                ? vulnerabilityCounts.get(
                    component[
                      "bom-ref"
                    ],
                  ) ?? 0
                : 0,
            evidenceRefs: [
              evidenceRef,
            ],
          }),
        );

    return {
      format: "CYCLONEDX",
      components,
    };
  }

  if (
    "spdxVersion" in document &&
    typeof document.spdxVersion ===
      "string"
  ) {
    const components =
      (document.packages ?? [])
        .filter(
          (pkg) =>
            Boolean(pkg.name),
        )
        .map(
          (pkg): SbomComponentObservation => ({
            name:
              pkg.name ??
              "unnamed",
            version:
              pkg.versionInfo,
            componentType:
              "PACKAGE",
            format: "SPDX",
            vulnerabilities: 0,
            evidenceRefs: [
              evidenceRef,
            ],
          }),
        );

    return {
      format: "SPDX",
      components,
    };
  }

  throw new Error(
    "SBOM_UNSUPPORTED: expected CycloneDX or SPDX JSON.",
  );
}
