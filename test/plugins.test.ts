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

test("implemented engines remain Terraform and Pulumi until adapters are enabled", () => {
  const implemented =
    PLUGIN_CATALOG.filter(
      (plugin) =>
        plugin.status === "IMPLEMENTED",
    ).map((plugin) => plugin.id);

  assert.deepEqual(
    implemented,
    ["TERRAFORM", "PULUMI"],
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


test("Ansible participates in governed Build as well as Configure and Manage", () => {
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

test("AWS CDK retains synthesis and normalized change evidence requirements", () => {
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
