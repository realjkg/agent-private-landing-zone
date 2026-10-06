import assert from "node:assert/strict";
import test from "node:test";

import {
  parseInventoryEvidenceBundle,
  parsePostureEvidenceBundle,
} from "../src/assessment/ingest.js";
import {
  assessEnvironment,
} from "../src/assessment/posture.js";
import {
  parseSbomDocument,
} from "../src/assessment/sbom.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";

test("normalized evidence bundle feeds inventory security SBOM and resiliency assessment", async () => {
  const resources =
    parseInventoryEvidenceBundle(
      JSON.stringify({
        assets: [
          {
            resourceId:
              "edge:physical:node-01",
            resourceType:
              "EDGE::SecureCompute",
            name: "node-01",
            assetKind: "PHYSICAL",
            ownership:
              "MANAGED_BY_CUSTOMER",
            sourceOfTruth: "MANUAL",
          },
        ],
      }),
      "AWS",
    );

  const posture =
    parsePostureEvidenceBundle(
      JSON.stringify({
        scannerObservations: [
          {
            id:
              "edge-secure-boot",
            scanner:
              "device-posture",
            source: "fixture",
            status: "PASS",
            domain: "PLATFORM",
            severity: "INFO",
            title:
              "Secure boot evidenced",
            detail:
              "Hardware root of trust is evidenced.",
            resourceId:
              "edge:physical:node-01",
          },
        ],
        resiliencyObservations: [
          {
            key:
              "configuration_backup",
            value: "present",
            source: "fixture",
          },
          {
            key:
              "restore_test",
            value: "verified",
            source: "fixture",
          },
          {
            key:
              "redundant_control_plane",
            value: "present",
            source: "fixture",
          },
          {
            key: "rpo",
            value: "15m",
            source: "fixture",
          },
          {
            key: "rto",
            value: "1h",
            source: "fixture",
          },
        ],
      }),
    );

  const sbom = parseSbomDocument(
    JSON.stringify({
      bomFormat: "CycloneDX",
      components: [
        {
          name: "edge-runtime",
          version: "1.0.0",
          type: "application",
          "bom-ref": "pkg:edge-runtime",
        },
      ],
      vulnerabilities: [],
    }),
    "fixture:sbom",
  );

  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "greenfield",
      evidenceBundle: {
        resources,
        scannerObservations:
          posture.scannerObservations,
        resiliencyObservations:
          posture.resiliencyObservations,
        sbomComponents:
          sbom.components,
        sbomComplete: true,
      },
    });

  const assessment =
    assessEnvironment(environment);

  assert.equal(
    assessment.inventory.physicalAssets,
    1,
  );
  assert.equal(
    assessment.sbom.status,
    "PRESENT",
  );
  assert.equal(
    assessment.resiliency.status,
    "SECURE",
  );
  assert.equal(
    assessment.resiliency.restoreEvidence,
    "VERIFIED",
  );
});

test("imported inventory cannot grant mutation authority", async () => {
  const resources =
    parseInventoryEvidenceBundle(
      JSON.stringify({
        assets: [
          {
            resourceId:
              "edge:virtual:gateway",
            resourceType:
              "EDGE::VirtualGateway",
            name: "gateway",
            assetKind: "VIRTUAL",
            ownership:
              "MANAGED_BY_CUSTOMER",
            sourceOfTruth: "MANUAL",
          },
        ],
      }),
      "AWS",
    );

  assert.equal(
    resources[0].mutationPolicy,
    "READ_ONLY",
  );
});
