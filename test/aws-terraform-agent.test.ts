import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fixtureThinker } from "../src/agent/fixture.js";
import { runAgentKernel } from "../src/agent/graph.js";
import {
  AWS_TERRAFORM_SCENARIO,
  qualifyAwsTerraformAgents,
  renderAwsTerraformCandidate,
  reviewAwsTerraformProposals,
  type AwsTerraformAgentDeps,
} from "../src/qualification/aws-terraform-agent.js";

const proposal = {
  action: "ADD",
  resourceType: "aws_cloudwatch_log_group",
  name: AWS_TERRAFORM_SCENARIO.logGroupName,
  retentionDays: 30,
  ownership: "NEW_RESOURCE_ONLY",
  evidenceRefs: ["aws.organizations", "aws.control_tower"],
} as const;

function testDeps(): AwsTerraformAgentDeps {
  return {
    kernel: async (options) => {
      // This fake tests orchestration contract only. It is NOT a live Qwen/Mistral run.
      const state = await runAgentKernel({ ...options, thinker: fixtureThinker });
      if (!state.assessment) throw new Error("FIXTURE_ASSESSMENT_MISSING");
      state.assessment.modelInvocations = ["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"]
        .map((role) => ({
          role: role as "ROUTER" | "PRIMARY" | "VALIDATOR" | "ADJUDICATOR",
          model: role === "VALIDATOR" ? "mistral-nemo:latest" : role === "PRIMARY" ? "qwen3:4b" : "qwen3:1.7b",
          durationMs: 0,
          structuredOutput: true as const,
          schemaValid: true as const,
        }));
      return state;
    },
    metadata: async (_url, model) => ({
      model, digest: "a".repeat(64), size: 1024,
    }),
    model: async () => JSON.stringify(proposal),
  };
}

test("only the strict additive, evidence-backed Terraform proposal is allowed", () => {
  const reviewed = reviewAwsTerraformProposals(
    JSON.stringify(proposal), JSON.stringify(proposal),
    ["aws.organizations", "aws.control_tower"],
  );
  const terraform = renderAwsTerraformCandidate(reviewed);
  assert.match(terraform, /aws_cloudwatch_log_group/);
  assert.match(terraform, /retention_in_days = 30/);
  assert.doesNotMatch(terraform, /terraform apply|terraform destroy|aws_organizations_/);
});

test("untrusted model output cannot add HCL, permissions or arbitrary resources", () => {
  const invalid = [
    { ...proposal, action: "UPDATE" },
    { ...proposal, resourceType: "aws_iam_role" },
    { ...proposal, retentionDays: 0 },
    { ...proposal, name: "/customer/existing" },
    { ...proposal, ownership: "ADOPT_EXISTING" },
    { ...proposal, evidenceRefs: ["fake-evidence"] },
    { ...proposal, terraform: "resource \"aws_iam_role\" \"admin\" {}" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => reviewAwsTerraformProposals(JSON.stringify(value),
        JSON.stringify(proposal), ["aws.organizations", "aws.control_tower"]),
      undefined,
      JSON.stringify(value),
    );
  }
});

test("independent model disagreement stops before candidate output", () => {
  const contradictory = { ...proposal, retentionDays: 90 };
  assert.throws(
    () => reviewAwsTerraformProposals(
      JSON.stringify(proposal), JSON.stringify(contradictory),
      ["aws.organizations", "aws.control_tower"],
    ),
  );
});

test("injected offline doubles exercise evidence output without asserting live models", async () => {
  const root = mkdtempSync(join(tmpdir(), "alz-aws-tf-offline-"));
  try {
    const result = await qualifyAwsTerraformAgents({
      sourceCommit: "a".repeat(40), outputRoot: root,
    }, testDeps());
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.terraformPlan, "NOT_RUN");
    assert.equal(result.terraformValidation, "NOT_RUN");
    assert.equal(result.approval, "NOT_GRANTED");
    assert.equal(result.infrastructureAct, "DISABLED");
    assert.equal(result.mutationObserved, false);
    assert.equal(result.modelEvidence.length, 3);
    assert.equal(result.artifactHash.length, 64);
    const candidate = readFileSync(result.artifactPath, "utf8");
    assert.match(candidate, /aws_cloudwatch_log_group/);
    const stored = JSON.parse(readFileSync(result.evidencePath, "utf8")) as {
      artifactHash: string; sourceCommit: string;
    };
    assert.equal(stored.artifactHash, result.artifactHash);
    assert.equal(stored.sourceCommit, "a".repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing model weights/digest is blocked before asset generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "alz-aws-tf-no-model-"));
  try {
    const deps = testDeps();
    deps.metadata = async (_url, model) => ({ model, digest: "", size: 1024 });
    await assert.rejects(() => qualifyAwsTerraformAgents({
      sourceCommit: "a".repeat(40), outputRoot: root,
    }, deps), /MODEL_DIGEST_UNVERIFIED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed independent primary assessment blocks Build candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "alz-aws-tf-no-assessment-"));
  try {
    const deps = testDeps();
    deps.kernel = async (options) => {
      const state = await runAgentKernel({ ...options, thinker: fixtureThinker });
      if (!state.assessment) throw new Error("FIXTURE_MISSING");
      state.assessment.status = "ABSTAIN";
      return state;
    };
    await assert.rejects(() => qualifyAwsTerraformAgents({
      sourceCommit: "a".repeat(40), outputRoot: root,
    }, deps), /INDEPENDENT_AGENT_ASSESSMENT_NOT_VERIFIED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scenario identity and source binding fail closed", async () => {
  const deps = testDeps();
  await assert.rejects(() => qualifyAwsTerraformAgents({
    sourceCommit: "UNKNOWN", outputRoot: tmpdir(),
  }, deps), /RELEASE_SOURCE_COMMIT_REQUIRED/);
});
