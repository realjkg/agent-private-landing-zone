import assert from "node:assert/strict";
import test from "node:test";

import {
  getToolSecurityPosture,
} from "../src/tools/broker.js";

test("tool broker exposes no mutation or arbitrary shell capability", () => {
  const posture =
    getToolSecurityPosture();

  assert.deepEqual(
    posture.mutationTools,
    [],
  );
  assert.equal(
    posture.arbitraryShell,
    false,
  );
  assert.equal(
    posture.cloudReadDefault,
    false,
  );
});
