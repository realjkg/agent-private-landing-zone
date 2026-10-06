import assert from "node:assert/strict";
import test from "node:test";

import {
  assessDelta,
} from "../src/delta/assess.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";

test("brownfield delta reuses customer assets and integrates accelerator assets", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });

  const delta = assessDelta(
    environment,
    "Add a private inference runtime.",
  );

  const organization =
    delta.decisions.find(
      (decision) =>
        decision.resourceId ===
        "aws:organizations:o-example",
    );
  const executionRole =
    delta.decisions.find(
      (decision) =>
        decision.resourceId ===
        "aws:iam:role:agent-execution",
    );

  assert.equal(
    organization?.action,
    "REUSE",
  );
  assert.equal(
    executionRole?.action,
    "INTEGRATE",
  );
  assert.equal(
    delta.designRequired,
    true,
  );
  assert.deepEqual(
    delta.blockers,
    [],
  );
});

test("unknown environment blocks delta design assumptions", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "unknown",
    });

  const delta = assessDelta(
    environment,
    "Add workload.",
  );

  assert.equal(
    delta.environmentType,
    "UNKNOWN",
  );
  assert.ok(
    delta.blockers.length > 0,
  );
});
