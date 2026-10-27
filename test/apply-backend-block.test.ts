import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertBackendBlock, type BackendBlockRule } from "../src/apply/backend-block.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { codeOf } from "../src/apply/engine.js";

// docs/act-pilot-apply.md, "Providers". The project's own backend block is judged before `terraform init` reads it:
// init already sends credentials, so a check after init cannot protect init. Pure parsing; no engine runs.

const ALLOWED: BackendBlockRule = { type: "s3", attributes: ["bucket", "key", "region", "use_lockfile"] };
const S3_BACKEND = "b/k";
const verdict = (files: Record<string, string>, rule: BackendBlockRule = ALLOWED, backend: string = S3_BACKEND): string => {
  const dir = mkdtempSync(join(tmpdir(), "alz-backend-block-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    try { assertBackendBlock(dir, rule, backend); return "ok"; } catch (error) { return codeOf(error); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const NOT_ALLOWED = "BACKEND_BLOCK_NOT_IN_CONTRACT";
const block = (body: string, type = "s3") => `terraform {\n  required_version = ">= 1.9"\n  backend "${type}" {\n${body}\n  }\n}\n`;

test("no backend block, an empty one, or exactly the contract's settings pass", () => {
  assert.equal(verdict({ "main.tf": 'resource "aws_s3_bucket" "x" {}\n' }), "ok");
  assert.equal(verdict({}), "ok");
  assert.equal(verdict({ "main.tf": block("") }), "ok");
  assert.equal(verdict({ "main.tf": block('bucket = "b"\nkey = "k"\nregion = "us-east-1"\nuse_lockfile = true # native locking') }), "ok");
  assert.equal(verdict({ "main.tf": block('bucket="b" // inline\n/* block\ncomment backend "http" { address = "x" } */\nkey="k"') }), "ok");
});

test("every other backend attribute, in any spelling, is refused: credentials, endpoints, profiles, role and lock settings", () => {
  for (const body of [
    'endpoints = {\n  sts = "https://attacker.example"\n}', 'endpoint = "https://attacker.example"', 'sts_endpoint = "https://attacker.example"',
    'access_key = "AKIAFAKE"', 'secret_key = "fake"', 'token = "fake"', 'profile = "operator"', 'shared_credentials_files = ["/home/op/.aws/credentials"]',
    'assume_role = {\n  role_arn = "arn:aws:iam::111111111111:role/x"\n}', 'assume_role_with_web_identity = {}', "skip_credentials_validation = true",
    'workspace_key_prefix = "x"', 'dynamodb_table = "t"', 'kms_key_id = "k"', 'custom = { a = 1 }', '"quoted" = 1',
  ]) assert.equal(verdict({ "main.tf": block('bucket = "b"\n' + body) }), NOT_ALLOWED, body);
  assert.equal(verdict({ "main.tf": block('bucket = "b"\nassume_role {\n  role_arn = "x"\n}') }), NOT_ALLOWED, "a nested block is an attribute too");
  assert.equal(verdict({ "main.tf": 'terraform { backend "s3" { bucket = "b", endpoints = {} } }' }), NOT_ALLOWED, "one line");
});

test("another backend type, a cloud block, a second terraform block and an override or JSON file are judged the same way", () => {
  assert.equal(verdict({ "main.tf": block('address = "https://attacker.example"', "http") }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf": 'terraform {\n  cloud {\n    hostname = "attacker.example"\n  }\n}\n' }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf": block('bucket = "b"'), "extra.tf": block('endpoints = {}') }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf": 'locals {\n  a = "x"\n}\nterraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n' + block('bucket = "b"') }), "ok");
  assert.equal(verdict({ "override.tf": block("endpoint = \"x\"") }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf.json": JSON.stringify({ terraform: { backend: { s3: { bucket: "b", key: "k" } } } }) }), "ok");
  assert.equal(verdict({ "main.tf.json": JSON.stringify({ terraform: [{ backend: [{ s3: [{ bucket: "b", access_key: "x" }] }] }] }) }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf.json": JSON.stringify({ terraform: { backend: { local: {} } } }) }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf.json": JSON.stringify({ terraform: { cloud: {} } }) }), NOT_ALLOWED);
});

test("text that only looks like a block (strings, heredocs, comments) is not one, and what cannot be parsed fails closed", () => {
  const decoy = 'resource "x" "y" {\n  a = "backend \\"s3\\" { access_key = 1 }"\n  b = <<EOT\nterraform {\n  backend "s3" {\n    access_key = "x"\n  }\n}\nEOT\n  c = "${var.a}"\n}\n# terraform { backend "s3" { token = 1 } }\n';
  assert.equal(verdict({ "main.tf": decoy }), "ok");
  assert.equal(verdict({ "main.tf": decoy + block('bucket = "b"') }), "ok");
  assert.equal(verdict({ "main.tf": "terraform {\n  backend \"s3\" {\n    bucket = \"b\"\n" }), NOT_ALLOWED, "unterminated");
  assert.equal(verdict({ "main.tf": "terraform {\n  backend \"s3\" {\n    bucket\n  }\n}\n" }), NOT_ALLOWED, "an attribute with no value");
  assert.equal(verdict({ "main.tf.json": "{ not json" }), NOT_ALLOWED);
  assert.equal(verdict({ "main.tf": "x".repeat(1_100_000) }), NOT_ALLOWED, "too large to judge");
});

// --- the azurerm rule: the Azure spec's own, with the contract's storage names and Entra ID pinned as literals ----------------

const AZURERM = AZURE.backendBlock as BackendBlockRule;
const AZURE_BACKEND = "fixturedevstore/tfstate/dev.tfstate";
const azure = (body: string, type = "azurerm") => `terraform {\n  backend "${type}" {\n${body}\n  }\n}\n`;
const azureVerdict = (files: Record<string, string>) => verdict(files, AZURERM, AZURE_BACKEND);

test("azurerm: no block, an empty one, Entra ID on, OIDC on, or the contract's own storage account, container and key pass", () => {
  assert.equal(azureVerdict({ "main.tf": 'resource "azurerm_resource_group" "x" {}\n' }), "ok");
  assert.equal(azureVerdict({ "main.tf": azure("") }), "ok");
  assert.equal(azureVerdict({ "main.tf": azure("use_azuread_auth = true") }), "ok");
  assert.equal(azureVerdict({ "main.tf": azure('storage_account_name = "fixturedevstore"\ncontainer_name = "tfstate"\nkey = "dev.tfstate"\nuse_oidc = true\nuse_azuread_auth = true # Entra ID') }), "ok");
  assert.equal(azureVerdict({ "main.tf.json": JSON.stringify({ terraform: { backend: { azurerm: { key: "dev.tfstate", use_azuread_auth: true } } } }) }), "ok");
});

test("azurerm: a shared key or SAS token, another credential or auth path, another endpoint, cloud or lookup, a snapshot setting or any other attribute is refused", () => {
  for (const body of [
    'access_key = "fakekey"', 'sas_token = "?sv=fake"', "use_msi = true", 'msi_endpoint = "http://169.254.169.254"', "use_cli = true",
    'client_id = "11111111-1111-4111-8111-111111111111"', 'client_secret = "fake"', 'client_certificate_path = "/x.pfx"', 'client_certificate_password = "x"',
    'tenant_id = "11111111-1111-4111-8111-111111111111"', 'subscription_id = "22222222-2222-4222-8222-222222222222"', 'oidc_token_file_path = "/run/x"', 'oidc_token = "x"', 'oidc_request_url = "https://attacker.example"',
    'endpoint = "https://attacker.example"', 'metadata_host = "attacker.example"', 'environment = "usgovernment"', 'resource_group_name = "rg"', "snapshot = true",
    "use_microsoft_graph = true", 'custom = { a = 1 }', '"quoted" = 1',
  ]) assert.equal(azureVerdict({ "main.tf": azure("use_azuread_auth = true\n" + body) }), NOT_ALLOWED, body);
  assert.equal(azureVerdict({ "main.tf": azure("use_azuread_auth = true\nuse_oidc {\n  a = 1\n}") }), NOT_ALLOWED, "a nested block is an attribute too");
  assert.equal(azureVerdict({ "main.tf": azure('bucket = "b"', "s3") }), NOT_ALLOWED, "another backend type");
  assert.equal(azureVerdict({ "main.tf": 'terraform {\n  cloud {\n    hostname = "attacker.example"\n  }\n}\n' }), NOT_ALLOWED);
  assert.equal(azureVerdict({ "main.tf.json": JSON.stringify({ terraform: { backend: { azurerm: { sas_token: "x" } } } }) }), NOT_ALLOWED);
});

test("azurerm: another storage account, container or key than the contract's, Entra ID or OIDC off, or an expression for any of them is refused before init", () => {
  for (const body of [
    'storage_account_name = "attackerstore"', 'container_name = "other"', 'key = "prod.tfstate"', 'key = "tfstate/dev.tfstate"',
    "use_azuread_auth = false", "use_oidc = false", 'use_azuread_auth = "true"', "use_azuread_auth = 1",
    "storage_account_name = var.account", 'storage_account_name = "${var.account}"', 'storage_account_name = "fixture${"dev"}store"', 'key = local.key',
    'storage_account_name = "fixturedevstore"\nstorage_account_name = "attackerstore"', 'use_azuread_auth = true\nuse_azuread_auth = false',
    "use_azuread_auth = true || false", 'storage_account_name = upper("fixturedevstore")', 'storage_account_name = "FixtureDevStore"',
  ]) assert.equal(azureVerdict({ "main.tf": azure(body) }), NOT_ALLOWED, body);
  for (const settings of [{ storage_account_name: "attackerstore" }, { use_azuread_auth: false }, { use_azuread_auth: "true" }, { key: "${var.key}" }, { storage_account_name: ["fixturedevstore"] }, { key: 7 }]) {
    assert.equal(azureVerdict({ "main.tf.json": JSON.stringify({ terraform: { backend: { azurerm: settings } } }) }), NOT_ALLOWED, JSON.stringify(settings));
  }
  // The literals are the contract's: the same block passes for its own backend and fails for another environment's.
  const own = azure('storage_account_name = "fixturedevstore"\ncontainer_name = "tfstate"\nkey = "dev.tfstate"\nuse_azuread_auth = true');
  assert.equal(verdict({ "main.tf": own }, AZURERM, AZURE_BACKEND), "ok");
  assert.equal(verdict({ "main.tf": own }, AZURERM, "fixtureprodstore/tfstate/prod.tfstate"), NOT_ALLOWED);
  // The s3 rule pins no literal, so its values stay unjudged here (the saved backend is judged after init).
  assert.equal(verdict({ "main.tf": block('bucket = "attacker"\nkey = var.k') }), "ok");
});
