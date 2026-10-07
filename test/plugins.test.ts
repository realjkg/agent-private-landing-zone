import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_CATALOG,
} from "../src/plugins/catalog.js";
import {
  validatePluginCatalog,
} from "../src/plugins/validate.js";

test("plug-in catalog is complete and current", () => {
  assert.deepEqual(
    validatePluginCatalog(
      new Date("2026-10-06T12:00:00Z"),
    ),
    [],
  );
});

test("all eight build paths are implemented", () => {
  const implemented =
    PLUGIN_CATALOG.filter(
      (plugin) =>
        plugin.status === "IMPLEMENTED",
    ).map((plugin) => plugin.id);

  assert.deepEqual(
    implemented,
    [
      "TERRAFORM",
      "PULUMI",
      "OPENTOFU",
      "BICEP",
      "CLOUDFORMATION",
      "AWS_CDK",
      "CROSSPLANE",
      "ANSIBLE",
    ],
  );
});

test("all plug-ins participate in supply-chain scanning", () => {
  for (const plugin of PLUGIN_CATALOG) {
    assert.ok(
      plugin.capabilities.includes("SBOM"),
    );
    assert.ok(
      plugin.capabilities.includes(
        "SECURITY_SCAN",
      ),
    );
  }
});

test("Ansible participates in Build Configure and Manage", () => {
  const ansible =
    PLUGIN_CATALOG.find(
      (plugin) =>
        plugin.id === "ANSIBLE",
    );

  assert.ok(ansible);
  assert.deepEqual(
    ansible.stage,
    ["BUILD", "CONFIGURE", "MANAGE"],
  );
  assert.equal(
    ansible.status,
    "IMPLEMENTED",
  );
  assert.ok(
    ansible.capabilities.includes(
      "PREVIEW",
    ),
  );
  assert.ok(
    ansible.capabilities.includes(
      "NORMALIZE",
    ),
  );
});

test("AWS CDK keeps synthesis and normalized CloudFormation evidence", () => {
  const cdk =
    PLUGIN_CATALOG.find(
      (plugin) =>
        plugin.id === "AWS_CDK",
    );

  assert.ok(cdk);
  assert.deepEqual(
    cdk.providers,
    ["AWS"],
  );
  assert.equal(
    cdk.status,
    "IMPLEMENTED",
  );
  assert.ok(
    cdk.capabilities.includes(
      "SYNTHESIZE",
    ),
  );
  assert.ok(
    cdk.capabilities.includes(
      "NORMALIZE",
    ),
  );
});

test("Crossplane is implemented with Build and Manage scope", () => {
  const crossplane =
    PLUGIN_CATALOG.find(
      (plugin) =>
        plugin.id === "CROSSPLANE",
    );

  assert.ok(crossplane);
  assert.equal(
    crossplane.status,
    "IMPLEMENTED",
  );
  assert.deepEqual(
    crossplane.stage,
    ["BUILD", "MANAGE"],
  );
});
