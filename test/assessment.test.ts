import assert from "node:assert/strict";
import test from "node:test";

import {
  assessEnvironment,
} from "../src/assessment/posture.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";

test("brownfield assessment covers cloud virtual physical SBOM and resiliency posture", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });

  const assessment =
    assessEnvironment(environment);

  assert.equal(
    assessment.inventory.totalAssets,
    5,
  );
  assert.equal(
    assessment.inventory.cloudAssets,
    3,
  );
  assert.equal(
    assessment.inventory.virtualAssets,
    1,
  );
  assert.equal(
    assessment.inventory.physicalAssets,
    1,
  );
  assert.equal(
    assessment.securityStatus,
    "INSECURE",
  );
  assert.equal(
    assessment.sbom.status,
    "PARTIAL",
  );
  assert.equal(
    assessment.sbom.componentCount,
    3,
  );
  assert.equal(
    assessment.sbom.vulnerableComponents,
    1,
  );
  assert.equal(
    assessment.resiliency.status,
    "PARTIAL",
  );
  assert.equal(
    assessment.resiliency.restoreEvidence,
    "UNVERIFIED",
  );
  assert.equal(
    assessment.recoverySnapshot.resourceCount,
    5,
  );
  assert.equal(
    assessment.recoverySnapshot.configurationHash.length,
    64,
  );
  assert.equal(
    assessment.recoverySnapshot.coverage,
    "MANIFEST_ONLY",
  );
  assert.equal(
    assessment.recoverySnapshot.restoreStatus,
    "UNVERIFIED",
  );
});

test("unknown discovery never receives a secure posture by assumption", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "unknown",
    });

  const assessment =
    assessEnvironment(environment);

  assert.equal(
    assessment.securityStatus,
    "UNKNOWN",
  );
  assert.equal(
    assessment.sbom.status,
    "UNKNOWN",
  );
  assert.equal(
    assessment.resiliency.status,
    "UNKNOWN",
  );
  assert.equal(
    assessment.recoverySnapshot.restoreStatus,
    "BLOCKED",
  );
});
