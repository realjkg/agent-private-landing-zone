import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSbomDocument,
} from "../src/assessment/sbom.js";

test("CycloneDX SBOM normalizes components and vulnerability references", () => {
  const parsed =
    parseSbomDocument(
      JSON.stringify({
        bomFormat: "CycloneDX",
        components: [
          {
            type: "library",
            name: "example-lib",
            version: "1.2.3",
            "bom-ref": "pkg:example-lib",
          },
        ],
        vulnerabilities: [
          {
            affects: [
              {
                ref: "pkg:example-lib",
              },
            ],
          },
        ],
      }),
      "file:sbom.json",
    );

  assert.equal(
    parsed.format,
    "CYCLONEDX",
  );
  assert.equal(
    parsed.components.length,
    1,
  );
  assert.equal(
    parsed.components[0]
      .vulnerabilities,
    1,
  );
});

test("SPDX SBOM normalizes package inventory without inventing vulnerability status", () => {
  const parsed =
    parseSbomDocument(
      JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [
          {
            name: "example-package",
            versionInfo: "4.5.6",
          },
        ],
      }),
      "file:spdx.json",
    );

  assert.equal(
    parsed.format,
    "SPDX",
  );
  assert.equal(
    parsed.components[0].name,
    "example-package",
  );
  assert.equal(
    parsed.components[0]
      .vulnerabilities,
    0,
  );
});

test("unknown SBOM formats fail closed", () => {
  assert.throws(
    () =>
      parseSbomDocument(
        JSON.stringify({
          format: "other",
        }),
        "file:unknown.json",
      ),
    /SBOM_UNSUPPORTED/,
  );
});
