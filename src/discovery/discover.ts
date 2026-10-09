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
import { DISABLED_EMITTER, type Emitter } from "../observability/bus.js";

/**
 * Emits the provider-discovery-health contract signal around the real probe:
 * one OK event per successful provider discovery (with observed resource
 * count), one FAILED event per failure — rethrown unchanged.
 */
async function discoverWithHealthSignal<
  T extends { resources: unknown[] },
>(
  options: DiscoveryOptions,
  discover: () => Promise<T>,
): Promise<T> {
  const emitter: Emitter = options.emitter ?? DISABLED_EMITTER;
  const startedAt = Date.now();
  const attributes = {
    provider: options.provider,
    ...(options.mock !== undefined ? { mock: options.mock } : {}),
  };

  try {
    const result = await discover();
    emitter.emit({
      signal: "provider-discovery-health",
      status: "OK",
      component: "discovery",
      durationMs: Date.now() - startedAt,
      attributes: {
        ...attributes,
        resources: result.resources.length,
      },
    });
    return result;
  } catch (error) {
    emitter.emit({
      signal: "provider-discovery-health",
      status: "FAILED",
      component: "discovery",
      durationMs: Date.now() - startedAt,
      detail:
        error instanceof Error
          ? error.message
          : "unknown discovery failure",
      attributes,
    });
    throw error;
  }
}

export async function discoverEnvironment(
  options: DiscoveryOptions,
  report: DiscoveryReporter = () => {},
): Promise<EnvironmentState> {
  report("DISCOVERY_START", options.provider);
  report("PROVIDER_DETECTED", options.provider);

  try {
    const providerResult = await discoverWithHealthSignal(
      options,
      () =>
        options.provider === "AWS"
          ? discoverAws(options.mock)
          : discoverAzure(options.mock),
    );

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
