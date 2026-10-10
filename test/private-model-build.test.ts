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

// --- Traceable teardown opt-in (docs/teardown-traceability.md) -------------
import { readTerraformPlanTags } from "../src/teardown/gates.js";
import type { DeletionUnitStateRef } from "../src/teardown/types.js";
import { renderAwsTerraformCandidate, reviewAwsTerraformProposals } from "../src/qualification/aws-terraform-agent.js";

const S3_STATE: DeletionUnitStateRef = {
  engine: "TERRAFORM", backend: "s3",
  location: "s3://alz-state/builds/private/terraform.tfstate", workspace: "default",
};

/** Tags exactly as the HCL text declares them, shaped like a `show -json` plan. */
function planTagsFromHcl(hcl: string): Array<{ address: string; tags: PlannedTags }> {
  const block = /tags = \{\n([\s\S]*?)\n\s*\}/.exec(hcl)?.[1] ?? "";
  const tags: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^\s+"?([A-Za-z-]+)"?\s+= "([^"]*)"$/.exec(line);
    if (match) tags[match[1]] = match[2];
  }
  const plan = JSON.stringify({ resource_changes: [{
    address: "aws_cloudwatch_log_group.alz_audit",
    change: { actions: ["create"], after: { tags_all: tags } },
  }] });
  return [...readTerraformPlanTags(plan)].map(([address, planned]) => ({ address, tags: planned }));
}
import type { PlannedTags } from "../src/teardown/types.js";

function unitDeps(overrides: Partial<RealPrivateBuildDeps> = {}, hclSink?: { hcl?: string }) {
  const base = deps();
  return {
    ...base,
    deletionUnitState: S3_STATE,
    validate: async (hcl: string) => {
      if (hclSink) hclSink.hcl = hcl;
      return { ...(await base.validate(hcl)), plannedTags: planTagsFromHcl(hcl) };
    },
    ...overrides,
  } satisfies RealPrivateBuildDeps;
}

test("without the opt-in the candidate, its hash and the result are exactly as before", async () => {
  const state = await reviewedState();
  const sink: { hcl?: string } = {};
  const base = deps();
  const built = await runRealPrivateModelBuild(state, {
    ...base, validate: async (hcl) => { sink.hcl = hcl; return base.validate(hcl); },
  });
  const reviewed = reviewAwsTerraformProposals(JSON.stringify(proposal), JSON.stringify(proposal),
    ["aws.identity"]);
  assert.equal(sink.hcl, renderAwsTerraformCandidate(reviewed));
  assert.equal(built.candidate.artifact.contentHash, sha256(renderAwsTerraformCandidate(reviewed)));
  assert.match(sink.hcl!, /\n {4}ManagedBy = "ALZ-preview-candidate"\n {2}\}/);
  assert.doesNotMatch(sink.hcl!, /alz-/);
  assert.equal("deletionUnit" in built, false);
  assert.doesNotMatch(built.previewSummary, /deletionUnit/);
});

test("opt-in stamps the unit's tags into the candidate and records the unit on the result", async () => {
  const sink: { hcl?: string } = {};
  const built = await runRealPrivateModelBuild(await reviewedState(), unitDeps({}, sink));
  const unit = built.deletionUnit;
  assert.ok(unit, "deletion unit recorded");
  assert.equal(unit.buildId, built.candidate.id);
  assert.equal(unit.designHash, built.candidate.evidence.designHash);
  assert.deepEqual(unit.plannedCreates, ["aws_cloudwatch_log_group.alz_audit"]);
  assert.equal(unit.createChangeSetHash, "d".repeat(64));
  assert.deepEqual(unit.stateRef, S3_STATE);
  // The artifact that was hashed and validated is the tagged one.
  assert.equal(built.candidate.artifact.contentHash, sha256(sink.hcl!));
  for (const [key, value] of Object.entries(unit.tags)) {
    assert.ok(sink.hcl!.includes(`"${key}"`) && sink.hcl!.includes(`"${value}"`), key);
  }
  const summary = JSON.parse(built.previewSummary) as Record<string, unknown>;
  assert.equal(summary.deletionUnitId, unit.unitId);
  assert.equal(summary.deletionUnitHash, unit.unitHash);
  // Opting in changes nothing about approval or mutation authority.
  assert.equal(built.gate.allowed, false);
  assert.equal(built.executionMode, "PREVIEW_ONLY");
});

test("opt-in fails closed when the driver cannot prove the plan's tags", async () => {
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), unitDeps({
    validate: async (hcl) => deps().validate(hcl), // no plannedTags reported
  })), /TEARDOWN_PLAN_TAGS_NOT_REPORTED/);

  const untagged = unitDeps({}, undefined);
  const base = deps();
  untagged.validate = async (hcl) => ({ ...(await base.validate(hcl)), plannedTags: [{
    address: "aws_cloudwatch_log_group.alz_audit",
    tags: { kind: "TAGGED" as const, tags: { ManagedBy: "ALZ-preview-candidate" } },
  }] });
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), untagged),
    /TEARDOWN_TRACEABILITY:.*UNTAGGED_CREATE/);

  const computed = unitDeps({});
  computed.validate = async (hcl) => ({ ...(await base.validate(hcl)), plannedTags: [{
    address: "aws_cloudwatch_log_group.alz_audit", tags: { kind: "UNKNOWN_AT_PLAN" as const },
  }] });
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), computed),
    /TEARDOWN_TRACEABILITY:.*TAGS_UNKNOWN_AT_PLAN/);
});

test("opt-in refuses non-durable state and a mismatched state reference before any model call", async () => {
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), unitDeps({
    deletionUnitState: { engine: "TERRAFORM", backend: "local",
      location: "./terraform.tfstate", workspace: "default" },
  })), /TEARDOWN_TRACEABILITY:.*STATE_NOT_DURABLE/);

  let modelCalls = 0;
  const counting = unitDeps({
    deletionUnitState: { engine: "PULUMI", backendUrl: "s3://x", stack: "dev" },
    model: async () => { modelCalls += 1; return JSON.stringify(proposal); },
  });
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(), counting),
    /TEARDOWN_STATE_REF_ENGINE/);
  assert.equal(modelCalls, 0);
});

test("an expiry tag is stamped only when asked for and must be an ISO date", async () => {
  const sink: { hcl?: string } = {};
  const built = await runRealPrivateModelBuild(await reviewedState(),
    unitDeps({ deletionUnitExpires: "2026-12-31" }, sink));
  assert.equal(built.deletionUnit!.tags["alz-expires"], "2026-12-31");
  assert.match(sink.hcl!, /"alz-expires" += "2026-12-31"/);
  // `terraform fmt -check` (run by the real driver) wants one `=` column in the map.
  const block = /tags = \{\n([\s\S]*?)\n {2}\}/.exec(sink.hcl!)![1].split("\n");
  assert.equal(block.length, 5);
  assert.equal(new Set(block.map((line) => line.indexOf(" = "))).size, 1, block.join("\n"));
  await assert.rejects(runRealPrivateModelBuild(await reviewedState(),
    unitDeps({ deletionUnitExpires: "someday" })), /EXPIRES_NOT_ISO_DATE/);
});
