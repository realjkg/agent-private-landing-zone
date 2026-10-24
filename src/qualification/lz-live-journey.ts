import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { runAgentKernel } from "../agent/graph.js";
import type { AgentState } from "../agent/types.js";
import { loadConfig } from "../config.js";
import { assessNativeAwsPlan, type NativePlan } from "../integrations/ai-studio/aws-native-plan.js";
import type { GovernanceEvidence } from "../integrations/ai-studio/aws-governance.js";
import { getLocalModelMetadata } from "../ollama.js";
import { screenOperatorPrompt } from "../security/prompt-governance.js";
import { classifyIntent } from "../agent/intent.js";
import { runGovernedTool } from "../tools/governed.js";
import { runAllowlistedProcess } from "../tools/process.js";
import type { ToolRequest, ToolResult } from "../tools/types.js";

/**
 * A trusted operator-side evidence workflow, never an ACT execution entry point.
 * The models reason through runAgentKernel; only reviewed deterministic tools
 * access AWS and engine-native previews. Evidence remains unapproved.
 */
export type JourneyEngine = "TERRAFORM" | "AWS_CDK";
export type JourneyInput = {
  instruction: string;
  engine: JourneyEngine;
  expectedAccount: string;
  region: string;
  workspace: string;
  sourceCommit: string;
  outputRoot: string;
  allowProjectCodeExecution: boolean;
  allowPreviewWrite: boolean;
  stack?: string;
};

export type Stage = "identity" | "models" | "discovery" | "design" | "inventory" |
  "governance" | "native_preview" | "act_boundary";
export type StageRecord = { stage: Stage; status: "OBSERVED" | "BLOCKED"; evidenceHash?: string; reason?: string };
export type JourneyReport = {
  schema: 1;
  id: string;
  sourceCommit: string;
  engine: JourneyEngine;
  target: { account: string; region: string; stack?: string };
  startedAt: string;
  completedAt?: string;
  stages: StageRecord[];
  modelDigests: Array<{ role: string; tag: string; digest: string }>;
  inventory: Array<{ idHash: string; type: string; ownership: string; mutationPolicy: string }>;
  provenance: { designHash?: string; policyHash?: string; toolVersionHash?: string; lockOrAssemblyHash?: string; synthesizedTemplateHash?: string; binaryPlanHash?: string; nativePlanHash?: string };
  proposedChanges: Array<{ type: string; action: string; governance: string }>;
  actSnapshot: { infrastructureAct: "DISABLED"; executed: false; mutationObserved: false; authorization: "NOT_GRANTED"; previewControlPlaneWrite: boolean; candidatePlanHash?: string };
  status: "REVIEW_REQUIRED" | "BLOCKED";
  releaseAdmission: "HOLD";
  evidencePath: string;
  visualizationPath: string;
};

type Deps = {
  agent: typeof runAgentKernel;
  metadata: typeof getLocalModelMetadata;
  governed: typeof runGovernedTool;
  localTerraformShow: (cwd: string) => ToolResult;
};
const defaults: Deps = {
  agent: runAgentKernel,
  metadata: getLocalModelMetadata,
  governed: runGovernedTool,
  localTerraformShow: (cwd) => runAllowlistedProcess(
    "terraform_plan", "terraform", ["show", "-json", ".agentic-preview.tfplan"], cwd),
};

