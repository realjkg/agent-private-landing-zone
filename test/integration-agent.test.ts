import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_CONNECTORS,
  TARGET_CONNECTORS,
} from "../src/integration-sim/catalog.js";
import {
  simulateConnection,
  syntheticQualificationMatrix,
  verifyRecordHash,
} from "../src/integration-sim/agent.js";

test("synthetic integration matrix covers 90 connection scenarios", () => {
  const results =
    syntheticQualificationMatrix();

  assert.equal(
    TARGET_CONNECTORS.length,
    6,
  );
  assert.equal(
    EVIDENCE_CONNECTORS.length,
    7,
  );
  assert.equal(
    results.length,
    90,
  );
});

test("synthetic catalog distinguishes implemented, project-connected, and test-double connectors", () => {
  const targetStatus =
    Object.fromEntries(
      TARGET_CONNECTORS.map(
        (connector) => [
          connector.id,
          connector.status,
        ],
      ),
    );

  assert.equal(
    targetStatus.AWS,
    "IMPLEMENTED",
  );
  assert.equal(
    targetStatus.AZURE,
    "IMPLEMENTED",
  );
  assert.equal(
    targetStatus
      .ANSIBLE_PRIVATE_EDGE,
    "IMPLEMENTED",
  );
  assert.equal(
    targetStatus
      .CROSSPLANE_KUBERNETES_EDGE,
    "IMPLEMENTED",
  );
  assert.equal(
    targetStatus.VCF,
    "IMPLEMENTED",
  );
  assert.equal(
    targetStatus.OPENSHIFT,
    "IMPLEMENTED",
  );

  const evidenceStatus =
    Object.fromEntries(
      EVIDENCE_CONNECTORS.map(
        (connector) => [
          connector.id,
          connector.status,
        ],
      ),
    );

  assert.equal(
    evidenceStatus.GITHUB,
    "PROJECT_CONNECTED",
  );

  for (const id of [
    "JIRA",
    "SERVICENOW",
    "CMDB",
    "GITLAB",
    "CIRCLECI",
    "JENKINS",
  ]) {
    assert.equal(
      evidenceStatus[id],
      "TEST_DOUBLE",
    );
  }
});

test("disconnected mode remains locally traceable without ITSM, CMDB, or DevOps connectors", () => {
  for (const target of
    TARGET_CONNECTORS) {
    const result =
      simulateConnection(
        target,
        "DISCONNECTED",
      );

    assert.equal(
      result.traceable,
      true,
    );
    assert.equal(
      result.records.length,
      1,
    );
    assert.equal(
      result.records[0]
        .externalReferences.length,
      0,
    );
    assert.equal(
      result.records[0]
        .changeRecordId,
      result
        .canonicalChangeRecordId,
    );
    assert.equal(
      verifyRecordHash(
        result.records[0],
      ),
      true,
    );
    assert.equal(
      result
        .externalAuthorityGranted,
      false,
    );
    assert.equal(
      result
        .infrastructureMutationAttempted,
      false,
    );
  }
});

test("connected mode binds external evidence without granting authority", () => {
  for (const target of
    TARGET_CONNECTORS) {
    for (const connector of
      EVIDENCE_CONNECTORS) {
      const result =
        simulateConnection(
          target,
          "CONNECTED",
          connector,
        );

      assert.equal(
        result.records.length,
        1,
      );
      assert.deepEqual(
        result.records[0]
          .externalReferences.map(
            (reference) =>
              reference.provider,
          ),
        [connector.id],
      );
      assert.equal(
        verifyRecordHash(
          result.records[0],
        ),
        true,
      );
      assert.equal(
        result
          .externalAuthorityGranted,
        false,
      );
      assert.equal(
        result
          .infrastructureMutationAttempted,
        false,
      );
    }
  }
});

test("reconciled mode preserves the original local record as canonical and hash-links external evidence", () => {
  for (const target of
    TARGET_CONNECTORS) {
    for (const connector of
      EVIDENCE_CONNECTORS) {
      const result =
        simulateConnection(
          target,
          "RECONCILED",
          connector,
        );
      const [
        local,
        reconciled,
      ] = result.records;

      assert.ok(local);
      assert.ok(reconciled);
      assert.equal(
        result
          .canonicalChangeRecordId,
        local.changeRecordId,
      );
      assert.equal(
        local.traceabilityMode,
        "DISCONNECTED",
      );
      assert.equal(
        reconciled
          .traceabilityMode,
        "RECONCILED",
      );
      assert.equal(
        local.externalReferences
          .length,
        0,
      );
      assert.deepEqual(
        reconciled
          .externalReferences.map(
            (reference) =>
              reference.provider,
          ),
        [connector.id],
      );
      assert.deepEqual(
        reconciled
          .parentChangeRecordIds,
        [local.changeRecordId],
      );
      assert.equal(
        reconciled
          .previousRecordHash,
        local.recordHash,
      );
      assert.equal(
        verifyRecordHash(local),
        true,
      );
      assert.equal(
        verifyRecordHash(
          reconciled,
        ),
        true,
      );
      assert.equal(
        result
          .externalAuthorityGranted,
        false,
      );
      assert.equal(
        result
          .infrastructureMutationAttempted,
        false,
      );
    }
  }
});

test("synthetic matrix is deterministic", () => {
  assert.deepEqual(
    syntheticQualificationMatrix(),
    syntheticQualificationMatrix(),
  );
});

test("invalid mode bindings fail closed", () => {
  const target =
    TARGET_CONNECTORS[0];
  const connector =
    EVIDENCE_CONNECTORS[0];

  assert.ok(target);
  assert.ok(connector);

  assert.throws(
    () =>
      simulateConnection(
        target,
        "CONNECTED",
      ),
    /requires an external evidence connector/,
  );

  assert.throws(
    () =>
      simulateConnection(
        target,
        "DISCONNECTED",
        connector,
      ),
    /cannot bind an external evidence connector/,
  );
});
