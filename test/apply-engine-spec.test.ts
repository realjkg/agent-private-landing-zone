import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { engineSpec } from "../src/apply/engine-spec.js";
import { APPLY_IDENTITIES } from "../src/apply/types.js";
import { contractJson, pinPathOf, writePinnedContract } from "./helpers/apply-fixtures.js";

test("the engine lookup returns the spec for the contract's engine id and refuses everything else", () => {
  assert.equal(engineSpec("TERRAFORM")?.id, "TERRAFORM");
  assert.equal(engineSpec("CDK")?.id, "CDK");
  for (const unknown of ["OPENTOFU", "PULUMI", "cdk", "AWS_CDK", "terraform", "", "toString", "__proto__", "constructor", undefined, null, 7, {}, ["TERRAFORM"]]) {
    assert.equal(engineSpec(unknown), undefined, String(unknown));
  }
});

test("the Terraform spec needs the four identities and attests the state writer and the applier", () => {
  const terraform = engineSpec("TERRAFORM");
  assert.deepEqual([...(terraform?.identities ?? [])], [...APPLY_IDENTITIES]);
  assert.deepEqual([...(terraform?.attests ?? [])], ["STATE_WRITE", "APPLY"]);
});

test("a pinned contract naming an engine with no spec is CONTRACT_INVALID, not a pilot", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-engine-spec-"));
  try {
    for (const engine of ["PULUMI", "OPENTOFU", "terraform", "toString"]) {
      const path = join(dir, engine + ".json");
      writePinnedContract(path, contractJson(join(dir, "kill"), { engine }));
      const loaded = loadPilotContract(path, pinPathOf(path));
      assert.ok("reason" in loaded && loaded.code === "CONTRACT_INVALID" && /engine/.test(loaded.reason), engine);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
