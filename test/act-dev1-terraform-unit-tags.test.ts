import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import { sealPreview } from "../src/apply/driver.js";
import { lockedProviders } from "../src/apply/lockfile.js";
import { openNonceStore } from "../src/apply/nonces.js";
import type { ApplyEnvironment, PilotContract, ProviderId } from "../src/apply/types.js";
import { pilotUnitOf, type PilotUnit } from "../src/apply/unit.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { sha256 } from "../src/util/sha256.js";
import {
  ENGINE_VERSION, H, NOW, POLICY, REQUESTER, SOURCE_COMMIT, awsContractJson, awsIdentityEnv, awsTargetOf, behave, contractJson, human, identityEnv,
  installFakeTerraform, targetOf, testFixtureForgeQualificationEvidence, writeReviewedContract, withCanary } from "./helpers/apply-fixtures.js";

// The committed ACT-DEV-1 Terraform canaries (qualification/aws/act-dev1-canary and qualification/azure/act-dev1-canary) against the
// seal-time deletion-unit check of the Terraform engine (`unitOfPlan`, src/apply/engines/terraform.ts). SYNTHETIC: each canary is
// sealed through the real driver and engine with the FAKE `terraform` of the apply tests. The project is the committed canary plus
// the operator's terraform.tfvars.json holding the unit tags exactly as `./alz apply prepare` derives them (`pilotUnitOf`). The fake
// `show` reports the plan the canary's HCL produces from those values (`tags` merged with `unit_tags`; for aws, `tags_all` the same
// with no default_tags). The opt-in run replaces that plan with the REAL `terraform show -json` of the AWS canary (pinned Terraform,
// aws 6.68.0 from an offline mirror, a local backend and placeholder credentials in override files, `-refresh=false`, no AWS call).

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const AWS_DIR = join(ROOT, "qualification", "aws", "act-dev1-canary");
const AZURE_DIR = join(ROOT, "qualification", "azure", "act-dev1-canary");
const AWS_SOURCE = "registry.terraform.io/hashicorp/aws";
const AZURERM_SOURCE = "registry.terraform.io/hashicorp/azurerm";
const BASE_TAGS = { environment: "DEV", "managed-by": "sovereign-alz", purpose: "act-dev-1", owner: "qa" };

type Cloud = {
  provider: ProviderId; dir: string; contract: (kill: string) => unknown; target: (environment: ApplyEnvironment) => ResolvedTarget;
  env: (environment: ApplyEnvironment) => NodeJS.ProcessEnv; vars: Record<string, unknown>; address: string; type: string;
  tagAttributes: string[]; providerConfig: Record<string, unknown>;
};
const AWS_CLOUD: Cloud = {
  provider: "AWS", dir: AWS_DIR, contract: (kill) => awsContractJson(kill), target: awsTargetOf, env: awsIdentityEnv,
  vars: { region: "us-east-2", canary_name: "/alz/act-dev-1/canary-01", owner: "qa" },
  address: "aws_cloudwatch_log_group.act_dev1", type: "aws_cloudwatch_log_group", tagAttributes: ["tags", "tags_all"],
  providerConfig: { aws: { name: "aws", full_name: AWS_SOURCE, expressions: { region: { references: ["var.region"] } } } },
};
/** The contract with every target at `location`. */
const withLocation = <T extends { targets: Record<string, unknown> }>(contract: T, location: string): T =>
  ({ ...contract, targets: Object.fromEntries(Object.entries(contract.targets).map(([env, target]) => [env, { ...(target as object), location }])) });
const AZURE_CLOUD: Cloud = {
  // Owner decision E1: the contract's canary allowlist is the committed canary's one virtual network (the example contract's).
  // Owner decision of 2026-10-28: each target names its authorized location, the region the canary's `location` variable places it in.
  provider: "AZURE", dir: AZURE_DIR, contract: (kill) => withLocation(withCanary(contractJson(kill), { resources: [{ type: "azurerm_virtual_network", count: 1 }] }), "eastus2"), target: targetOf, env: identityEnv,
  vars: { resource_group_name: "rg-alz-pilot-dev", location: "eastus2", canary_name: "vnet-alz-act-dev-1-canary-01", owner: "qa" },
  address: "azurerm_virtual_network.act_dev1", type: "azurerm_virtual_network", tagAttributes: ["tags"],
  providerConfig: { azurerm: { name: "azurerm", full_name: AZURERM_SOURCE, expressions: { features: [{}], resource_provider_registrations: { constant_value: "none" } } } },
};