function requireGate(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function readableFile(path: string, root: string): string {
  const full = realpathSync(path);
  const rel = relative(realpathSync(root), full);
  requireGate(rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel),
    "ARTIFACT_PATH_ESCAPES_WORKSPACE");
  requireGate(statSync(full).isFile() && statSync(full).size <= 32 * 1024 * 1024,
    "ARTIFACT_INVALID_OR_OVERSIZED");
  return full;
}
function checkedResult(result: ToolResult | ToolResult[], code: string): ToolResult {
  const items = Array.isArray(result) ? result : [result];
  requireGate(items.length > 0 && items.every((x) => x.ok && !x.truncated && !x.blocked),
    code);
  return items[items.length - 1]!;
}
function stage(report: JourneyReport, key: Stage, value: unknown): void {
  report.stages.push({ stage: key, status: "OBSERVED", evidenceHash: hash(JSON.stringify(value)) });
}
function htmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
export function journeyVisualization(report: JourneyReport): string {
  const rows = report.stages.map((s) => `<tr><td>${htmlEscape(s.stage)}</td><td>${s.status}</td><td>${htmlEscape(s.evidenceHash ?? s.reason ?? "")}</td></tr>`).join("");
  const resourceRows = report.inventory.map((r) =>
    `<tr><td>${htmlEscape(r.type)}</td><td>${htmlEscape(r.ownership)}</td><td>${htmlEscape(r.mutationPolicy)}</td><td>${r.idHash.slice(0, 12)}</td></tr>`).join("");
  const changes = report.proposedChanges.map((r) =>
    `<tr><td>${htmlEscape(r.type)}</td><td>${htmlEscape(r.action)}</td><td>${htmlEscape(r.governance)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sovereign LZ journey</title>
  <h1>Sovereign Landing Zone — evidence journey</h1><p>Release HOLD · ACT DISABLED · Authorization NOT_GRANTED</p>
  <p>Engine: ${htmlEscape(report.engine)} · Status: ${htmlEscape(report.status)} · Run: ${htmlEscape(report.id)}</p>
  <h2>Execution stages</h2><table border="1"><tr><th>Stage</th><th>Status</th><th>Evidence SHA-256 / reason</th></tr>${rows}</table>
  <h2>Discovered inventory</h2><table border="1"><tr><th>Type</th><th>Ownership</th><th>Policy</th><th>Resource fingerprint</th></tr>${resourceRows}</table>
  <h2>Native preview changes</h2><table border="1"><tr><th>Resource type</th><th>Action</th><th>Governance</th></tr>${changes}</table>
  <p>Evidence is not production admission. No infrastructure ACT or approval was performed.</p></html>`;
}

/** Fail before invoking any private model, provider or project code. */
export function validateJourneyInput(input: JourneyInput, root = process.cwd()): string {
  requireGate(input.engine === "TERRAFORM" || input.engine === "AWS_CDK", "ENGINE_NOT_SUPPORTED");
  requireGate(/^[a-f0-9]{40}$/i.test(input.sourceCommit), "SOURCE_SHA_INVALID");
  requireGate(/^\d{12}$/.test(input.expectedAccount), "TARGET_ACCOUNT_INVALID");
  requireGate(/^[a-z]{2}-[a-z]+-\d$/.test(input.region), "REGION_INVALID");
  requireGate(input.allowProjectCodeExecution === true, "PROJECT_CODE_EXECUTION_NOT_AUTHORIZED");
  requireGate(input.engine !== "AWS_CDK" || (input.allowPreviewWrite === true &&
    typeof input.stack === "string" && /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(input.stack)),
    "CDK_PREVIEW_WRITE_AND_STACK_REQUIRED");
  requireGate(input.engine !== "TERRAFORM" || !input.allowPreviewWrite,
    "TERRAFORM_PREVIEW_WRITE_NOT_REQUIRED");
  requireGate(input.instruction.length > 0 && input.instruction.length <= 2000 &&
    classifyIntent(input.instruction) === "DESIGN" &&
    screenOperatorPrompt(input.instruction).allowed, "PREVIEW_ONLY_DESIGN_INSTRUCTION_REQUIRED");
  const base = realpathSync(root);
  const cwd = realpathSync(resolve(base, input.workspace));
  const rel = relative(base, cwd);
  requireGate(rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel) &&
    !rel.startsWith(".runs" + sep) && rel !== ".runs", "PROJECT_OUTSIDE_REVIEWED_SOURCE");
  requireGate(statSync(cwd).isDirectory(), "PROJECT_DIRECTORY_REQUIRED");
  return cwd;
}

