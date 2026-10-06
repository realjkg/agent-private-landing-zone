import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePostureEvidenceBundle,
} from "../src/assessment/ingest.js";

test("posture evidence bundle accepts normalized scanner and resiliency observations", () => {
  const result =
    parsePostureEvidenceBundle(
      JSON.stringify({
        scannerObservations: [
          {
            id: "finding-1",
            scanner: "scanner",
            source: "file",
            status: "FAIL",
            domain: "NETWORK",
            severity: "HIGH",
            title:
              "Network control failed",
            detail:
              "Observed unsafe exposure.",
          },
        ],
        resiliencyObservations: [
          {
            key: "restore_test",
            value: "verified",
            source: "file",
          },
        ],
      }),
    );

  assert.equal(
    result.scannerObservations[0]
      .severity,
    "HIGH",
  );
  assert.equal(
    result.resiliencyObservations[0]
      .value,
    "verified",
  );
});

test("posture evidence bundle rejects unknown scanner fields and enum values", () => {
  assert.throws(
    () =>
      parsePostureEvidenceBundle(
        JSON.stringify({
          scannerObservations: [
            {
              id: "finding-1",
              scanner: "scanner",
              source: "file",
              status: "FAIL",
              domain: "NOT_A_DOMAIN",
              severity: "HIGH",
              title: "bad",
              detail: "bad",
            },
          ],
        }),
      ),
  );
});
