import assert from "node:assert/strict";
import test from "node:test";

import {
  parseInventoryEvidenceBundle,
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


test("imported physical and virtual inventory cannot grant mutation authority", () => {
  const resources =
    parseInventoryEvidenceBundle(
      JSON.stringify({
        assets: [
          {
            resourceId:
              "edge:physical:1",
            resourceType:
              "EDGE::Appliance",
            name: "edge-1",
            assetKind:
              "PHYSICAL",
            ownership:
              "MANAGED_BY_CUSTOMER",
            sourceOfTruth:
              "MANUAL",
          },
          {
            resourceId:
              "edge:virtual:1",
            resourceType:
              "EDGE::VirtualAppliance",
            name: "gateway-1",
            assetKind:
              "VIRTUAL",
            ownership:
              "MANAGED_BY_OTHER_IAC",
            sourceOfTruth:
              "TERRAFORM",
          },
        ],
      }),
      "AWS",
    );

  assert.equal(
    resources.length,
    2,
  );
  assert.equal(
    resources.every(
      (resource) =>
        resource.mutationPolicy ===
        "READ_ONLY",
    ),
    true,
  );
  assert.equal(
    resources[0].metadata
      ?.assetKind,
    "PHYSICAL",
  );
});
