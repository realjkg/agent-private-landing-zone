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


test("existing AWS Config evidence is sufficient to classify brownfield", () => {
  const result = classifyEnvironment([
    {
      key: "aws.config",
      value: "present",
      source: "test",
    },
  ]);

  assert.equal(
    result.classification,
    "BROWNFIELD",
  );
});

test("existing CloudTrail evidence is sufficient to classify brownfield", () => {
  const result = classifyEnvironment([
    {
      key: "aws.cloudtrail",
      value: "present",
      source: "test",
    },
  ]);

  assert.equal(
    result.classification,
    "BROWNFIELD",
  );
});

test("GCP brownfield mock (SYNTHETIC) classifies BROWNFIELD from organization evidence, keeps customer resources READ_ONLY and grants no delete authority", async () => {
  const state = await discoverEnvironment({ provider: "GCP", mock: "brownfield" });
  assert.equal(state.provider, "GCP");
  assert.equal(state.classification, "BROWNFIELD");
  assert.equal(state.safeBuildMode, "ADDITIVE_ONLY");
  assert.ok(state.resources.length > 0 && state.resources.every((r) => r.provider === "GCP" && r.metadata?.mock === true));
  assert.ok(state.resources.every((r) => r.mutationPolicy !== "DELETE_ALLOWED" && r.mutationPolicy !== "UPDATE_ALLOWED"));
  assert.ok(state.resources.filter((r) => r.ownership === "MANAGED_BY_CUSTOMER").every((r) => r.mutationPolicy === "READ_ONLY"));
  assert.ok(state.evidence.every((e) => e.source === "mock"), "every fact is labeled as the mock's");
});

test("GCP greenfield needs positive evidence, an unknown GCP estate stays UNKNOWN, and GCP discovery without a mock refuses rather than reading any cloud", async () => {
  assert.equal((await discoverEnvironment({ provider: "GCP", mock: "greenfield" })).classification, "GREENFIELD");
  const unknown = await discoverEnvironment({ provider: "GCP", mock: "unknown" });
  assert.equal(unknown.classification, "UNKNOWN");
  assert.equal(unknown.safeBuildMode, "READ_ONLY");
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched += 1; throw new Error("no network in this test"); }) as typeof fetch;
  try {
    await assert.rejects(discoverEnvironment({ provider: "GCP" }), /GCP_LIVE_DISCOVERY_UNAVAILABLE/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0, "nothing was requested");
});
