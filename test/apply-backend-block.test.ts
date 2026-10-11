import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertBackendBlock } from "../src/apply/backend-block.js";
import { codeOf } from "../src/apply/engine.js";

// docs/act-pilot-apply.md, "Providers". The project's own backend block is judged before `terraform init` reads it:
// init already sends credentials, so a check after init cannot protect init. Pure parsing; no engine runs.

const ALLOWED = { type: "s3", attributes: ["bucket", "key", "region", "use_lockfile"] } as const;
const verdict = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "alz-backend-block-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    try { assertBackendBlock(dir, ALLOWED); return "ok"; } catch (error) { return codeOf(error); }
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
