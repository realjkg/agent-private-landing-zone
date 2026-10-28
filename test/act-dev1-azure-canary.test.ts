import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OFFICIAL_PROVIDER_HASHES, lockedHashes, lockedProviders, unofficialProviderHash, unreviewedProviderVersion } from "../src/apply/lockfile.js";
import { localPluginPathIn } from "../src/apply/terraform-constructs.js";
import { checkModules, declaredVariables, variableSources } from "../src/apply/terraform-inputs.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";

// The committed ACT-DEV-1 Azure Terraform canary (qualification/azure/act-dev1-canary), in the style of the AWS canary's test
// (test/act-dev1-automation.test.py). SYNTHETIC and offline: it reads the files and runs the same lock and input readers
// `./alz apply prepare` runs. The opt-in run executes the pinned Terraform's fmt, offline init (lock read-only) and validate when
// ALZ_CANARY_TERRAFORM names the binary and TF_CLI_CONFIG_FILE points at a filesystem mirror holding azurerm 4.81.0.

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, "qualification", "azure", "act-dev1-canary");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
const AZURERM = "registry.terraform.io/hashicorp/azurerm";

test("the Azure canary is exactly one empty virtual network in an existing resource group, with the AWS canary's tag scheme", () => {
  const hcl = read("main.tf");
  assert.equal(hcl.match(/^resource "/gm)?.length, 1, "one resource block");
  assert.equal(hcl.match(/^resource "azurerm_virtual_network" "act_dev1" \{$/gm)?.length, 1);
  // No data source, module, subnet, peering, gateway or resource group: the group is the bootstrap's, passed by name.
  assert.doesNotMatch(hcl, /^(?:data|module) "/m);
  assert.doesNotMatch(hcl, /azurerm_resource_group|subnet|peering|gateway|ddos_protection_plan/);
  assert.match(hcl, /resource_group_name = var\.resource_group_name/);
  assert.match(hcl, /name\s+= var\.canary_name/);
  assert.match(hcl, /address_space\s+= \["10\.250\.0\.0\/24"\]/);
  for (const line of ['environment = "DEV"', 'managed-by  = "sovereign-alz"', 'purpose     = "act-dev-1"', "owner       = var.owner"]) assert.ok(hcl.includes(line), line);
  assert.match(hcl, /\}, var\.unit_tags\)/);
  // The same four tag lines as the AWS canary's log group.
  const aws = readFileSync(join(ROOT, "qualification", "aws", "act-dev1-canary", "main.tf"), "utf8");
  for (const line of ['environment = "DEV"', 'managed-by  = "sovereign-alz"', 'purpose     = "act-dev-1"', "owner       = var.owner"]) assert.ok(aws.includes(line), line);
});

test("azurerm is pinned to exactly 4.81.0, registers no resource provider, and the state backend is the pilot's azurerm backend", () => {
  const hcl = read("main.tf");
  assert.ok(hcl.includes('source  = "hashicorp/azurerm"\n      version = "= 4.81.0"'));
  assert.match(hcl, /^\s+resource_provider_registrations = "none"$/m);
  assert.match(hcl, /^\s+features \{\}$/m);
  assert.match(hcl, /^\s+backend "azurerm" \{\}$/m);
  // The subscription and tenant come from the apply identity's ARM_* variables, never from a constant in the project.
  assert.doesNotMatch(hcl, /subscription_id|tenant_id|client_id|client_secret/);
  assert.equal(hcl.match(/^provider "/gm)?.length, 1);
});

test("the committed lock has one azurerm 4.81.0 entry whose hashes are exactly HashiCorp's linux_amd64 and darwin_arm64 h1 hashes", () => {
  const lock = read(".terraform.lock.hcl");
  assert.deepEqual(lockedProviders(lock), [{ source: AZURERM, version: "4.81.0" }]);
  assert.ok(lock.includes('provider "' + AZURERM + '" {\n  version     = "4.81.0"\n  constraints = "4.81.0"'));
  assert.equal(unreviewedProviderVersion(lockedProviders(lock)), undefined);
  assert.equal(unofficialProviderHash(lock), undefined);
  const official = [...OFFICIAL_PROVIDER_HASHES[AZURERM + " 4.81.0"]].filter((hash) => hash.startsWith("h1:")).sort();
  assert.deepEqual(official, ["h1:XhToZua4gtih1Kv8RdStcfND83G4Tmb6GZFT4jEUhDU=", "h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg="]);
  assert.deepEqual([...lockedHashes(lock).get(AZURERM)!].sort(), official);
});

test("prepare's readers accept the project: no module, no local plugin folder, and every variable comes from the operator's tfvars", () => {
  assert.deepEqual(checkModules(DIR), []);
  assert.equal(localPluginPathIn(DIR), undefined);
  const names = declaredVariables(DIR).map((variable) => variable.name).sort();
  assert.deepEqual(names, ["canary_name", "location", "owner", "resource_group_name", "unit_tags"]);
  assert.ok(declaredVariables(DIR).every((variable) => !variable.hasDefault), "every input is the operator's, none is defaulted");
  const example = JSON.parse(read("terraform.tfvars.example.json"));
  assert.deepEqual(Object.keys(example).sort(), names);
  assert.deepEqual(Object.keys(example.unit_tags).sort(), ["alz-build", "alz-managed-by", "alz-unit"]);
  assert.equal(example.owner, "REPLACE-WITH-APPROVED-OWNER", "the committed example is a placeholder");
  // As committed nothing is set, so prepare stops with INPUT_UNSET; with the operator's terraform.tfvars.json every input is a file.
  assert.ok(variableSources(DIR, {}).every((variable) => variable.source.kind === "UNSET"));
  const work = mkdtempSync(join(tmpdir(), "alz-azure-canary-"));
  try {
    cpSync(DIR, work, { recursive: true });
    copyFileSync(join(work, "terraform.tfvars.example.json"), join(work, "terraform.tfvars.json"));
    assert.ok(variableSources(work, {}).every((variable) => variable.source.kind === "TFVARS" && variable.source.file === "terraform.tfvars.json"));
  } finally {
    removeTree(work);
  }
});

const TERRAFORM = process.env.ALZ_CANARY_TERRAFORM;
test("opt-in: fmt -check, offline init with the lock read-only, and validate pass with the pinned Terraform", { skip: TERRAFORM ? false : "set ALZ_CANARY_TERRAFORM to the pinned Terraform and TF_CLI_CONFIG_FILE to an offline azurerm 4.81.0 mirror" }, () => {
  const work = mkdtempSync(join(tmpdir(), "alz-azure-canary-tf-"));
  try {
    cpSync(DIR, work, { recursive: true });
    const run = (...args: string[]) => {
      const result = spawnSync(TERRAFORM!, args, { cwd: work, encoding: "utf8", env: { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" } });
      assert.equal(result.status, 0, args.join(" ") + "\n" + result.stdout + result.stderr);
    };
    run("fmt", "-check");
    run("init", "-backend=false", "-lockfile=readonly", "-input=false", "-no-color");
    run("validate", "-no-color");
    assert.equal(readFileSync(join(work, ".terraform.lock.hcl"), "utf8"), read(".terraform.lock.hcl"), "init left the lock unchanged");
  } finally {
    removeTree(work);
  }
});
