import assert from "node:assert/strict";
import test from "node:test";

import { fixtureThinker } from "../src/agent/fixture.js";
import { runAgentKernel } from "../src/agent/graph.js";
import { sha256 } from "../src/build/provenance.js";
import { runRealPrivateModelBuild, type RealPrivateBuildDeps } from "../src/build/private-model.js";
import { collectRepositoryEvidence } from "../src/build/repository.js";
import { AWS_TERRAFORM_SCENARIO } from "../src/qualification/aws-terraform-agent.js";
import type { AgentState } from "../src/agent/types.js";

async function reviewedState(): Promise<AgentState> {
  const state = await runAgentKernel({
    request: AWS_TERRAFORM_SCENARIO.request,
    provider: "AWS", engine: "TERRAFORM",
    mock: "brownfield", thinker: fixtureThinker,
  });
  assert.ok(state.environment && state.design && state.assessment);
  state.mock = undefined;
  state.action = undefined;
  state.environment.evidence = [
    { key: "aws.identity", value: "authenticated", source: "aws-cli" },
    { key: "aws.organizations", value: "present", source: "aws-cli" },
  ];
  state.environment.warnings = [];
  state.assessment.modelInvocations = ["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"]
    .map((role) => ({
      role: role as "ROUTER" | "PRIMARY" | "VALIDATOR" | "ADJUDICATOR",
      model: role === "VALIDATOR" ? "mistral-nemo:latest" :
        role === "PRIMARY" ? "qwen3:4b" : "qwen3:1.7b",
      durationMs: 0, structuredOutput: true as const, schemaValid: true as const,
    }));
  return state;
}
const proposal = {
  action: "ADD", resourceType: "aws_cloudwatch_log_group",
  name: "/alz/preview/brownfield-audit", retentionDays: 30,
  ownership: "NEW_RESOURCE_ONLY", evidenceRefs: ["aws.identity"],
};
function deps(checks: Partial<{
  preview: boolean; agree: boolean;
}> = {}): RealPrivateBuildDeps {
  return {
    metadata: async (_url, model) => ({ model, digest: "a".repeat(64), size: 1024 }),
    model: async (_url, model) =>
      JSON.stringify(model.startsWith("mistral") && checks.agree === false
        ? { ...proposal, retentionDays: 90 } : proposal),
    repositoryEvidence: collectRepositoryEvidence,
    validate: async (hcl) => ({
      mode: "REAL_TERRAFORM_FMT_VALIDATE_PLAN",
      infrastructureApplied: false,
      terraformVersion: "1.11.0",
      validatedArtifactHash: sha256(hcl),
      validationOutputHash: "b".repeat(64),
      realPlanEvidenceHash: "c".repeat(64),
      normalizedChangeSetHash: "d".repeat(64),
      singleCreateOnly: checks.preview !== false,
      resourceAddress: "aws_cloudwatch_log_group.alz_audit",
    }),
  };
}
test("reviewed AWS build produces nonfixture Terraform source and real-tool evidence contract", async () => {
  // Injected mocks exercise the trusted-driver contract; not an actual cloud plan.
  const state = await reviewedState();
  const built = await runRealPrivateModelBuild(state, deps());
  assert.equal(built.executionMode, "PREVIEW_ONLY");
  assert.equal(built.candidate.artifact.generatedBy,
    "local-qwen-mistral-reviewed-template");
  assert.equal(built.candidate.status, "READY_FOR_APPROVAL");
  assert.equal(built.gate.allowed, false);
  assert.equal(built.candidate.evidence.designHash, state.design!.designHash);
  assert.equal(built.candidate.evidence.policyBundleHash,
    state.design!.policies.bundleHash);
  assert.match(built.candidate.artifact.contentHash, /^[a-f0-9]{64}$/);
  assert.match(built.previewSummary, /EXTERNAL_APPROVAL_REQUIRED/);
});
test("independent validator schema deviation stops before any IaC driver", async () => {
  let called = false;
  const fake = deps({ agree: false });
  fake.validate = async () => { called = true; throw new Error("MUST_NOT_RUN"); };
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), fake),
    /MODEL_PROPOSAL_RETENTION_MISMATCH/);
  assert.equal(called, false);
});
test("a driver cannot present an unverified or unsafe plan as qualified", async () => {
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(),
    deps({ preview: false })), /ACTUAL_TERRAFORM_PREVIEW_UNVERIFIED/);
});
test("fixture discovery, unknown assets, non-AWS targets and unauthorized requests are blocked", async () => {
  const original = await reviewedState();
  const mock = { ...original, mock: "brownfield" as const };
  await assert.rejects(runRealPrivateModelBuild(mock, deps()),
    /UNAPPROVED_SCENARIO/);
  const wrong = { ...original, request: "Deploy arbitrary roles and users" };
  await assert.rejects(runRealPrivateModelBuild(wrong, deps()),
    /UNAPPROVED_SCENARIO/);
  const unknown = { ...original,
    environment: { ...original.environment!, classification: "UNKNOWN" as const },
  };
  await assert.rejects(runRealPrivateModelBuild(unknown, deps()),
    /LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED/);
  const fakeEvidence = { ...original,
    environment: {
      ...original.environment!,
      evidence: [{ key: "aws.identity", value: "fake", source: "mock" }],
    },
  };
  await assert.rejects(runRealPrivateModelBuild(fakeEvidence, deps()),
    /LIVE_DESIGN_OR_OWNERSHIP_NOT_APPROVED/);
});
test("missing trusted real-preview driver always fails closed", async () => {
  const state = await reviewedState();
  const injected = deps();
  injected.validate = async () => {
    throw new Error("REAL_TERRAFORM_PREVIEW_DRIVER_NOT_CONNECTED");
  };
  await assert.rejects(runRealPrivateModelBuild(state, injected),
    /REAL_TERRAFORM_PREVIEW_DRIVER_NOT_CONNECTED/);
});
