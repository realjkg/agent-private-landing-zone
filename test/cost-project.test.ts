import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareApply } from "../src/apply/prepare.js";
import { renderAwsCostBaseline, renderAwsCostBaselineProject } from "../src/build/cost-baseline.js";
import { COST_PROJECT_FILES, REVIEWED_AWS_LOCK_PATH, reviewedAwsLock, writeCostBaselineProject } from "../src/build/cost-project.js";
import { sha256 } from "../src/build/provenance.js";
import { costBaselinePreview, logGroupPreview } from "../src/build/terraform-preview.js";
import { resolveCostConfig } from "../src/design/cost.js";
import { awsContractJson, installFakeTerraform, writeReviewedContract } from "./helpers/apply-fixtures.js";

// SYNTHETIC. The cost baseline as a pilot project (src/build/cost-project.ts) and the shared preview driver
// (src/build/terraform-preview.ts). No engine runs except a fake `terraform` script, no cloud is reached, and nothing here
// is provider qualification. The real-engine journey is the opt-in EMULATED suite, test/cost-baseline-emulated-aws.test.ts.

process.env.AGENTIC_EVIDENCE_KEY ??= randomBytes(32).toString("base64");
const root = mkdtempSync(join(tmpdir(), "alz-cost-project-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string): string => join(root, label + "-" + ++counter);

const CONFIG = resolveCostConfig(JSON.parse(readFileSync("config/cost.example.json", "utf8")));
/** The DEV limits the shipped example names (config/act-pilot-contract.aws-dev-limits.example.json). Synthetic contract only. */
const EXAMPLE_LIMITS = (JSON.parse(readFileSync("config/act-pilot-contract.aws-dev-limits.example.json", "utf8")) as
  { targets: { DEV: { limits: { regions: string[]; resources: { type: string; max: number }[] } } } }).targets.DEV.limits;

/** The example's limits on every fixture target, replacing the canary allowlist; the regions include the fixture region. */
const withLimits = <T extends { targets: Record<string, unknown> }>(contract: T): T => ({
  ...contract,
  targets: Object.fromEntries(Object.entries(contract.targets).map(([environment, target]) => {
    const { canary: _canary, ...rest } = target as Record<string, unknown>;
    return [environment, { ...rest, limits: EXAMPLE_LIMITS }];
  })),
});

/** The text of every `resource` and `data` block, in order. */
const blocks = (terraform: string): string[] => terraform.split(/\n(?=resource |data |# )/).filter((part) => /^(resource|data) /.test(part));

test("the pilot-project form differs from the preview only in the terraform block, the unit_tags variable and the two default_tags maps", () => {
  const preview = renderAwsCostBaseline(CONFIG).terraform;
  const project = renderAwsCostBaselineProject(CONFIG).terraform;
  assert.deepEqual(blocks(project), blocks(preview), "every resource and data block is the preview's, line for line");
  assert.ok(blocks(preview).length >= 11);
  assert.match(project, /required_providers \{[\s\S]*?\n {2}\}\n {2}backend "s3" \{\}\n\}/);
  assert.doesNotMatch(preview, /backend "s3"/);
  // The canary's variable, character for character, so prepare and seal treat both the same way.
  const canary = readFileSync("qualification/aws/act-dev1-canary/main.tf", "utf8");
  const canaryVariable = canary.slice(canary.indexOf('variable "unit_tags"'), canary.indexOf("}\n}\n", canary.indexOf('variable "unit_tags"')) + 4);
  assert.ok(project.includes(canaryVariable), "the unit_tags variable is the canary's");
  assert.equal(project.match(/tags = merge\(\{/g)?.length, 2, "both the home and the billing provider merge the unit tags");
  assert.equal(project.match(/\}, var\.unit_tags\)/g)?.length, 2);
  // Rendering is deterministic, and the metadata's creates are the same set for both forms.
  assert.equal(renderAwsCostBaselineProject(CONFIG).terraform, project);
  assert.deepEqual(renderAwsCostBaselineProject(CONFIG).metadata.creates, renderAwsCostBaseline(CONFIG).metadata.creates);
});

test("the project folder has the canary's shape: main.tf, the reviewed lock, a tfvars example and the labeled render record", () => {
  const projectRoot = fresh("project");
  const preview = sha256(renderAwsCostBaseline(CONFIG).terraform);
  const { record } = writeCostBaselineProject({ config: CONFIG, projectRoot, region: "us-east-2", previewArtifactSha256: preview });
  for (const name of COST_PROJECT_FILES) {
    assert.ok(existsSync(join(projectRoot, name)), name);
    assert.equal(statSync(join(projectRoot, name)).mode & 0o777, 0o600, name);
  }
  assert.equal(statSync(projectRoot).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(projectRoot, "main.tf"), "utf8"), renderAwsCostBaselineProject(CONFIG).terraform);
  assert.equal(readFileSync(join(projectRoot, ".terraform.lock.hcl"), "utf8"), readFileSync(REVIEWED_AWS_LOCK_PATH, "utf8"));
  const tfvars = JSON.parse(readFileSync(join(projectRoot, "terraform.tfvars.example.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(tfvars).sort(), ["aws_region", "unit_tags"]);
  assert.equal(tfvars.aws_region, "us-east-2");
  assert.deepEqual(Object.keys(tfvars.unit_tags as object).sort(), ["alz-build", "alz-managed-by", "alz-unit"]);
  assert.equal(record.previewArtifactSha256, preview);
  assert.equal(record.mainTfSha256, sha256(readFileSync(join(projectRoot, "main.tf"), "utf8")));
  assert.equal(record.label, "LOCAL_RENDER");
  assert.equal(record.approval, "NOT_GRANTED");
  assert.equal(record.infrastructureAct, "DISABLED");
  assert.deepEqual(JSON.parse(readFileSync(join(projectRoot, "cost-baseline.json"), "utf8")), record);
  // Nothing in the folder could carry a plugin or a CLI configuration (prepare refuses both).
  assert.ok(!existsSync(join(projectRoot, ".terraform")) && !existsSync(join(projectRoot, "terraform.d")));
});

test("negative: an existing folder, a bad region, a bad preview hash and an invalid config are refused; nothing is overwritten", () => {
  const projectRoot = fresh("exists");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "main.tf"), "# operator's own\n");
  assert.throws(() => writeCostBaselineProject({ config: CONFIG, projectRoot, region: "us-east-2" }), /COST_PROJECT_EXISTS/);
  assert.equal(readFileSync(join(projectRoot, "main.tf"), "utf8"), "# operator's own\n");
  assert.throws(() => writeCostBaselineProject({ config: CONFIG, projectRoot: fresh("r"), region: 'us-east-2"\n' }), /COST_PROJECT_REGION_INVALID/);
  assert.throws(() => writeCostBaselineProject({ config: CONFIG, projectRoot: fresh("h"), region: "us-east-2", previewArtifactSha256: "x" }),
    /COST_PROJECT_PREVIEW_HASH_INVALID/);
  const forged = { ...CONFIG, budget: { ...CONFIG.budget, amount: '1" }' } };
  assert.throws(() => writeCostBaselineProject({ config: forged, projectRoot: fresh("c"), region: "us-east-2" }), /COST_CONFIG_INVALID/);
});

test("the reviewed lock is the canary's and pins hashicorp/aws 6.68.0", () => {
  const lock = reviewedAwsLock();
  assert.match(lock, /provider "registry\.terraform\.io\/hashicorp\/aws" \{\n {2}version {5}= "6\.68\.0"/);
});

test("./alz apply prepare takes the written project under a limits contract (SYNTHETIC contract, never committed), in two passes as for the canary", async () => {
  const dir = fresh("prepare");
  const toolDir = join(dir, "tools");
  mkdirSync(toolDir, { recursive: true });
  installFakeTerraform(toolDir);
  const contractPath = join(dir, "contract.json");
  const base = awsContractJson(join(dir, "kill"), { policyVersion: "pilot-policy-2026-11-01" });
  writeReviewedContract(contractPath, withLimits(base));
  const deps = { contractPath, qualificationDir: join(dir, "vault"), toolDirs: [toolDir] };
  const projectRoot = join(dir, "project");
  writeCostBaselineProject({ config: CONFIG, projectRoot, region: "us-east-1" });
  // Without terraform.tfvars.json the inputs are unset, and prepare names them without asking for a value.
  const unset = await prepareApply({ environment: "DEV", projectRoot }, deps);
  assert.equal(unset.ok, false);
  assert.equal(!unset.ok && unset.code, "INPUT_UNSET");
  copyFileSync(join(projectRoot, "terraform.tfvars.example.json"), join(projectRoot, "terraform.tfvars.json"));
  chmodSync(join(projectRoot, "terraform.tfvars.json"), 0o600);
  const first = await prepareApply({ environment: "DEV", projectRoot }, deps);
  assert.ok(first.ok, first.ok ? "" : first.code + " " + first.message);
  assert.deepEqual(first.request.resolved.providers, [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }]);
  assert.deepEqual(first.summary.inputs.map((input) => input.name).sort(), ["aws_region", "unit_tags"]);
  // The operator copies the printed unit tags into unit_tags and prepares again: the manifest binds the final files.
  const tfvars = JSON.parse(readFileSync(join(projectRoot, "terraform.tfvars.json"), "utf8")) as { unit_tags: Record<string, string> };
  tfvars.unit_tags = { ...first.summary.unit.tags };
  writeFileSync(join(projectRoot, "terraform.tfvars.json"), JSON.stringify(tfvars, null, 2) + "\n");
  const second = await prepareApply({ environment: "DEV", projectRoot }, deps);
  assert.ok(second.ok, second.ok ? "" : second.code + " " + second.message);
  assert.notEqual(second.summary.manifestHash, first.summary.manifestHash);
  assert.equal(second.summary.unit.unitId, first.summary.unit.unitId);
});

// --- the shared preview driver, with a fake terraform ------------------------------------------------------------------

/** A fake `terraform` that answers each subcommand; `show -json` prints the plan given in PLAN_JSON. It records every argv. */
function fakeTerraform(dir: string, plan: unknown): { bin: string; calls: () => string[][] } {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "terraform");
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(bin, [
    "#!" + process.execPath,
    'const fs = require("node:fs"), path = require("node:path");',
    "const args = process.argv.slice(2);",
    'fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n");',
    'if (args[0] === "version") process.stdout.write(JSON.stringify({ terraform_version: "1.16.4" }));',
    'else if (args[0] === "init") { if (!fs.existsSync(".terraform.lock.hcl")) fs.writeFileSync(".terraform.lock.hcl", "# fake lock\\n"); }',
    'else if (args[0] === "validate") process.stdout.write(JSON.stringify({ valid: true, error_count: 0 }));',
    'else if (args[0] === "plan") fs.writeFileSync(".agentic-preview.tfplan", "PK");',
    'else if (args[0] === "show") process.stdout.write(fs.readFileSync(path.join(__dirname, "plan.json"), "utf8"));',
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) };
}
const change = (address: string, type: string, actions: string[], tags?: Record<string, string>) =>
  ({ address, type, change: { actions, after: tags ? { tags_all: tags } : {} } });

test("cost preview: the same init, fmt, validate, plan and show steps, the reviewed lock first, every create reported sorted", () => {
  const preview = renderAwsCostBaseline(CONFIG);
  const creates = preview.metadata.creates.map((c) => c.address);
  const tags = { "alz-managed-by": "alz", "alz-unit": "alzu-0000", "alz-build": "build-1" };
  const fake = fakeTerraform(fresh("tf"), { resource_changes: [...creates].reverse().map((a) => change(a, a.split(".")[0]!, ["create"], tags)) });
  const folder = fresh("run");
  mkdirSync(folder);
  const lock = reviewedAwsLock();
  const result = costBaselinePreview(folder, preview.terraform, "c".repeat(40), lock, { terraform: fake.bin, env: { PATH: "/usr/bin:/bin" } });
  assert.deepEqual(result.createdAddresses, [...creates].sort());
  assert.equal(result.createOnly, true);
  assert.equal(result.infrastructureApplied, false);
  assert.equal(result.validatedArtifactHash, sha256(preview.terraform));
  assert.ok(result.plannedTags && result.plannedTags.length === creates.length);
  assert.deepEqual(fake.calls().map((args) => args[0]), ["version", "init", "fmt", "validate", "plan", "show"]);
  assert.deepEqual(fake.calls()[1], ["init", "-backend=false", "-input=false", "-no-color"]);
  assert.ok(!fake.calls().some((args) => ["apply", "destroy", "import"].includes(args[0]!)), "never apply, destroy or import");
  const evidence = JSON.parse(readFileSync(join(folder, "preview-evidence.json"), "utf8")) as Record<string, unknown>;
  assert.equal(evidence.reviewedLockHash, sha256(lock));
  assert.equal(evidence.infrastructureApplied, false);
});

test("cost preview negative: an update, a delete, a deferred data read or an empty plan is refused, never reported as create-only", () => {
  const preview = renderAwsCostBaseline(CONFIG).terraform;
  for (const plan of [
    { resource_changes: [change("aws_budgets_budget.cost_baseline", "aws_budgets_budget", ["update"])] },
    { resource_changes: [change("aws_s3_bucket.cost_export", "aws_s3_bucket", ["delete", "create"])] },
    { resource_changes: [change("aws_sns_topic.cost_alerts", "aws_sns_topic", ["create"]), change("data.aws_caller_identity.current", "aws_caller_identity", ["read"])] },
    { resource_changes: [] },
  ]) {
    const fake = fakeTerraform(fresh("tf"), plan);
    const folder = fresh("run");
    mkdirSync(folder);
    assert.throws(() => costBaselinePreview(folder, preview, "c".repeat(40), reviewedAwsLock(), { terraform: fake.bin, env: { PATH: "/usr/bin:/bin" } }),
      /REAL_TERRAFORM_PLAN_NOT_CREATE_ONLY/);
    assert.ok(!existsSync(join(folder, "preview-evidence.json")), "no evidence for a refused plan");
  }
});

test("log-group preview keeps its exact single-create check through the shared driver", () => {
  const ok = fakeTerraform(fresh("tf"), { resource_changes: [change("aws_cloudwatch_log_group.alz_audit", "aws_cloudwatch_log_group", ["create"])] });
  const folder = fresh("run");
  mkdirSync(folder);
  const result = logGroupPreview(folder, "# hcl\n", "c".repeat(40), { terraform: ok.bin, env: { PATH: "/usr/bin:/bin" } });
  assert.equal(result.singleCreateOnly, true);
  assert.equal(result.resourceAddress, "aws_cloudwatch_log_group.alz_audit");
  assert.ok(!existsSync(join(folder, ".terraform.lock.hcl")) || readFileSync(join(folder, ".terraform.lock.hcl"), "utf8") === "# fake lock\n",
    "no lock is written for the first scenario");
  const two = fakeTerraform(fresh("tf"), { resource_changes: [
    change("aws_cloudwatch_log_group.alz_audit", "aws_cloudwatch_log_group", ["create"]), change("aws_sns_topic.x", "aws_sns_topic", ["create"])] });
  const other = fresh("run");
  mkdirSync(other);
  assert.throws(() => logGroupPreview(other, "# hcl\n", "c".repeat(40), { terraform: two.bin, env: { PATH: "/usr/bin:/bin" } }),
    /REAL_TERRAFORM_PLAN_NOT_SINGLE_APPROVED_CREATE/);
});

test("a failing engine step stops the preview with the step's name and no evidence", () => {
  const dir = fresh("tf");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "terraform");
  writeFileSync(bin, "#!/bin/sh\n[ \"$1\" = init ] && exit 1\necho '{}'\n");
  chmodSync(bin, 0o755);
  const folder = fresh("run");
  mkdirSync(folder);
  assert.throws(() => costBaselinePreview(folder, "# hcl\n", "c".repeat(40), reviewedAwsLock(), { terraform: bin, env: { PATH: "/usr/bin:/bin" } }),
    /ACTUAL_TERRAFORM_TOOL_FAILURE:init/);
  assert.ok(!existsSync(join(folder, "preview-evidence.json")));
});
