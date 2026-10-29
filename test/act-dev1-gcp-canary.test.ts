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

// The committed ACT-DEV-1 GCP Terraform canary (qualification/gcp/act-dev1-canary; lane G1), in the style of the Azure canary's test.
// SYNTHETIC and offline: it reads the files and runs the same lock and input readers `./alz apply prepare` runs. The opt-in run
// executes the pinned Terraform's fmt, offline init (lock read-only) and validate when ALZ_CANARY_TERRAFORM names the binary and
// TF_CLI_CONFIG_FILE points at a filesystem mirror holding google 8.9.0. The seal-time judgment of this canary through the real
// driver, engine and provider is test/apply-emulated-gcp.test.ts (EMULATED, opt-in).

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, "qualification", "gcp", "act-dev1-canary");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
const GOOGLE = "registry.terraform.io/hashicorp/google";

test("the GCP canary is exactly one Pub/Sub topic with the AWS and Azure canaries' label scheme, stored only in the contract's region", () => {
  const hcl = read("main.tf");
  assert.equal(hcl.match(/^resource "/gm)?.length, 1, "one resource block");
  assert.equal(hcl.match(/^resource "google_pubsub_topic" "act_dev1" \{$/gm)?.length, 1);
  // No data source, module, subscription, IAM, schema or key: owner decision 6481421924, "one Pub/Sub topic", "no CMEK, no messages".
  assert.doesNotMatch(hcl, /^(?:data|module) "/m);
  assert.doesNotMatch(hcl, /subscription|_iam_|schema|kms_key_name|message_retention_duration|ingestion_data_source_settings|message_transforms|deletion_policy|\btags\s*=/);
  assert.match(hcl, /^ {2}name = var\.canary_name$/m);
  // R2 of G1: the topic's only location is its storage policy, the contract's region and nothing else.
  assert.match(hcl, /^ {2}message_storage_policy \{\n {4}allowed_persistence_regions = \[var\.region\]\n {2}\}$/m);
  // The AWS and Azure canaries' four labels, in GCP's lowercase form, and the unit labels from the provider's default_labels.
  for (const line of ['environment = "dev"', 'managed-by  = "sovereign-alz"', 'purpose     = "act-dev-1"', "owner       = var.owner"]) assert.ok(hcl.includes(line), line);
  assert.match(hcl, /^ {2}default_labels = var\.unit_labels$/m);
  const azure = readFileSync(join(ROOT, "qualification", "azure", "act-dev1-canary", "main.tf"), "utf8");
  for (const line of ['managed-by  = "sovereign-alz"', 'purpose     = "act-dev-1"', "owner       = var.owner"]) assert.ok(azure.includes(line), line);
});

test("google is pinned to exactly 8.9.0, the provider names the project as a constant and nothing else the judge refuses, and the state backend is the pilot's gcs backend", () => {
  const hcl = read("main.tf");
  assert.ok(hcl.includes('source  = "hashicorp/google"\n      version = "= 8.9.0"'));
  assert.match(hcl, /^\s+backend "gcs" \{\}$/m);
  assert.equal(hcl.match(/^provider "/gm)?.length, 1, "one provider block, no alias");
  // Review N1 of #339: a constant, the placeholder the owner replaces with the contract's DEV projectId (README).
  assert.match(hcl, /^ {2}project {8}= "examplefake-dev"$/m);
  // What the judge refuses in a google block (DENIED_ATTRIBUTE, src/apply/providers/gcp.ts) appears nowhere, nor does google-beta.
  assert.doesNotMatch(hcl, /credentials|access_token|impersonate_service_account|scopes|custom_endpoint|universe_domain|billing_project|user_project_override|google-beta/);
});

test("the committed lock has one google 8.9.0 entry whose hashes are exactly HashiCorp's linux_amd64 and darwin_arm64 h1 hashes", () => {
  const lock = read(".terraform.lock.hcl");
  assert.deepEqual(lockedProviders(lock), [{ source: GOOGLE, version: "8.9.0" }]);
  assert.ok(lock.includes('provider "' + GOOGLE + '" {\n  version     = "8.9.0"\n  constraints = "8.9.0"'));
  assert.equal(unreviewedProviderVersion(lockedProviders(lock)), undefined);
  assert.equal(unofficialProviderHash(lock), undefined);
  const official = [...OFFICIAL_PROVIDER_HASHES[GOOGLE + " 8.9.0"]].filter((hash) => hash.startsWith("h1:")).sort();
  assert.deepEqual(official, ["h1:1REt6EKYmjtrLK5PC/AHGZ2FFaHs0EMsvLOyv2eADeA=", "h1:EcUkiM2dD/TtxkpcH/2BtPFp8oHIiU4x6R/Dn43sS3Y="]);
  assert.deepEqual([...lockedHashes(lock).get(GOOGLE)!].sort(), official);
});

test("prepare's readers accept the project: no module, no local plugin folder, and every variable comes from the operator's tfvars", () => {
  assert.deepEqual(checkModules(DIR), []);
  assert.equal(localPluginPathIn(DIR), undefined);
  const names = declaredVariables(DIR).map((variable) => variable.name).sort();
  assert.deepEqual(names, ["canary_name", "owner", "region", "unit_labels"]);
  assert.ok(declaredVariables(DIR).every((variable) => !variable.hasDefault), "every input is the operator's, none is defaulted");
  const example = JSON.parse(read("terraform.tfvars.example.json"));
  assert.deepEqual(Object.keys(example).sort(), names);
  assert.deepEqual(Object.keys(example.unit_labels).sort(), ["alz-build", "alz-managed-by", "alz-unit"]);
  assert.equal(example.owner, "replace-with-approved-owner", "the committed example is a placeholder");
  assert.match(example.canary_name, /^alz-act-dev-1-/);
  assert.ok(variableSources(DIR, {}).every((variable) => variable.source.kind === "UNSET"));
  const work = mkdtempSync(join(tmpdir(), "alz-gcp-canary-"));
  try {
    cpSync(DIR, work, { recursive: true });
    copyFileSync(join(work, "terraform.tfvars.example.json"), join(work, "terraform.tfvars.json"));
    assert.ok(variableSources(work, {}).every((variable) => variable.source.kind === "TFVARS" && variable.source.file === "terraform.tfvars.json"));
  } finally {
    removeTree(work);
  }
});

const TERRAFORM = process.env.ALZ_CANARY_TERRAFORM;
test("opt-in: fmt -check, offline init with the lock read-only, and validate pass with the pinned Terraform", { skip: TERRAFORM ? false : "set ALZ_CANARY_TERRAFORM to the pinned Terraform and TF_CLI_CONFIG_FILE to an offline google 8.9.0 mirror" }, () => {
  const work = mkdtempSync(join(tmpdir(), "alz-gcp-canary-tf-"));
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