function verifiedAgent(state: AgentState, engine: JourneyEngine, account: string): void {
  requireGate(state.provider === "AWS" && state.engine === engine && !state.mock &&
    state.phase === "COMPLETE" && !state.error, "AGENT_DESIGN_NOT_COMPLETE");
  requireGate(state.assessment?.status === "OK" && state.assessment.primary &&
    state.assessment.validator && state.design && state.design.status !== "BLOCKED",
    "MODEL_OR_DESIGN_NOT_VERIFIED");
  const roles = state.assessment.modelInvocations ?? [];
  for (const role of ["ROUTER", "PRIMARY", "VALIDATOR", "ADJUDICATOR"]) {
    requireGate(roles.some((x) => x.role === role && x.schemaValid), "MODEL_ROLE_MISSING:" + role);
  }
  requireGate(state.environment?.evidence.some((e) => e.key === "aws.identity" && e.source === "aws-cli") &&
    state.environment.resources.some((r) => r.resourceId === "aws:account:" + account) &&
    state.environment.evidence.every((e) => e.source !== "mock") &&
    state.environment.resources.length > 0, "LIVE_DISCOVERY_IDENTITY_NOT_ATTESTED");
  requireGate(state.action?.executed === false &&
    state.observation?.mutationObserved === false &&
    state.orchestration?.actEnabled === false, "ACT_OR_MUTATION_BOUNDARY_FAILED");
}

function previewActions(plan: NativePlan, governance: GovernanceEvidence): Array<{
  type: string; action: string; governance: string;
}> {
  const decision = assessNativeAwsPlan(plan, governance);
  requireGate(decision.allowed, "NATIVE_GOVERNANCE_POLICY_BLOCKED:" + decision.reasons.join(","));
  requireGate(decision.findings.length > 0 &&
    decision.findings.every((x) => x.action === "CREATE" &&
      x.verdict === "APPLICATION_CHANGE"), "PREVIEW_NOT_ADDITIVE_ONLY");
  return decision.findings.map((x) => ({ type: x.resourceType, action: x.action, governance: x.verdict }));
}

/**
 * Execute only if explicit operator capability and real project + AWS identity
 * are present. A successful return is REVIEW_REQUIRED, never authority for ACT.
 */
