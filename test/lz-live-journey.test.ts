import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { journeyVisualization, runLzLiveJourney, validateJourneyInput, type JourneyInput } from "../src/qualification/lz-live-journey.js";
import type { AgentState } from "../src/agent/types.js";
import type { ToolResult } from "../src/tools/types.js";

const ACCOUNT = "123456789012";
const SHA = "a".repeat(40);
const ok = (tool: ToolResult["tool"], stdout = "{}"): ToolResult =>
  ({ tool, ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 });

function setup(engine: "TERRAFORM" | "AWS_CDK" = "TERRAFORM") {
  const workspace = mkdtempSync(join(process.cwd(), "lz-journey-test-"));
  const out = mkdtempSync(join(tmpdir(), "alz-lz-journey-"));
  const cleanup = () => { rmSync(workspace, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); };
  const input: JourneyInput = {
    instruction: "Design a governed AWS landing zone preview with additive resources.",
    engine, expectedAccount: ACCOUNT, region: "us-east-2",
    workspace: relative(process.cwd(), workspace), sourceCommit: SHA, outputRoot: out,
    allowProjectCodeExecution: true, allowPreviewWrite: engine === "AWS_CDK",
    ...(engine === "AWS_CDK" ? { stack: "ExistingDevStack" } : {}),
  };
  if (engine === "TERRAFORM") writeFileSync(join(workspace, ".terraform.lock.hcl"), "provider lock");
  else {
    mkdirSync(join(workspace, ".runs/cdk/synth"), { recursive: true });
    writeFileSync(join(workspace, ".runs/cdk/synth/manifest.json"),
      JSON.stringify({ artifacts: { ExistingDevStack: { type: "aws:cloudformation:stack",
        properties: { templateFile: "ExistingDevStack.template.json" } } } }));
    writeFileSync(join(workspace, ".runs/cdk/synth/ExistingDevStack.template.json"),
      '{"Resources":{"Log":{"Type":"AWS::Logs::LogGroup"}}}');
  }
  return { workspace, out, input, cleanup };
}

function state(engine: "TERRAFORM" | "AWS_CDK"): AgentState {
  const models = [
    ["ROUTER", "qwen3:1.7b"], ["PRIMARY", "qwen3:4b"],
    ["VALIDATOR", "mistral-nemo:12b"], ["ADJUDICATOR", "qwen3:1.7b"],
  ];
  return {
    provider: "AWS", engine, phase: "COMPLETE",
    assessment: {
      status: "OK", primary: { topRisk: "x" }, validator: { topRisk: "x" },
      modelInvocations: models.map(([role, model]) => ({ role, model, schemaValid: true })),
    },
    design: { status: "REVIEW_REQUIRED", designHash: "b".repeat(64),
      policies: { bundleHash: "c".repeat(64) } },
    environment: {
      resources: [
        { resourceId: "aws:account:" + ACCOUNT, resourceType: "AWS::Organizations::Account",
          ownership: "MANAGED_BY_CUSTOMER", mutationPolicy: "READ_ONLY" },
        { resourceId: "aws:vpc:vpc-test", resourceType: "AWS::EC2::VPC",
          ownership: "MANAGED_BY_CUSTOMER", mutationPolicy: "READ_ONLY" },
      ],
      evidence: [{ key: "aws.identity", source: "aws-cli" },
        { key: "aws.organizations", source: "aws-cli" },
        { key: "aws.control_tower", source: "aws-cli" }],
      warnings: [],
    },
    action: { executed: false }, observation: { mutationObserved: false },
    orchestration: { actEnabled: false },
  } as unknown as AgentState;
}

