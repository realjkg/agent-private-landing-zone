import assert from "node:assert/strict";
import test from "node:test";

import {
  assessEnvironment,
} from "../src/assessment/posture.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";
import {
  createPillarPolicyBundle,
} from "../src/policy/pillars/baseline.js";

test("pillar bundle is deterministic, hashable, and covers all six design domains", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const assessment =
    assessEnvironment(environment);

  const first =
    createPillarPolicyBundle({
      environment,
      assessment,
    });
  const second =
    createPillarPolicyBundle({
      environment,
      assessment,
    });

  assert.equal(
    first.bundleHash.length,
    64,
  );
  assert.equal(
    first.bundleHash,
    second.bundleHash,
  );
  assert.equal(
    first.bundleId,
    second.bundleId,
  );

  assert.deepEqual(
    [
      first.security.pillar,
      first.cost.pillar,
      first.resiliency.pillar,
      first.reliability.pillar,
      first.performance.pillar,
      first.sustainability.pillar,
    ],
    [
      "SECURITY",
      "COST",
      "RESILIENCY",
      "RELIABILITY",
      "PERFORMANCE",
      "SUSTAINABILITY",
    ],
  );
});

test("cost policy scaffolds allocation tags without inventing spend", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const assessment =
    assessEnvironment(environment);

  const bundle =
    createPillarPolicyBundle({
      environment,
      assessment,
    });

  assert.ok(
    bundle.cost.controls.some(
      (control) =>
        control.includes(
          "cost-center",
        ),
    ),
  );

  const costImpact =
    bundle.cost.requirements.find(
      (requirement) =>
        requirement.id ===
        "cost-impact-evidence",
    );

  assert.equal(
    costImpact?.status,
    "UNKNOWN",
  );
});

test("manifest-only recovery evidence cannot satisfy resiliency policy", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const assessment =
    assessEnvironment(environment);

  const bundle =
    createPillarPolicyBundle({
      environment,
      assessment,
    });

  assert.notEqual(
    bundle.resiliency.status,
    "SATISFIED",
  );

  assert.ok(
    bundle.resiliency.controls.some(
      (control) =>
        control.includes(
          "inventory manifest",
        ),
    ),
  );
});

test("performance and sustainability remain UNKNOWN without measurement evidence", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const assessment =
    assessEnvironment(environment);

  const bundle =
    createPillarPolicyBundle({
      environment,
      assessment,
    });

  assert.equal(
    bundle.performance.status,
    "UNKNOWN",
  );
  assert.equal(
    bundle.sustainability.status,
    "UNKNOWN",
  );
});
