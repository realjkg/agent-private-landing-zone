import {
  createGcpOfflineShowcase,
  type GcpOfflineScenario,
} from "../providers/gcp/offline-showcase.js";

const allowed: readonly string[] = ["brownfield", "greenfield", "unknown"];
const scenario = process.argv[2] ?? "brownfield";
if (!allowed.includes(scenario)) {
  console.error("GCP_OFFLINE_SCENARIO_INVALID: use brownfield, greenfield, or unknown.");
  process.exitCode = 2;
} else {
  const result = await createGcpOfflineShowcase(scenario as GcpOfflineScenario);
  console.log();
  console.log("SOVEREIGN ALZ | GCP OFFLINE WALKTHROUGH");
  console.log("────────────────────────────────");
  console.log("Mode       SYNTHETIC FIXTURE — no GCP login, network, or models");
  console.log("Engine     Terraform (design only; no plan run)");
  console.log("Scenario   " + result.scenario);
  console.log("Scope      " + result.scope + " (invented training project)");
  console.log("Assets     " + result.assetCount + " simulated");
  console.log("Confidence " + result.discoveredClassification + " / posture UNKNOWN");
  console.log();
  for (const item of result.workflow) {
    console.log(item.phase.padEnd(10) + item.verdict.padEnd(18) + item.explanation);
  }
  console.log();
  console.log("Read-only resources:");
  for (const asset of result.assets) {
    console.log("  " + asset.resourceType + " | " + asset.name + " | " + asset.mutationPolicy);
  }
  console.log("Inventory evidence SHA-256  " + result.inventoryEvidenceSha256);
  console.log("Walkthrough SHA-256         " + result.evidenceSha256);
  console.log("LIVE QUALIFICATION         NOT PERFORMED");
  console.log("ACT                        DISABLED");
  console.log();
}