export async function runLzLiveJourney(input: JourneyInput, deps: Deps = defaults): Promise<JourneyReport> {
  const cwd = validateJourneyInput(input);
  const runId = randomUUID();
  const out = resolve(input.outputRoot, runId);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const evidencePath = join(out, "journey.json");
  const visualizationPath = join(out, "inventory.html");
  const report: JourneyReport = {
    schema: 1, id: runId, sourceCommit: input.sourceCommit, engine: input.engine,
    target: { account: input.expectedAccount, region: input.region, ...(input.stack ? { stack: input.stack } : {}) },
    startedAt: new Date().toISOString(), stages: [], modelDigests: [], inventory: [],
    provenance: {}, proposedChanges: [],
    actSnapshot: { infrastructureAct: "DISABLED", executed: false, mutationObserved: false,
      authorization: "NOT_GRANTED", previewControlPlaneWrite: input.engine === "AWS_CDK" },
    status: "BLOCKED", releaseAdmission: "HOLD", evidencePath, visualizationPath,
  };
  const persist = () => {
    report.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(visualizationPath, journeyVisualization(report), { mode: 0o600 });
  };
  try {
    // The child runner accepts identity-scoped ALZ_DISCOVERY_* variables only,
    // not ambient AWS_PROFILE, keys or a model-requested credential.
    requireGate(process.env.ALZ_DISCOVERY_AWS_REGION === input.region ||
      process.env.ALZ_DISCOVERY_AWS_DEFAULT_REGION === input.region,
      "DISCOVERY_REGION_IDENTITY_REQUIRED");
    requireGate(Boolean(process.env.ALZ_DISCOVERY_AWS_ROLE_ARN &&
      process.env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE), "DISCOVERY_OIDC_IDENTITY_REQUIRED");
    const context = { cwd: process.cwd(), allowCloudRead: true, allowMutation: false as const };
    const sts = checkedResult(await deps.governed({ tool: "aws_sts_identity" }, context),
      "AWS_STS_IDENTITY_FAILED");
    const identity = JSON.parse(sts.stdout) as { Account?: string; Arn?: string };
    requireGate(identity.Account === input.expectedAccount &&
      typeof identity.Arn === "string" && identity.Arn.includes(":assumed-role/"),
      "AWS_ACCOUNT_OR_ROLE_MISMATCH");
    stage(report, "identity", { account: identity.Account, arnHash: hash(identity.Arn) });

    const cfg = loadConfig();
    const url = new URL(cfg.ollamaBaseUrl);
    requireGate(url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      cfg.routerModel.startsWith("qwen3:") && cfg.primaryModel.startsWith("qwen3:") &&
      cfg.validatorModel.startsWith("mistral-nemo:") &&
      process.env.AGENT_SKIP_LOCAL_MODEL !== "1", "PRIVATE_MODEL_PROFILE_INVALID");
    for (const [role, tag] of [["ROUTER", cfg.routerModel], ["PRIMARY", cfg.primaryModel],
      ["VALIDATOR", cfg.validatorModel]] as const) {
      const info = await deps.metadata(cfg.ollamaBaseUrl, tag);
      requireGate(/^[a-f0-9]{64}$/i.test(info.digest) && info.size > 0,
        "PRIVATE_MODEL_DIGEST_MISSING:" + role);
      report.modelDigests.push({ role, tag, digest: info.digest });
    }
    stage(report, "models", report.modelDigests);

    const state = await deps.agent({
      request: input.instruction, provider: "AWS", engine: input.engine, approveBuild: false,
    });
    verifiedAgent(state, input.engine, input.expectedAccount);
    for (const call of state.assessment?.modelInvocations ?? []) {
      const tag = call.role === "VALIDATOR" ? cfg.validatorModel :
        call.role === "PRIMARY" ? cfg.primaryModel : cfg.routerModel;
      requireGate(call.model === tag, "MODEL_ROLE_TAG_MISMATCH:" + call.role);
    }
    const env = state.environment!;
    stage(report, "discovery", {
      identityAccount: input.expectedAccount, evidence: env.evidence.map((x) => ({ key: x.key, source: x.source })),
      warnings: env.warnings.map((w) => w.split(":")[0]), resourceCount: env.resources.length,
    });
    report.provenance.designHash = state.design!.designHash;
    report.provenance.policyHash = state.design!.policies.bundleHash;
    stage(report, "design", { designHash: state.design!.designHash, policyHash: report.provenance.policyHash });
    report.inventory = env.resources.map((r) => ({
      idHash: hash(r.resourceId), type: r.resourceType,
      ownership: r.ownership, mutationPolicy: r.mutationPolicy,
    }));
    stage(report, "inventory", report.inventory);
    requireGate(!env.warnings.some((w) => /DISCOVERY_PARTIAL|AWS_IDENTITY_UNAVAILABLE/.test(w)),
      "AWS_DISCOVERY_PARTIAL");
    const governance: GovernanceEvidence = {
      organization: env.evidence.some((e) => e.key === "aws.organizations") ? "EXISTS" : "UNKNOWN",
      landingZone: env.evidence.some((e) => e.key === "aws.control_tower") ? "EXISTS" : "UNKNOWN",
      managementAccountVerified: false,
    };
    requireGate(governance.organization === "EXISTS" && governance.landingZone === "EXISTS",
      "AWS_GOVERNANCE_BASELINE_UNVERIFIED");
    stage(report, "governance", { baseline: governance, policyHash: report.provenance.policyHash });

    const workspace = relative(process.cwd(), cwd);
    const engineTool = input.engine === "TERRAFORM" ? "terraform" : "cdk";
    const version = checkedResult(await deps.governed({
      tool: engineTool === "terraform" ? "terraform_version" : "cdk_version", workspace,
    }, context), "IAC_TOOL_VERSION_FAILED");
    report.provenance.toolVersionHash = hash(version.stdout);
    const validation = checkedResult(await deps.governed({
      tool: engineTool === "terraform" ? "terraform_validate" : "cdk_synth", workspace,
      ...(input.stack ? { input: { stack: input.stack } } : {}),
    }, { ...context, allowProjectCodeExecution: true }), "IAC_VALIDATION_FAILED");
    if (input.engine === "TERRAFORM") {
      const parsed = JSON.parse(validation.stdout) as { valid?: unknown; error_count?: unknown };
      requireGate(parsed.valid === true && parsed.error_count === 0,
        "TERRAFORM_VALIDATION_NOT_VALID");
    }
    const preview = checkedResult(await deps.governed({
      tool: engineTool === "terraform" ? "terraform_plan" : "cdk_preview", workspace,
      ...(input.stack ? { input: { stack: input.stack, stackName: input.stack, changeSetType: "UPDATE" } } : {}),
    }, { ...context, allowProjectCodeExecution: true, allowPreviewWrite: input.allowPreviewWrite }),
    "NATIVE_PREVIEW_FAILED");

    let native: NativePlan;
    if (input.engine === "TERRAFORM") {
      const lock = readableFile(resolve(cwd, ".terraform.lock.hcl"), cwd);
      const planPath = readableFile(resolve(cwd, ".agentic-preview.tfplan"), cwd);
      report.provenance.lockOrAssemblyHash = hash(readFileSync(lock));
      const binaryPlanHash = hash(readFileSync(planPath));
      report.provenance.binaryPlanHash = binaryPlanHash;
      const shown = checkedResult(deps.localTerraformShow(cwd), "TERRAFORM_SHOW_FAILED");
      native = { engine: "TERRAFORM", payload: JSON.parse(shown.stdout) };
      report.provenance.nativePlanHash = hash(shown.stdout);
      // Link the binary plan digest to the native JSON without persisting either
      // sensitive artifact; independent reviewers can inspect protected originals.
      requireGate(/^[a-f0-9]{64}$/.test(binaryPlanHash), "PLAN_BINARY_HASH_INVALID");
    } else {
      const assembly = readableFile(resolve(cwd, ".runs/cdk/synth/manifest.json"), cwd);
      const manifestBytes = readFileSync(assembly);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
        artifacts?: Record<string, { type?: string; properties?: { templateFile?: string } }>;
      };
      const selected = manifest.artifacts?.[input.stack!];
      requireGate(selected?.type === "aws:cloudformation:stack" &&
        typeof selected.properties?.templateFile === "string", "CDK_STACK_ASSEMBLY_NOT_ATTESTED");
      const template = readableFile(resolve(cwd, ".runs/cdk/synth",
        selected.properties!.templateFile!), cwd);
      JSON.parse(readFileSync(template, "utf8"));
      report.provenance.lockOrAssemblyHash = hash(manifestBytes);
      report.provenance.synthesizedTemplateHash = hash(readFileSync(template));
      const described = JSON.parse(preview.stdout) as { Status?: string };
      requireGate(described.Status === "CREATE_COMPLETE", "CDK_CHANGESET_NOT_COMPLETE");
      native = { engine: "CDK", payload: described };
      report.provenance.nativePlanHash = hash(preview.stdout);
    }
    report.proposedChanges = previewActions(native, governance);
    stage(report, "native_preview", { source: input.sourceCommit, engine: input.engine,
      toolVersionHash: report.provenance.toolVersionHash, lockOrAssemblyHash: report.provenance.lockOrAssemblyHash,
      synthesizedTemplateHash: report.provenance.synthesizedTemplateHash,
      binaryPlanHash: report.provenance.binaryPlanHash,
      nativePlanHash: report.provenance.nativePlanHash, proposedChanges: report.proposedChanges });
    report.actSnapshot.candidatePlanHash = report.provenance.nativePlanHash;
    stage(report, "act_boundary", report.actSnapshot);
    report.status = "REVIEW_REQUIRED";
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(":")[0] : "UNKNOWN_FAILURE";
    const known: Stage[] = ["identity", "models", "discovery", "design", "inventory",
      "governance", "native_preview", "act_boundary"];
    const next = known.find((x) => !report.stages.some((s) => s.stage === x)) ?? "act_boundary";
    report.stages.push({ stage: next, status: "BLOCKED", reason: /^[A-Z0-9_]+$/.test(reason) ? reason : "JOURNEY_BLOCKED" });
    report.status = "BLOCKED";
  }
  persist();
  return report;
}
