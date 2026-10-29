import assert from "node:assert/strict";
import test from "node:test";

import { pilotUnitOf } from "../src/apply/unit.js";
import { DRIVER_ENGINES } from "../src/teardown/driver/types.js";
import { buildManifest, MANIFEST_ENGINES } from "../src/teardown/manifest.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";

// SYNTHETIC. The pilot unit (src/apply/unit.ts) and the GCP API-native state reference (docs/act-pilot-gcp-api-driver.md D10, #338 N1).

const CONTRACT = "c".repeat(64);
/**
 * The unit ids every existing path had before the GCP_API reference was added, computed on main ae39be6 with the same inputs. They
 * are the `alz-unit` tag values real runs carry, so any change here would orphan a run's resources from its unit.
 */
const PINNED: readonly [provider: "AWS" | "AZURE" | "GCP", backend: string, environment: "DEV" | "QA", unitId: string][] = [
  ["AWS", "examplefake-dev-state/pilot/dev.tfstate", "DEV", "alzu-32ec72ffaaeab3255ef6"],
  ["AWS", "examplefake-dev-state/pilot/dev.tfstate", "QA", "alzu-6f341d04c6ea5681adc4"],
  ["AZURE", "examplefakestate/tfstate/dev.tfstate", "DEV", "alzu-4ae3409633155e13a727"],
  ["AZURE", "examplefakestate/tfstate/dev.tfstate", "QA", "alzu-69c972865af8e95e8bee"],
  ["AWS", "AlzPilotStack", "DEV", "alzu-09543afd4f3b1ff9bca6"],
  ["AWS", "AlzPilotStack", "QA", "alzu-8a9db1f7522b3e9fa9fc"],
  ["AZURE", "alz-pilot-stack", "DEV", "alzu-bcb0f690bf73abe615ba"],
  ["AZURE", "alz-pilot-stack", "QA", "alzu-727df598d8944133755b"],
  ["GCP", "alz-pilot-dev-state/pilot/dev", "DEV", "alzu-c34712906083cd1b2466"],
  ["GCP", "alz-pilot-dev-state/pilot/dev", "QA", "alzu-59d456a3d6afd37d02e4"],
];
const ACCOUNT = { AWS: "111111111111", AZURE: "22222222-2222-4222-8222-222222222222", GCP: "alz-pilot-dev" } as const;
const targetOf = (provider: keyof typeof ACCOUNT, backend: string) => ({ account: ACCOUNT[provider], backend, workspace: "default" });

test("D10: every existing path's unit id is byte-identical to main's, whether or not the caller names its engine (Terraform, CDK and Bicep stacks, AWS, Azure and GCP)", () => {
  for (const [provider, backend, environment, unitId] of PINNED) {
    for (const engine of [undefined, "TERRAFORM", "CDK", "BICEP"]) {
      const unit = pilotUnitOf({ provider, contractSha256: CONTRACT, environment, target: targetOf(provider, backend), ...(engine ? { engine } : {}) });
      assert.equal(unit.unitId, unitId, provider + " " + backend + " " + environment + " " + (engine ?? "(no engine)"));
      assert.equal(unit.buildId, "alz-pilot-" + environment.toLowerCase() + "-" + CONTRACT.slice(0, 12));
      assert.equal(unit.tags["alz-unit" as keyof typeof unit.tags], unitId, "the tag a run carries is the same value");
    }
  }
});

test("D10: a GCP_API contract's unit has its own state reference (engine GCP_API, backend kind pubsub): one per target, deterministic, distinct from the GCP Terraform unit, and GCP only", () => {
  const target = { account: "alz-pilot-dev", backend: "GCP_API_NO_STATE", workspace: "default" };
  const api = pilotUnitOf({ provider: "GCP", contractSha256: CONTRACT, environment: "DEV", target, engine: "GCP_API" });
  assert.match(api.unitId, /^alzu-[0-9a-f]{20}$/);
  assert.deepEqual(pilotUnitOf({ provider: "GCP", contractSha256: CONTRACT, environment: "DEV", target: { ...target }, engine: "GCP_API" }), api, "the same target names the same unit, run after run");
  assert.notEqual(api.unitId, pilotUnitOf({ provider: "GCP", contractSha256: CONTRACT, environment: "DEV", target }).unitId, "not the Terraform reference");
  assert.notEqual(api.unitId, pilotUnitOf({ provider: "GCP", contractSha256: "d".repeat(64), environment: "DEV", target, engine: "GCP_API" }).unitId, "another contract is another unit");
  for (const provider of ["AWS", "AZURE"] as const) {
    assert.throws(() => pilotUnitOf({ provider, contractSha256: CONTRACT, environment: "DEV", target, engine: "GCP_API" }), /PILOT_UNIT_ENGINE_PROVIDER_MISMATCH/);
  }
});

test("D10: the GCP_API reference names a pilot unit only: a build cannot record a deletion unit of it", () => {
  const plan = normalizeTerraformPlan(JSON.stringify({ format_version: "1.2", resource_changes: [{ address: "google_pubsub_topic.t", type: "google_pubsub_topic", change: { actions: ["create"], after: {}, after_unknown: {} } }] }));
  assert.throws(() => recordDeletionUnit({
    buildId: "build-1", provider: "GCP" as never, stateRef: { engine: "GCP_API", backend: "pubsub", location: "GCP_API_NO_STATE", workspace: "default" },
    designHash: "d".repeat(64), createPlan: plan,
  }), /GCP_API_UNIT_IS_PILOT_ONLY/);
});

test("D17: a GCP_API manifest is a pilot manifest with no lock file, and the destroy-preview driver never takes it", () => {
  assert.ok(MANIFEST_ENGINES.includes("GCP_API"));
  assert.ok(!(DRIVER_ENGINES as readonly string[]).includes("GCP_API"));
  const manifest = buildManifest({
    engine: "GCP_API", mode: "PROJECT", target: { account: "alz-pilot-dev", backend: "GCP_API_NO_STATE", workspace: "default" }, unitHash: "1".repeat(64),
    files: [{ path: "request.json", sha256: "2".repeat(64) }], policyVersion: "policy-1", engineVersion: "1", providers: [], lockFileSha256: undefined, dependencies: [], inputs: [],
  });
  assert.equal(manifest.engine, "GCP_API");
  assert.equal(manifest.lockFileSha256, undefined);
});