/** What the canary's HCL plans for its one resource from the operator's values: the four tags merged with `unit_tags`. */
function plannedChange(cloud: Cloud, unitTags: Record<string, string>): unknown {
  const tags = { ...BASE_TAGS, ...unitTags };
  return {
    address: cloud.address, mode: "managed", type: cloud.type, name: "act_dev1", provider_name: cloud.provider === "AWS" ? AWS_SOURCE : AZURERM_SOURCE,
    // The Azure canary's `location = var.location` resolves at plan time to the operator's value (owner decision of 2026-10-28 judges it).
    change: { actions: ["create"], before: null, after: { ...Object.fromEntries(cloud.tagAttributes.map((name) => [name, tags])), ...(cloud.provider === "AZURE" ? { location: cloud.vars.location } : {}) }, after_unknown: { id: true } },
  };
}

/** Seals the committed canary (plus the operator's tfvars) through the real driver with the fake terraform reporting `changes`. */
async function sealCanary(cloud: Cloud, changes: (unit: PilotUnit) => unknown[], unitTagsFor: (unit: PilotUnit) => Record<string, string> | undefined) {
  const root = mkdtempSync(join(tmpdir(), "alz-tf-canary-"));
  const toolDir = mkdtempSync(join(tmpdir(), "alz-tf-canary-tools-"));
  const previous = { cwd: process.cwd(), key: process.env.AGENTIC_EVIDENCE_KEY };
  try {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root);
    const dir = (name: string): string => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
    const kill = join(root, "KILL");
    installFakeTerraform(toolDir);
    const vault = dir("qualification");
    await testFixtureForgeQualificationEvidence(vault, undefined, cloud.provider);
    const contractPath = join(dir("contract"), "act-pilot-contract.json");
    writeReviewedContract(contractPath, cloud.contract(kill));
    const loaded = loadPilotContract(contractPath);
    assert.ok(!("reason" in loaded), JSON.stringify(loaded));
    const target = cloud.target("DEV");
    // The unit exactly as prepare and the driver derive it for this contract, environment and target.
    const unit = pilotUnitOf({ provider: cloud.provider, contractSha256: pilotContractSha256(loaded as PilotContract), environment: "DEV", target });
    behave(toolDir, kill, { showOnlyConfigured: true, showResources: changes(unit), showProviderConfig: cloud.providerConfig });

    const project = dir("project");
    cpSync(cloud.dir, project, { recursive: true });
    const unitTags = unitTagsFor(unit);
    writeFileSync(join(project, "terraform.tfvars.json"), JSON.stringify({ ...cloud.vars, ...(unitTags ? { unit_tags: unitTags } : {}) }, null, 2) + "\n");
    const lock = readFileSync(join(project, ".terraform.lock.hcl"), "utf8");
    const resolved = { engineVersion: ENGINE_VERSION, providers: lockedProviders(lock), lockFileSha256: sha256(lock), dependencies: [], inputs: [] };
    const manifest = buildManifest({ engine: "TERRAFORM", mode: "PROJECT", target, unitHash: H("1"), files: captureProjectFiles(project), policyVersion: POLICY, ...resolved });
    const result = await sealPreview({
      invocation: human(target), environment: "DEV", target, manifest, projectRoot: project, policyVersion: POLICY, resolved, requester: REQUESTER,
    }, {
      sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vault, evidenceDir: dir("evidence"), nonces: openNonceStore(dir("nonces")),
      env: cloud.env("DEV"), now: () => NOW, scratchParent: dir("scratch"), toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
    });
    return { result, unit };
  } finally {
    process.chdir(previous.cwd);
    if (previous.key === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previous.key;
    removeTree(root);
    removeTree(toolDir);
  }
}

