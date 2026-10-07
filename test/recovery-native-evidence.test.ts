import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverEnvironment,
} from "../src/discovery/discover.js";
import {
  captureProviderRecoveryEvidence,
} from "../src/recovery/native-evidence.js";

test("AWS recovery evidence requires explicit provider-native keys", async () => {
  const base =
    await discoverEnvironment({
      provider: "AWS",
      mock: "greenfield",
    });

  const genericOnly = {
    ...base,
    evidence: [
      ...base.evidence,
      {
        key:
          "configuration_export",
        value: "present",
        source: "test",
      },
    ],
  };

  assert.deepEqual(
    captureProviderRecoveryEvidence(
      genericOnly,
    ).configurationExportRefs,
    [],
  );

  const environment = {
    ...base,
    evidence: [
      ...base.evidence,
      {
        key:
          "aws.configuration_export",
        value: "present",
        source: "test",
      },
      {
        key:
          "aws.backup.vault",
        value: "present",
        source: "test",
      },
      {
        key:
          "aws.backup.encryption",
        value: "present",
        source: "test",
      },
    ],
  };

  const captured =
    captureProviderRecoveryEvidence(
      environment,
    );

  assert.equal(
    captured.secretFree,
    true,
  );
  assert.deepEqual(
    captured.configurationExportRefs,
    [
      "test:aws.configuration_export",
    ],
  );
  assert.deepEqual(
    captured.storageEvidenceRefs,
    [
      "test:aws.backup.vault",
    ],
  );
  assert.deepEqual(
    captured.encryptionEvidenceRefs,
    [
      "test:aws.backup.encryption",
    ],
  );
  assert.deepEqual(
    captured.missingEvidence,
    [],
  );
});

test("Azure recovery evidence remains provider-specific and UNKNOWN when storage proof is absent", async () => {
  const base =
    await discoverEnvironment({
      provider: "AZURE",
      mock: "greenfield",
    });

  const environment = {
    ...base,
    evidence: [
      ...base.evidence,
      {
        key:
          "azure.configuration_export",
        value: "present",
        source: "test",
      },
      {
        key:
          "azure.recovery_encryption",
        value: "present",
        source: "test",
      },
    ],
  };

  const captured =
    captureProviderRecoveryEvidence(
      environment,
    );

  assert.equal(
    captured
      .configurationExportRefs
      .length,
    1,
  );
  assert.equal(
    captured
      .storageEvidenceRefs
      .length,
    0,
  );
  assert.ok(
    captured.missingEvidence.some(
      (item) =>
        /storage evidence is UNKNOWN/i.test(
          item,
        ),
    ),
  );
});
