import { sha256 } from "../../util/sha256.js";
import {
  discoverGcpInventory,
  type GcpInventoryAsset,
  type GcpInventoryRequest,
  type GcpInventoryResponse,
  type GcpInventorySnapshot,
} from "./asset-inventory.js";

/**
 * An offline training fixture for GCP. No CLI, credentials, sockets, real IaC
 * plans, or model inference enter this function. Results cannot qualify a
 * production provider or authorize a mutation.
 */
export type GcpOfflineScenario = "brownfield" | "greenfield" | "unknown";
export type GcpOfflineShowcase = {
  schemaVersion: 1;
  provider: "GCP";
  scope: "projects/sovereign-lz-dev";
  scenario: GcpOfflineScenario;
  evidenceBasis: "SYNTHETIC_FIXTURE";
  claimedEnvironment: "BROWNFIELD_FIXTURE" | "GREENFIELD_FIXTURE" | "UNKNOWN_FIXTURE";
  discoveredClassification: "BROWNFIELD_FIXTURE" | "UNKNOWN";
  controlPlanePosture: "UNKNOWN";
  identityAttestation: "NOT_ATTESTED";
  ownership: "UNKNOWN_READ_ONLY";
  assetCount: number;
  assets: GcpInventoryAsset[];
  inventoryEvidenceSha256: string;
  workflow: Array<{
    phase: "DISCOVER" | "ASSESS" | "DESIGN" | "PREVIEW" | "ACT";
    verdict: "SYNTHETIC" | "REVIEW_REQUIRED" | "UNAVAILABLE" | "DISABLED";
    explanation: string;
  }>;
  design: {
    objective: "PLZ_AND_APPLICATION_LZ";
    iacEngine: "TERRAFORM";
    status: "REVIEW_REQUIRED";
    preview: "NOT_RUN";
    buildEligible: false;
    mutationSupported: false;
  };
  evidenceSha256: string;
};

const SCOPE = "projects/sovereign-lz-dev" as const;
const vpc = {
  name: "//compute.googleapis.com/projects/sovereign-lz-dev/global/networks/platform-vpc",
  assetType: "compute.googleapis.com/Network",
  project: SCOPE,
  displayName: "platform-vpc",
  location: "global",
};
const subnet = {
  name: "//compute.googleapis.com/projects/sovereign-lz-dev/regions/us-central1/subnetworks/compute",
  assetType: "compute.googleapis.com/Subnetwork",
  project: SCOPE,
  displayName: "compute",
  location: "us-central1",
};
const FIXTURES: Record<GcpOfflineScenario, readonly object[]> = {
  brownfield: [vpc, subnet],
  greenfield: [],
  unknown: [],
};

const MESSAGE = [
  { phase: "DISCOVER", verdict: "SYNTHETIC", explanation: "Cloud Asset Inventory response supplied by an in-memory test fixture." },
  { phase: "ASSESS", verdict: "REVIEW_REQUIRED", explanation: "Ownership, identity, security posture, and completeness are not attested." },
  { phase: "DESIGN", verdict: "REVIEW_REQUIRED", explanation: "PLZ and Application LZ design require actual scope, controls, and approved requirements." },
  { phase: "PREVIEW", verdict: "UNAVAILABLE", explanation: "No Terraform plan was executed. Preview needs an approved provider-specific build adapter." },
  { phase: "ACT", verdict: "DISABLED", explanation: "No apply, deploy, destroy, write-capable credential, or agent mutation authority." },
] as const;

/** The fake transport rejects all operations other than the exact bounded CAI read. */
function fixtureTransport(scenario: GcpOfflineScenario) {
  let reads = 0;
  return async (request: GcpInventoryRequest): Promise<GcpInventoryResponse> => {
    reads += 1;
    if (
      reads !== 1 ||
      request.method !== "GET" ||
      request.origin !== "https://cloudasset.googleapis.com" ||
      !request.path.startsWith("/v1/" + SCOPE + ":searchAllResources?") ||
      request.timeoutMs !== 8000 ||
      request.maxResponseBytes !== 2_000_000
    ) throw new Error("GCP_OFFLINE_TRANSPORT_REJECTED");
    const url = new URL(request.origin + request.path);
    if (
      url.searchParams.get("pageSize") !== "100" ||
      url.searchParams.has("pageToken")
    ) throw new Error("GCP_OFFLINE_REQUEST_REJECTED");
    return { status: 200, body: JSON.stringify({ results: FIXTURES[scenario] }) };
  };
}

export async function createGcpOfflineShowcase(
  scenario: GcpOfflineScenario,
): Promise<GcpOfflineShowcase> {
  if (!Object.prototype.hasOwnProperty.call(FIXTURES, scenario)) {
    throw new Error("GCP_OFFLINE_SCENARIO_INVALID");
  }
  const inventory: GcpInventorySnapshot = await discoverGcpInventory(
    SCOPE,
    fixtureTransport(scenario),
  );
  const claimedEnvironment: GcpOfflineShowcase["claimedEnvironment"] =
    scenario === "brownfield" ? "BROWNFIELD_FIXTURE" :
    scenario === "greenfield" ? "GREENFIELD_FIXTURE" : "UNKNOWN_FIXTURE";
  const normalized = {
    schemaVersion: 1 as const,
    provider: "GCP" as const,
    scope: SCOPE,
    scenario,
    evidenceBasis: "SYNTHETIC_FIXTURE" as const,
    claimedEnvironment,
    // Only the brownfield fixture has positive resource evidence. Absence of
    // assets in a bounded search never proves a real cloud is empty.
    discoveredClassification: scenario === "brownfield" ? "BROWNFIELD_FIXTURE" as const : "UNKNOWN" as const,
    controlPlanePosture: "UNKNOWN" as const,
    identityAttestation: "NOT_ATTESTED" as const,
    ownership: "UNKNOWN_READ_ONLY" as const,
    assetCount: inventory.inventory.length,
    assets: inventory.inventory,
    inventoryEvidenceSha256: inventory.snapshotSha256,
    workflow: MESSAGE.map((item) => ({ ...item })),
    design: {
      objective: "PLZ_AND_APPLICATION_LZ" as const,
      iacEngine: "TERRAFORM" as const,
      status: "REVIEW_REQUIRED" as const,
      preview: "NOT_RUN" as const,
      buildEligible: false as const,
      mutationSupported: false as const,
    },
  };
  return { ...normalized, evidenceSha256: sha256(JSON.stringify(normalized)) };
}
