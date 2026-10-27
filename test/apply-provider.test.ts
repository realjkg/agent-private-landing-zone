import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { providerSpec } from "../src/apply/provider.js";
import { contractJson, writeReviewedContract } from "./helpers/apply-fixtures.js";

test("the provider lookup returns the spec for the contract's provider id and refuses everything else", () => {
  assert.equal(providerSpec("AZURE")?.id, "AZURE");
  assert.equal(providerSpec("AWS")?.id, "AWS");
  assert.equal(providerSpec("GCP")?.id, "GCP");
  for (const unknown of ["gcp", "aws", "azure", "", "toString", "__proto__", "constructor", undefined, null, 7, {}, ["AZURE"]]) {
    assert.equal(providerSpec(unknown), undefined, String(unknown));
  }
});

test("an authorized contract naming a provider with no spec is CONTRACT_INVALID, and an admitted one with the wrong shape or scope is CONTRACT_INVALID too, never a pilot", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-provider-"));
  try {
    for (const provider of ["azure", "toString", "OCI"]) {
      const path = join(dir, provider + ".json");
      writeReviewedContract(path, contractJson(join(dir, "kill"), { provider }));
      const loaded = loadPilotContract(path);
      assert.ok("reason" in loaded && loaded.code === "CONTRACT_INVALID" && /provider/.test(loaded.reason), provider);
    }
    // GCP Terraform is admitted for DEV only (the admission-wiring lane, #39): the three-stage Azure-shaped fixture is not a GCP contract.
    const path = join(dir, "GCP.json");
    writeReviewedContract(path, contractJson(join(dir, "kill"), { provider: "GCP" }));
    const gcp = loadPilotContract(path);
    assert.ok("reason" in gcp && gcp.code === "CONTRACT_INVALID" && /GCP TERRAFORM/.test(gcp.reason), JSON.stringify(gcp));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
