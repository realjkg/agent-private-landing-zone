import { ALZ_TAG_KEYS, deletionUnitId, provenanceTags } from "../teardown/unit.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { DeletionUnitStateRef } from "../teardown/types.js";
import type { BackendType } from "./backend-pin.js";
import type { ApplyEnvironment, ProviderId } from "./types.js";

/**
 * The deletion unit of a pilot run (docs/act-pilot-plan.md, "Cleanup of pilot-created resources", item 6).
 *
 * One pilot state container (the contract's backend and workspace for one environment) is one unit, so every apply
 * into it stamps the same `alz-unit` and the independent observation can list, by that tag, resources of this unit
 * that the state does not name. The unit id and the tags reuse the one tag scheme of the product
 * (`src/teardown/unit.ts`): there is no second scheme, and a tag stays a pointer, never ownership evidence. Ownership
 * still comes from the records (the sealed plan, the blueprint and the observation).
 *
 * The tags are not written into the operator's project by the product. The operator's own provider configuration
 * declares them (AWS: `default_tags` in the provider block; Azure: `tags` on each resource; GCP: `default_labels` in the google
 * provider block), `prepare` tells the
 * operator the exact values, `seal` verifies in the plan that every created, taggable resource carries them and
 * refuses a missing or foreign tag, and the sealed artifact binds the unit so the approvers see it.
 */
export type PilotUnit = { unitId: string; buildId: string; tags: Readonly<Record<string, string>> };

const BACKEND_KIND: Readonly<Record<ProviderId, BackendType>> = { AWS: "s3", AZURE: "azurerm", GCP: "gcs" };

/**
 * The unit of one environment's state container under one reviewed contract. Deterministic: the same inputs name the same unit.
 *
 * `engine` matters only for GCP API-native (docs/act-pilot-gcp-api-driver.md D10): with no state file, its unit is the target's
 * topic namespace, a state reference of engine `GCP_API` and backend kind `pubsub`. Every other engine (Terraform, CDK, Bicep)
 * keeps the one reference it always had (engine `TERRAFORM` and the provider's backend kind), so its unit id and its `alz-unit`
 * tag do not change whether or not the caller names the engine (test/apply-unit.test.ts pins them).
 */
export function pilotUnitOf(input: { provider: ProviderId; contractSha256: string; environment: ApplyEnvironment; target: ResolvedTarget; engine?: string }): PilotUnit {
  const buildId = "alz-pilot-" + input.environment.toLowerCase() + "-" + input.contractSha256.slice(0, 12);
  if (input.engine === "GCP_API" && input.provider !== "GCP") throw new Error("PILOT_UNIT_ENGINE_PROVIDER_MISMATCH");
  const stateRef: DeletionUnitStateRef = input.engine === "GCP_API"
    ? { engine: "GCP_API", backend: "pubsub", location: input.target.backend, workspace: input.target.workspace }
    : { engine: "TERRAFORM", backend: BACKEND_KIND[input.provider], location: input.target.backend, workspace: input.target.workspace };
  const unitId = deletionUnitId(buildId, stateRef);
  return { unitId, buildId, tags: provenanceTags({ unitId, buildId }) };
}

/** The tag keys a created resource must carry, in the order they are shown. */
export const REQUIRED_TAG_KEYS: readonly string[] = [ALZ_TAG_KEYS.managedBy, ALZ_TAG_KEYS.unit, ALZ_TAG_KEYS.build];

/** The tags as one line for a terminal or a screen: `key=value` pairs. */
export const tagLine = (tags: Readonly<Record<string, string>>): string => REQUIRED_TAG_KEYS.map((key) => key + "=" + tags[key]).join(", ");
