import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEnvironment,
  deriveSafeBuildMode,
} from "../src/discovery/classify.js";
import {
  enforceOwnershipPolicy,
  mutationPolicyForOwnership,
} from "../src/discovery/ownership.js";
import { discoverEnvironment } from "../src/discovery/discover.js";

test("UNKNOWN ownership becomes READ_ONLY", () => {
  assert.equal(
    mutationPolicyForOwnership("UNKNOWN"),
    "READ_ONLY",
  );
});

test("customer-managed resources remain READ_ONLY", () => {
  const resource = enforceOwnershipPolicy({
    resourceId: "example",
    provider: "AWS",
    resourceType: "example",
    name: "example",
    ownership: "MANAGED_BY_CUSTOMER",
    mutationPolicy: "DELETE_ALLOWED",
    sourceOfTruth: "MANUAL",
  });

  assert.equal(resource.mutationPolicy, "READ_ONLY");
});

test("unknown discovery never becomes GREENFIELD", () => {
  const result = classifyEnvironment([]);
  assert.equal(result.classification, "UNKNOWN");
});

test("greenfield requires positive evidence", () => {
  const result = classifyEnvironment([
    {
      key: "aws.greenfield_confirmed",
      value: "true",
      source: "test",
    },
  ]);

  assert.equal(result.classification, "GREENFIELD");
});

test("existing control plane evidence results in BROWNFIELD", () => {
  const result = classifyEnvironment([
    {
      key: "aws.control_tower",
      value: "present",
      source: "test",
    },
  ]);

  assert.equal(result.classification, "BROWNFIELD");
});

test("brownfield defaults to ADDITIVE_ONLY", () => {
  assert.equal(
    deriveSafeBuildMode("BROWNFIELD", []),
    "ADDITIVE_ONLY",
  );
});

test("conflicts block build mode", () => {
  assert.equal(
    deriveSafeBuildMode("BROWNFIELD", [
      {
        code: "OWNERSHIP_CONFLICT",
        message: "conflict",
      },
    ]),
    "BLOCKED",
  );
});

test("AWS brownfield mock performs discovery without delete authority", async () => {
  const state = await discoverEnvironment({
    provider: "AWS",
    mock: "brownfield",
  });

  assert.equal(state.classification, "BROWNFIELD");
  assert.equal(state.safeBuildMode, "ADDITIVE_ONLY");
  assert.equal(
    state.resources.some(
      (resource) => resource.mutationPolicy === "DELETE_ALLOWED",
    ),
    false,
  );
});

test("Azure greenfield mock requires positive greenfield evidence", async () => {
  const state = await discoverEnvironment({
    provider: "AZURE",
    mock: "greenfield",
  });

  assert.equal(state.classification, "GREENFIELD");
  assert.equal(state.safeBuildMode, "GREENFIELD_BASELINE");
});
