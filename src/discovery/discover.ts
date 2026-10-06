import { classifyEnvironment, deriveSafeBuildMode } from "./classify.js";
import { summarizeOwnership } from "./ownership.js";
import type {
  DiscoveryConflict,
  DiscoveryOptions,
  DiscoveryReporter,
  EnvironmentState,
} from "./types.js";
import { discoverAws } from "../providers/aws/discover.js";
import { discoverAzure } from "../providers/azure/discover.js";

export async function discoverEnvironment(
  options: DiscoveryOptions,
  report: DiscoveryReporter = () => {},
): Promise<EnvironmentState> {
  report("DISCOVERY_START", options.provider);
  report("PROVIDER_DETECTED", options.provider);

  try {
    const providerResult =
      options.provider === "AWS"
        ? await discoverAws(options.mock)
        : await discoverAzure(options.mock);

    for (const resource of providerResult.resources) {
      report("RESOURCE_DISCOVERED", resource.resourceId);
      report(
        "OWNERSHIP_CLASSIFIED",
        `${resource.resourceId} => ${resource.ownership}/${resource.mutationPolicy}`,
      );
    }

    const bundle =
      options.evidenceBundle ?? {};

    const resources = [
      ...providerResult.resources,
      ...(bundle.resources ?? []),
    ];

    const scannerObservations = [
      ...providerResult.scannerObservations,
      ...(bundle.scannerObservations ?? []),
    ];

    const sbomComponents = [
      ...providerResult.sbomComponents,
      ...(bundle.sbomComponents ?? []),
    ];

    const resiliencyObservations = [
      ...providerResult.resiliencyObservations,
      ...(bundle.resiliencyObservations ?? []),
    ];

    const { classification, controlPlane } = classifyEnvironment(
      providerResult.evidence,
    );

    report("ENVIRONMENT_CLASSIFIED", classification);

    const conflicts: DiscoveryConflict[] = [];
    const ownershipSummary = summarizeOwnership(
      resources,
    );
    const safeBuildMode = deriveSafeBuildMode(
      classification,
      conflicts,
    );

    for (const observation of scannerObservations) {
      report(
        "SCANNER_OBSERVED",
        observation.id + " => " + observation.status,
      );
    }

    for (const component of sbomComponents) {
      report(
        "SBOM_OBSERVED",
        component.name +
          (component.version ? "@" + component.version : ""),
      );
    }

    for (const observation of resiliencyObservations) {
      report(
        "RESILIENCY_OBSERVED",
        observation.key + " => " + observation.value,
      );
    }

    const state: EnvironmentState = {
      provider: options.provider,
      classification,
      controlPlane,
      resources,
      ownershipSummary,
      conflicts,
      safeBuildMode,
      discoveredAt: new Date().toISOString(),
      evidence: providerResult.evidence,
      scannerObservations,
      sbomComponents,
      sbomComplete:
        bundle.sbomComplete ??
        providerResult.sbomComplete,
      resiliencyObservations,
      warnings: providerResult.warnings,
    };

    report("DISCOVERY_COMPLETE", safeBuildMode);
    return state;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "unknown discovery failure";

    report("DISCOVERY_FAILED", message);
    throw error;
  }
}
