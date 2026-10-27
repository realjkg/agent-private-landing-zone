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
  for (const unknown of ["GCP", "aws", "azure", "", "toString", "__proto__", "constructor", undefined, null, 7, {}, ["AZURE"]]) {
    assert.equal(providerSpec(unknown), undefined, String(unknown));
  }
});

test("an authorized contract naming a provider with no spec is CONTRACT_INVALID, and a planned one NOT_IMPLEMENTED, never a pilot", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-provider-"));
  try {
    for (const provider of ["azure", "toString", "OCI"]) {
      const path = join(dir, provider + ".json");
      writeReviewedContract(path, contractJson(join(dir, "kill"), { provider }));
      const loaded = loadPilotContract(path);
      assert.ok("reason" in loaded && loaded.code === "CONTRACT_INVALID" && /provider/.test(loaded.reason), provider);
    }
    // GCP Terraform is a planned path (six-path baseline, #39): named, and refused until its provider spec lands.
    const path = join(dir, "GCP.json");
    writeReviewedContract(path, contractJson(join(dir, "kill"), { provider: "GCP" }));
    const gcp = loadPilotContract(path);
    assert.ok("reason" in gcp && gcp.code === "NOT_IMPLEMENTED" && /GCP TERRAFORM/.test(gcp.reason), JSON.stringify(gcp));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