function depsFor(engine: "TERRAFORM" | "AWS_CDK", workspace: string,
  opts: { changedAccount?: string; update?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      metadata: async (_: string, tag: string) => ({ model: tag, digest: "d".repeat(64), size: 1024 }),
      agent: async () => { calls.push("agent"); return state(engine); },
      governed: async (request: {tool: string}) => {
        calls.push(request.tool);
        if (request.tool === "aws_sts_identity")
          return ok("aws_sts_identity", JSON.stringify({
            Account: opts.changedAccount ?? ACCOUNT,
            Arn: "arn:aws:sts::" + (opts.changedAccount ?? ACCOUNT) + ":assumed-role/qualify/agent",
          }));
        if (request.tool === "terraform_plan") {
          writeFileSync(join(workspace, ".agentic-preview.tfplan"), "binary sensitive plan");
          return ok("terraform_plan");
        }
        if (request.tool === "terraform_validate") return [
          ok("terraform_fmt_check"), ok("terraform_validate", '{"valid":true,"error_count":0}')];
        if (request.tool === "cdk_synth") return [ok("cdk_synth")];
        if (request.tool === "cdk_preview") return ok("cdk_preview", JSON.stringify({
          Status: "CREATE_COMPLETE", Changes: [{ ResourceChange: { Action: opts.update ? "Modify" : "Add",
            ResourceType: "AWS::Logs::LogGroup" } }],
        }));
        if (request.tool === "terraform_version" || request.tool === "cdk_version")
          return ok(request.tool, "1.0.0");
        throw Error("UNEXPECTED_TOOL");
      },
      localTerraformShow: () => ok("terraform_plan", JSON.stringify({
        resource_changes: [{ type: "aws_cloudwatch_log_group", address: "aws_cloudwatch_log_group.test",
          change: { actions: opts.update ? ["update"] : ["create"] } }],
      })),
    },
  };
}

async function withIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("ALZ_DISCOVERY_")));
  for (const key of Object.keys(old)) delete process.env[key];
  process.env.ALZ_DISCOVERY_AWS_REGION = "us-east-2";
  process.env.ALZ_DISCOVERY_AWS_ROLE_ARN = "arn:aws:iam::" + ACCOUNT + ":role/qualify";
  process.env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE = "/tmp/non-real-token-test";
  try { return await fn(); }
  finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("ALZ_DISCOVERY_")) delete process.env[key];
    Object.assign(process.env, old);
  }
}

test("Terraform runs live-model and real-tool interfaces but never ACT or apply", async () => {
  const x = setup();
  try {
    await withIdentity(async () => {
      const { calls, deps } = depsFor("TERRAFORM", x.workspace);
      const result = await runLzLiveJourney(x.input, deps as never);
      assert.equal(result.status, "REVIEW_REQUIRED");
      assert.equal(result.actSnapshot.authorization, "NOT_GRANTED");
      assert.equal(result.releaseAdmission, "HOLD");
      assert.equal(result.inventory.length, 2);
      assert.equal(result.proposedChanges[0]?.action, "CREATE");
      assert.ok(result.provenance.nativePlanHash);
      assert.deepEqual(calls, ["aws_sts_identity", "agent", "aws_sts_identity", "terraform_version",
        "terraform_validate", "aws_sts_identity", "terraform_plan", "aws_sts_identity"]);
      assert.equal(result.identity?.principalReference, "arn:aws:sts::" + ACCOUNT + ":assumed-role/qualify/agent");
      assert.ok(!calls.some(x => /apply|destroy|execute-change-set/.test(x)));
    });
  } finally { x.cleanup(); }
});

test("CDK preview requires explicit capability and records native Change Set", async () => {
  const x = setup("AWS_CDK");
  try {
    assert.throws(() => validateJourneyInput({ ...x.input, allowPreviewWrite: false }),
      /CDK_PREVIEW_WRITE_AND_STACK_REQUIRED/);
    await withIdentity(async () => {
      const { deps } = depsFor("AWS_CDK", x.workspace);
      const result = await runLzLiveJourney(x.input, deps as never);
      assert.equal(result.status, "REVIEW_REQUIRED");
      assert.equal(result.proposedChanges[0]?.type, "AWS::Logs::LogGroup");
      assert.equal(result.actSnapshot.executed, false);
    });
  } finally { x.cleanup(); }
});

test("target mismatch blocks before model execution", async () => {
  const x = setup();
  try {
    await withIdentity(async () => {
      const { deps, calls } = depsFor("TERRAFORM", x.workspace, { changedAccount: "999999999999" });
      const result = await runLzLiveJourney(x.input, deps as never);
      assert.equal(result.status, "BLOCKED");
      assert.deepEqual(calls, ["aws_sts_identity"]);
      assert.equal(result.stages.at(-1)?.reason, "AWS_ACCOUNT_OR_ROLE_MISMATCH");
    });
  } finally { x.cleanup(); }
});

