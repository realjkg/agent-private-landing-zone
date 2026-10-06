import assert from "node:assert/strict";
import test from "node:test";

import {
  getIaCAdapter,
} from "../src/iac/index.js";

test("implemented adapters resolve explicitly", () => {
  assert.equal(
    getIaCAdapter("TERRAFORM").engine,
    "TERRAFORM",
  );
  assert.equal(
    getIaCAdapter("PULUMI").engine,
    "PULUMI",
  );
  assert.equal(
    getIaCAdapter("OPENTOFU").engine,
    "OPENTOFU",
  );
  assert.equal(
    getIaCAdapter("BICEP").engine,
    "BICEP",
  );
  assert.equal(
    getIaCAdapter("CLOUDFORMATION").engine,
    "CLOUDFORMATION",
  );
});

test("unimplemented executable-code adapters fail closed", () => {
  for (const engine of [
    "AWS_CDK",
    "ANSIBLE",
    "CROSSPLANE",
  ] as const) {
    assert.throws(
      () => getIaCAdapter(engine),
      /IAC_ADAPTER_NOT_IMPLEMENTED/,
    );
  }
});
