import assert from "node:assert/strict";
import test from "node:test";

import {
  createGcpOfflineShowcase,
  type GcpOfflineScenario,
} from "../src/providers/gcp/offline-showcase.js";

const SCENARIOS: readonly GcpOfflineScenario[] = ["brownfield", "greenfield", "unknown"];

test("GCP demo covers synthetic brownfield, greenfield and unknown without attesting posture", async () => {
  for (const scenario of SCENARIOS) {
    const value = await createGcpOfflineShowcase(scenario);
    assert.equal(value.provider, "GCP");
    assert.equal(value.scope, "projects/sovereign-lz-dev");
    assert.equal(value.evidenceBasis, "SYNTHETIC_FIXTURE");
    assert.equal(value.scenario, scenario);
    assert.equal(value.controlPlanePosture, "UNKNOWN");
    assert.equal(value.identityAttestation, "NOT_ATTESTED");
    assert.equal(value.ownership, "UNKNOWN_READ_ONLY");
    assert.deepEqual(value.workflow.map(x => x.phase), ["DISCOVER", "ASSESS", "DESIGN", "PREVIEW", "ACT"]);
    assert.deepEqual(value.workflow.map(x => x.verdict), ["SYNTHETIC", "REVIEW_REQUIRED", "REVIEW_REQUIRED", "UNAVAILABLE", "DISABLED"]);
    assert.equal(value.design.status, "REVIEW_REQUIRED");
    assert.equal(value.design.iacEngine, "TERRAFORM");
    assert.equal(value.design.buildEligible, false);
    assert.equal(value.design.mutationSupported, false);
    assert.equal(value.design.preview, "NOT_RUN");
    assert.match(value.inventoryEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.match(value.evidenceSha256, /^[a-f0-9]{64}$/);
    assert.ok(value.assets.every(x => x.provider === "GCP" && x.ownership === "UNKNOWN" && x.mutationPolicy === "READ_ONLY"));
    assert.doesNotMatch(JSON.stringify(value), /accessToken|privateKey|refreshToken|credentials/);
    const repeated = await createGcpOfflineShowcase(scenario);
    assert.equal(value.evidenceSha256, repeated.evidenceSha256, "same fixture yields identical hash");
  }
});

test("positive brownfield fixture does not authorize ownership or operations", async () => {
  const value = await createGcpOfflineShowcase("brownfield");
  assert.equal(value.assetCount, 2);
  assert.equal(value.discoveredClassification, "BROWNFIELD_FIXTURE");
  assert.deepEqual(value.assets.map(a => a.resourceType), [
    "compute.googleapis.com/Network",
    "compute.googleapis.com/Subnetwork",
  ]);
  assert.ok(value.assets.every(a => a.sourceOfTruth === "UNKNOWN"));
});

test("empty GCP fixture never proves real greenfield, even when scenario is named greenfield", async () => {
  for (const scenario of ["greenfield", "unknown"] as const) {
    const value = await createGcpOfflineShowcase(scenario);
    assert.equal(value.assetCount, 0);
    assert.equal(value.discoveredClassification, "UNKNOWN");
    assert.equal(value.design.buildEligible, false);
  }
});

test("GCP mock transport rejects invalid scenario instead of defaulting to another provider", async () => {
  await assert.rejects(createGcpOfflineShowcase("production" as GcpOfflineScenario), /GCP_OFFLINE_SCENARIO_INVALID/);
  await assert.rejects(createGcpOfflineShowcase("__proto__" as GcpOfflineScenario), /GCP_OFFLINE_SCENARIO_INVALID/);
});
