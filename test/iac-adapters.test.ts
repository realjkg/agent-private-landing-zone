import assert from "node:assert/strict";
import test from "node:test";

import {
  getIaCAdapter,
} from "../src/iac/index.js";

test("all registered build adapters resolve explicitly", () => {
  for (const engine of [
    "TERRAFORM",
    "PULUMI",
    "OPENTOFU",
    "BICEP",
    "CLOUDFORMATION",
    "AWS_CDK",
    "ANSIBLE",
    "CROSSPLANE",
  ] as const) {
    assert.equal(
      getIaCAdapter(engine).engine,
      engine,
    );
  }
});
