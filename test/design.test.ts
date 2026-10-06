import assert from "node:assert/strict";
import test from "node:test";

import {
  assessEnvironment,
} from "../src/assessment/posture.js";
import {
  createDesignSpec,
} from "../src/design/create.js";
import {
  selectDesignPlugin,
} from "../src/design/select-plugin.js";
import {
  assessDelta,
} from "../src/delta/assess.js";
import {
  discoverEnvironment,
} from "../src/discovery/discover.js";

test("AWS CDK design routes synthesized evidence through CloudFormation", () => {
  const selected =
    selectDesignPlugin(
      "AWS",
      "Use AWS CDK for this design.",
      "TERRAFORM",
    );

  assert.equal(
    selected.plugin,
    "AWS_CDK",
  );
  assert.equal(
    selected.evidencePath,
    "CDK_SYNTH_CHANGE_SET",
  );
  assert.equal(
    selected.status,
    "PLANNED",
  );
  assert.equal(
    selected.buildEligible,
    false,
  );
});

test("Bicep is Azure-only and planned until its adapter is implemented", () => {
  const azure =
    selectDesignPlugin(
      "AZURE",
      "Design this using Bicep.",
      "TERRAFORM",
    );
  const aws =
    selectDesignPlugin(
      "AWS",
      "Design this using Bicep.",
      "TERRAFORM",
    );

  assert.equal(azure.plugin, "BICEP");
  assert.equal(azure.status, "PLANNED");
  assert.equal(
    aws.status,
    "INCOMPATIBLE",
  );
});

test("brownfield DesignSpec preserves read-only ownership and is hashable", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "brownfield",
    });
  const assessment =
    assessEnvironment(environment);
  const delta = assessDelta(
    environment,
    "Design a private inference runtime using Terraform.",
  );

  const design =
    createDesignSpec({
      environment,
      assessment,
      delta,
      objective:
        "Design a private inference runtime using Terraform.",
      constraints: [
        "Preserve customer ownership.",
      ],
      engine: "TERRAFORM",
    });

  assert.equal(
    design.plugin.plugin,
    "TERRAFORM",
  );
  assert.equal(
    design.designHash.length,
    64,
  );
  assert.ok(
    design.reuse.includes(
      "aws:organizations:o-example",
    ),
  );
  assert.ok(
    design.forbiddenChanges.includes(
      "aws:organizations:o-example",
    ),
  );
  assert.notEqual(
    design.status,
    "PROPOSED",
  );
});

test("unknown environments produce blocked designs", async () => {
  const environment =
    await discoverEnvironment({
      provider: "AWS",
      mock: "unknown",
    });
  const assessment =
    assessEnvironment(environment);
  const delta = assessDelta(
    environment,
    "Design workload.",
  );

  const design =
    createDesignSpec({
      environment,
      assessment,
      delta,
      objective: "Design workload.",
      constraints: [],
      engine: "TERRAFORM",
    });

  assert.equal(
    design.status,
    "BLOCKED",
  );
});


test("Ansible is a governed Build plug-in for brownfield configuration scenarios", () => {
  const selected =
    selectDesignPlugin(
      "AWS",
      "Build and configure the attached edge nodes using Ansible.",
      "TERRAFORM",
    );

  assert.equal(
    selected.plugin,
    "ANSIBLE",
  );
  assert.equal(
    selected.evidencePath,
    "CHECK_MODE",
  );
  assert.equal(
    selected.status,
    "PLANNED",
  );
  assert.equal(
    selected.buildEligible,
    false,
  );
});