test("native UPDATE blocks additive-only qualification for both engines", async () => {
  for (const engine of ["TERRAFORM", "AWS_CDK"] as const) {
    const x = setup(engine);
    try {
      await withIdentity(async () => {
        const { deps } = depsFor(engine, x.workspace, { update: true });
        const result = await runLzLiveJourney(x.input, deps as never);
        assert.equal(result.status, "BLOCKED");
        assert.equal(result.actSnapshot.authorization, "NOT_GRANTED");
      });
    } finally { x.cleanup(); }
  }
});

test("mutation instruction and workspace traversal are denied before execution", () => {
  const x = setup();
  try {
    assert.throws(() => validateJourneyInput({ ...x.input, instruction: "Deploy this design now" }),
      /PREVIEW_ONLY_DESIGN_INSTRUCTION_REQUIRED/);
    assert.throws(() => validateJourneyInput({ ...x.input, workspace: "../../" }),
      /PROJECT_OUTSIDE_REVIEWED_SOURCE/);
  } finally { x.cleanup(); }
});

test("HTML escapes untrusted content", () => {
  const html = journeyVisualization({
    id: "<script>", sourceCommit: SHA, engine: "TERRAFORM",
    status: "BLOCKED", inventory: [{ idHash: "abcd", type: "<script>", ownership: "UNKNOWN",
      mutationPolicy: "READ_ONLY" }], proposedChanges: [], stages: [], 
  } as never);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("conflicting regions and injected credential fallbacks block before any tool", async () => {
  const cases = [
    ["ALZ_DISCOVERY_AWS_DEFAULT_REGION", "us-west-2", "DISCOVERY_REGION_IDENTITY_REQUIRED"],
    ["ALZ_DISCOVERY_AWS_REGION", "us-west-2", "DISCOVERY_REGION_IDENTITY_REQUIRED"],
    ...["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
      "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"].map(name =>
      ["ALZ_DISCOVERY_" + name, "secret-fallback-canary", "DISCOVERY_CREDENTIAL_FALLBACK_FORBIDDEN"]),
    ["ALZ_DISCOVERY_AWS_ROLE_ARN", "arn:aws:iam::999999999999:role/qualify", "DISCOVERY_OIDC_IDENTITY_REQUIRED"],
    ["ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE", "", "DISCOVERY_OIDC_IDENTITY_REQUIRED"],
  ];
  for (const [key, value, reason] of cases) {
    const x = setup();
    try {
      await withIdentity(async () => {
        // A matching default must not hide a conflicting primary region.
        process.env.ALZ_DISCOVERY_AWS_DEFAULT_REGION = "us-east-2";
        process.env[key!] = value;
        const { deps, calls } = depsFor("TERRAFORM", x.workspace);
        const report = await runLzLiveJourney(x.input, deps as never);
        assert.equal(report.status, "BLOCKED", key);
        assert.equal(report.stages.at(-1)?.reason, reason, key);
        assert.deepEqual(calls, [], key);
        assert.ok(!readFileSync(report.evidencePath, "utf8").includes("secret-fallback-canary"));
      });
    } finally { x.cleanup(); }
  }
});

test("STS must match the configured role and retain the same session through preview", async () => {
  for (const changedAt of [1, 2, 3, 4]) {
    const x = setup();
    try {
      await withIdentity(async () => {
        const { deps, calls } = depsFor("TERRAFORM", x.workspace);
        const governed = deps.governed;
        let identities = 0;
        deps.governed = async request => {
          if (request.tool === "aws_sts_identity" && ++identities === changedAt) {
            calls.push(request.tool);
            return ok("aws_sts_identity", JSON.stringify({ Account: ACCOUNT,
              Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${changedAt === 1 ? "wrong-role" : "qualify"}/new-session` }));
          }
          return governed(request);
        };
        const report = await runLzLiveJourney(x.input, deps as never);
        assert.equal(report.status, "BLOCKED");
        assert.equal(report.stages.at(-1)?.reason, changedAt === 1 ? "AWS_ACCOUNT_OR_ROLE_MISMATCH" : "AWS_PRINCIPAL_CHANGED");
        assert.equal(report.releaseAdmission, "HOLD");
        if (changedAt === 1) assert.ok(!calls.includes("agent"));
        if (changedAt < 4) assert.ok(!calls.includes("terraform_plan"));
      });
    } finally { x.cleanup(); }
  }
});

test("identity configuration changes during model execution block project code", async () => {
  const x = setup();
  try {
    await withIdentity(async () => {
      const { deps, calls } = depsFor("TERRAFORM", x.workspace);
      deps.agent = async () => {
        process.env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE = "/tmp/replaced-token";
        return state("TERRAFORM");
      };
      const report = await runLzLiveJourney(x.input, deps as never);
      assert.equal(report.stages.at(-1)?.reason, "DISCOVERY_IDENTITY_CHANGED");
      assert.ok(!calls.includes("terraform_validate"));
      assert.ok(!readFileSync(report.evidencePath, "utf8").includes("replaced-token"));
    });
  } finally { x.cleanup(); }
});

test("model digest replacement, skipped validator, ABSTAIN and partial discovery block previews", async () => {
  for (const failure of ["digest", "validator", "abstain", "partial"] as const) {
    const x = setup();
    try {
      await withIdentity(async () => {
        const { deps, calls } = depsFor("TERRAFORM", x.workspace);
        let metadataCalls = 0;
        deps.metadata = async (_, tag) => ({ model: tag, size: 1024,
          digest: (failure === "digest" && ++metadataCalls > 3 ? "e" : "d").repeat(64) });
        deps.agent = async () => {
          const result = state("TERRAFORM");
          if (failure === "validator") result.assessment!.modelInvocations = result.assessment!.modelInvocations!.filter(x => x.role !== "VALIDATOR");
          if (failure === "abstain") result.assessment!.status = "ABSTAIN";
          if (failure === "partial") result.environment!.warnings.push("DISCOVERY_PARTIAL: probe failed");
          return result;
        };
        const report = await runLzLiveJourney(x.input, deps as never);
        assert.equal(report.status, "BLOCKED", failure);
        assert.ok(!calls.includes("terraform_plan"), failure);
      });
    } finally { x.cleanup(); }
  }
});

test("plan or lock replacement during show and truncated JSON never produce accepted evidence", async () => {
  for (const failure of ["plan", "lock", "truncated", "missing"] as const) {
    const x = setup();
    try {
      await withIdentity(async () => {
        const { deps } = depsFor("TERRAFORM", x.workspace);
        const show = deps.localTerraformShow;
        deps.localTerraformShow = () => {
          const result = show();
          if (failure === "plan") writeFileSync(join(x.workspace, ".agentic-preview.tfplan"), "replacement");
          if (failure === "lock") writeFileSync(join(x.workspace, ".terraform.lock.hcl"), "replacement");
          if (failure === "truncated") result.truncated = true;
          if (failure === "missing") rmSync(join(x.workspace, ".agentic-preview.tfplan"));
          return result;
        };
        const report = await runLzLiveJourney(x.input, deps as never);
        assert.equal(report.status, "BLOCKED", failure);
        assert.equal(report.provenance.nativePlanHash, undefined, failure);
        assert.equal(report.actSnapshot.candidatePlanHash, undefined, failure);
      });
    } finally { x.cleanup(); }
  }
});

test("CDK cleanup failure is BLOCKED even when a Change Set was described", async () => {
  const x = setup("AWS_CDK");
  try {
    await withIdentity(async () => {
      const { deps } = depsFor("AWS_CDK", x.workspace);
      const governed = deps.governed;
      deps.governed = async request => {
        const result = await governed(request);
        return request.tool === "cdk_preview" ? { ...result as ToolResult, ok: false,
          stderr: "cleanup failed", exitCode: 1 } : result;
      };
      const report = await runLzLiveJourney(x.input, deps as never);
      assert.equal(report.status, "BLOCKED");
      assert.equal(report.stages.at(-1)?.reason, "NATIVE_PREVIEW_FAILED");
      assert.equal(report.actSnapshot.executed, false);
    });
  } finally { x.cleanup(); }
});