test("both Terraform canaries merge the operator's unit_tags into their one resource's tags", () => {
  for (const dir of [AWS_DIR, AZURE_DIR]) {
    const hcl = readFileSync(join(dir, "main.tf"), "utf8");
    assert.match(hcl, /^variable "unit_tags" \{\n  type = map\(string\)/m, dir);
    assert.ok(hcl.includes('condition     = join(",", sort(keys(var.unit_tags))) == "alz-build,alz-managed-by,alz-unit"'), dir);
    assert.match(hcl, /tags = merge\(\{\n    environment = "DEV"\n    managed-by  = "sovereign-alz"\n    purpose     = "act-dev-1"\n    owner       = var\.owner\n  \}, var\.unit_tags\)/, dir);
    assert.doesNotMatch(hcl, /default_tags|ignore_tags/, dir);
    const example = JSON.parse(readFileSync(join(dir, "terraform.tfvars.example.json"), "utf8"));
    assert.deepEqual(Object.keys(example.unit_tags).sort(), ["alz-build", "alz-managed-by", "alz-unit"], dir);
  }
});

for (const cloud of [AWS_CLOUD, AZURE_CLOUD]) {
  test(cloud.provider + " Terraform canary: sealed with prepare's unit tags, the seal-time unit check passes with exactly one create", async () => {
    const { result, unit } = await sealCanary(cloud, (u) => [plannedChange(cloud, { ...u.tags })], (u) => ({ ...u.tags }));
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.sealed.changes, [{ address: cloud.address, type: cloud.type, action: "CREATE" }]);
    assert.deepEqual(result.sealed.unit, { unitId: unit.unitId, tags: { ...unit.tags }, untagged: [] });
  });

  test(cloud.provider + " Terraform canary: without the unit tags (the canary before this change) the same seal is refused UNIT_TAG_MISSING", async () => {
    const { result } = await sealCanary(cloud, () => [plannedChange(cloud, {})], () => undefined);
    assert.equal(result.ok, false);
    // The driver reports an engine stop as ARTIFACT_INVALID and names the engine's code.
    const refusal = result as { code?: string; message?: string };
    assert.equal(refusal.code, "ARTIFACT_INVALID", JSON.stringify(result));
    assert.match(refusal.message ?? "", /\(UNIT_TAG_MISSING\)/);
  });
}

const TERRAFORM = process.env.ALZ_CANARY_TERRAFORM;
test("opt-in: the REAL plan of the AWS canary (pinned Terraform, aws 6.68.0, offline) passes the same seal-time unit check", { skip: TERRAFORM ? false : "set ALZ_CANARY_TERRAFORM to the pinned Terraform and TF_CLI_CONFIG_FILE to an offline mirror holding aws 6.68.0" }, async () => {
  const realChanges = (unit: PilotUnit): unknown[] => {
    const work = mkdtempSync(join(tmpdir(), "alz-aws-canary-plan-"));
    try {
      cpSync(AWS_DIR, work, { recursive: true });
      // Override files (Terraform's own mechanism) for this offline run only: a local backend instead of the pilot's S3 backend,
      // and placeholder credentials with every AWS call skipped. The product's seal never uses either; plan runs with -refresh=false.
      writeFileSync(join(work, "backend_override.tf"), 'terraform {\n  backend "local" {}\n}\n');
      writeFileSync(join(work, "provider_override.tf"), 'provider "aws" {\n  access_key                  = "placeholder"\n  secret_key                  = "placeholder"\n' +
        '  skip_credentials_validation = true\n  skip_requesting_account_id  = true\n  skip_metadata_api_check     = true\n}\n');
      writeFileSync(join(work, "terraform.tfvars.json"), JSON.stringify({ ...AWS_CLOUD.vars, unit_tags: { ...unit.tags } }));
      const run = (...args: string[]): string => {
        const done = spawnSync(TERRAFORM!, args, { cwd: work, encoding: "utf8", env: { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" }, maxBuffer: 64 * 1024 * 1024 });
        assert.equal(done.status, 0, args.join(" ") + "\n" + done.stdout + done.stderr);
        return done.stdout;
      };
      run("init", "-lockfile=readonly", "-input=false", "-no-color");
      run("plan", "-refresh=false", "-input=false", "-no-color", "-out=canary.tfplan");
      const shown = JSON.parse(run("show", "-json", "canary.tfplan")) as { resource_changes: Array<{ change: { after: Record<string, unknown> } }> };
      assert.equal(shown.resource_changes.length, 1);
      assert.deepEqual(shown.resource_changes[0].change.after.tags_all, { ...BASE_TAGS, ...unit.tags }, "tags_all is known at plan time");
      return shown.resource_changes;
    } finally {
      removeTree(work);
    }
  };
  const { result } = await sealCanary(AWS_CLOUD, realChanges, (u) => ({ ...u.tags }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.sealed.changes, [{ address: AWS_CLOUD.address, type: AWS_CLOUD.type, action: "CREATE" }]);
});
