import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { providerSpec } from "../src/apply/provider.js";
import { contractJson, pinPathOf, writePinnedContract } from "./helpers/apply-fixtures.js";

test("the provider lookup returns the spec for the contract's provider id and refuses everything else", () => {
  assert.equal(providerSpec("AZURE")?.id, "AZURE");
  assert.equal(providerSpec("AWS")?.id, "AWS");
  for (const unknown of ["GCP", "aws", "azure", "", "toString", "__proto__", "constructor", undefined, null, 7, {}, ["AZURE"]]) {
    assert.equal(providerSpec(unknown), undefined, String(unknown));
  }
});

test("a pinned contract naming a provider with no spec is CONTRACT_INVALID, not a pilot", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-provider-"));
  try {
    for (const provider of ["GCP", "azure", "toString"]) {
      const path = join(dir, provider + ".json");
      writePinnedContract(path, contractJson(join(dir, "kill"), { provider }));
      const loaded = loadPilotContract(path, pinPathOf(path));
      assert.ok("reason" in loaded && loaded.code === "CONTRACT_INVALID" && /provider/.test(loaded.reason), provider);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
