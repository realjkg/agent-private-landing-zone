import assert from "node:assert/strict";
import test from "node:test";

import { buildLifecycleReport, lifecycleReportProblems } from "../src/apply/lifecycle-report.js";
import type { ApplyEvidence, EngineId, ProviderId } from "../src/apply/types.js";
import { ACT_RELEASE_PATHS, actGateId } from "../src/qualification/release-admission.js";

// SYNTHETIC: the lifecycle report is checked against the release's ACT paths (ACT_RELEASE_PATHS, the source of every act:* gate).
// The apply evidence below is a stand-in with only the fields the report reads; no engine ran and no cloud was read.
const NOW = new Date("2026-10-28T12:00:00.000Z");
const applyEvidence = {
  outcome: "SUCCEEDED",
  sourceCommit: "a".repeat(40),
  contractSha256: "b".repeat(64),
  artifactSha256: "c".repeat(64),
  environment: "DEV",
  target: { account: "sovereign-lz-dev", backend: "gcs:alz-state/act-dev1", workspace: "default" },
  approvals: [{ approverId: "alice" }],
  finishedAt: NOW.toISOString(),
} as unknown as ApplyEvidence;

const reportFor = (provider: string, engine: string, gateId = actGateId({ provider, engine })) => buildLifecycleReport({
  gateId, provider: provider as ProviderId, engine: engine as EngineId, applyEvidence,
  observation: undefined, proposal: undefined, cleanup: undefined, leftovers: undefined, live: undefined, now: NOW,
});

test("the lifecycle report accepts every release ACT path, GCP Terraform (act:gcp-terraform) among them, and stays SYNTHETIC and unpassed without its records", () => {
  assert.ok(ACT_RELEASE_PATHS.some((path) => path.provider === "GCP" && path.engine === "TERRAFORM"));
  for (const path of ACT_RELEASE_PATHS) {
    const report = reportFor(path.provider, path.engine);
    assert.deepEqual(lifecycleReportProblems(report, { gateId: actGateId(path) }), [], actGateId(path));
  }
  const gcp = reportFor("GCP", "TERRAFORM");
  assert.equal(gcp.gateId, "act:gcp-terraform");
  assert.equal(gcp.mode, "SYNTHETIC");
  assert.equal(gcp.passed, false);
  assert.ok(gcp.unresolved.includes("observe the run"));
});

test("the lifecycle report accepts GCP_API only for its own gate (act:gcp-gcp_api, INT-2), never under GCP Terraform's, and the reverse", () => {
  assert.ok(ACT_RELEASE_PATHS.some((path) => path.provider === "GCP" && path.engine === "GCP_API"));
  const native = reportFor("GCP", "GCP_API");
  assert.equal(native.gateId, "act:gcp-gcp_api");
  assert.deepEqual(lifecycleReportProblems(native, { gateId: "act:gcp-gcp_api" }), []);
  assert.equal(native.mode, "SYNTHETIC");
  assert.equal(native.passed, false);
  const wrongGate = /report\.gateId: does not name the report's provider and engine/;
  assert.match(lifecycleReportProblems(reportFor("GCP", "GCP_API", "act:gcp-terraform")).join(" | "), wrongGate, "GCP_API under GCP Terraform's gate");
  assert.match(lifecycleReportProblems(reportFor("GCP", "TERRAFORM", "act:gcp-gcp_api")).join(" | "), wrongGate, "GCP Terraform under GCP_API's gate");
  assert.match(lifecycleReportProblems(native, { gateId: "act:gcp-terraform" }).join(" | "), /report\.gateId: not the expected gate/);
  // Only one underscore form, and only the report's own lower-case engine id.
  for (const gateId of ["act:gcp-gcp__api", "act:gcp-_api", "act:gcp-gcp_api_", "act:gcp-GCP_API"]) {
    assert.match(lifecycleReportProblems(reportFor("GCP", "GCP_API", gateId)).join(" | "), /report\.gateId: not an ACT gate id/, gateId);
  }
});

test("the lifecycle report refuses a provider and engine with no release path: GCP CDK, Azure GCP_API, and a GCP report under another path's gate", () => {
  const unknown = /report: provider, engine or scenario is unknown/;
  assert.match(lifecycleReportProblems(reportFor("GCP", "CDK")).join(" | "), unknown);
  assert.match(lifecycleReportProblems(reportFor("AZURE", "GCP_API")).join(" | "), unknown);
  assert.match(lifecycleReportProblems(reportFor("AWS", "GCP_API")).join(" | "), unknown);
  assert.match(lifecycleReportProblems(reportFor("GCP", "TERRAFORM", "act:aws-terraform")).join(" | "), /report\.gateId: does not name the report's provider and engine/);
  assert.match(lifecycleReportProblems(reportFor("GCP", "TERRAFORM"), { gateId: "act:azure-terraform" }).join(" | "), /report\.gateId: not the expected gate/);
});
