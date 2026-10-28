import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runApply, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { codeOf } from "../src/apply/engine.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import {
  ACTION_NOT_ALLOWED, CONSTRUCTS_DUPLICATE_KEY, CONSTRUCTS_TOO_DEEP, CONSTRUCTS_UNREADABLE, EPHEMERAL_NOT_ALLOWED, EPHEMERAL_WORD_IN_SOURCE, PROVISIONER_NOT_ALLOWED,
  PROVISIONER_WORD_IN_SOURCE, planJudgeRefusal, sourceRuleHint, strictJson,
  assertNoRefusedSourceConstructs, assertNoRefusedPlanConstructs,
} from "../src/apply/terraform-constructs.js";
import type { ApplyEnvironment, SignedApproval } from "../src/apply/types.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import {
  escapeRegExp,
  NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsTargetOf, behave as behaveIn, callsOf, contractJson, human,
  identityEnv, installFakeTerraform, targetOf, testFixtureForgeQualificationEvidence, writeProject, writeReviewedContract, type Behavior,
} from "./helpers/apply-fixtures.js";

// Review 6453264963 of #322, N2: provisioners, Terraform actions and ephemeral resources are refused on every Terraform path,
// whatever the provider. The `show -json` shapes are real: test/fixtures/live/terraform/aws-constructs.* and aws-ephemeral.* are
// Terraform 1.16.4 with hashicorp/aws 6.68.0 output, azure-constructs.* is Terraform 1.16.4 with hashicorp/azurerm 4.81.0 and
// hashicorp/null 3.2.4 in the JSON configuration syntax, and removed-provisioner.* is Terraform 1.16.4 with a real state, all
// planned offline from a local provider mirror with fake keys on 2026-10-27 (nothing reached AWS or Azure). The driver
// tests use the fake engine, so they pin the product's logic, NOT real-engine or real-cloud behavior. SYNTHETIC.

const FIXTURES = new URL("./fixtures/live/terraform/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const codeFrom = (run: () => unknown): string => { try { run(); return "OK"; } catch (error) { return codeOf(error); } };
const planCode = (document: unknown): string => codeFrom(() => assertNoRefusedPlanConstructs(document));
type Doc = {
  action_invocations?: unknown[];
  configuration: { root_module: { actions?: unknown[]; resources: { provisioners?: unknown[] }[]; module_calls: Record<string, { module: { actions?: unknown[]; resources: { provisioners?: unknown[] }[] } }> } };
};
const realConstructs = (): Doc => JSON.parse(fixture("aws-constructs.plan.json")) as Doc;

const root = mkdtempSync(join(tmpdir(), "alz-constructs-"));
test.after(() => removeTree(root));
let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** A directory holding `files` (relative path to text). */
const tree = (files: Record<string, string>): string => {
  const dir = fresh("tree");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const sourceCode = (files: Record<string, string>): string => codeFrom(() => assertNoRefusedSourceConstructs(tree(files)));

// --- the plan half ------------------------------------------------------------------------------------------

test("real Terraform 1.16.4 output: a provisioner, an action and an invocation are each refused, in the root module and in a nested module", () => {
  const real = realConstructs();
  // What real Terraform lists, so the judge reads the real shape and not a guess.
  assert.equal(real.action_invocations?.length, 2, "both invocations are listed");
  assert.equal(real.configuration.root_module.actions?.length, 1);
  assert.equal(real.configuration.root_module.module_calls.child!.module.actions?.length, 1);
  assert.deepEqual(real.configuration.root_module.resources.flatMap((r) => r.provisioners ?? []).map((p) => (p as { type: string }).type), ["local-exec"]);
  assert.deepEqual(real.configuration.root_module.module_calls.child!.module.resources.flatMap((r) => r.provisioners ?? []).map((p) => (p as { type: string }).type), ["remote-exec"]);
  assert.equal(planCode(real), ACTION_NOT_ALLOWED, "the plan as Terraform wrote it");

  // Peel one construct at a time, so each refusal is shown on its own, nested ones included.
  const peeled = realConstructs();
  delete peeled.action_invocations;
  assert.equal(planCode(peeled), ACTION_NOT_ALLOWED, "the declared actions without their invocations");
  delete peeled.configuration.root_module.actions;
  for (const resource of peeled.configuration.root_module.resources) delete resource.provisioners;
  assert.equal(planCode(peeled), ACTION_NOT_ALLOWED, "a declared action in a nested module, with nothing refused in the root module");
  delete peeled.configuration.root_module.module_calls.child!.module.actions;
  assert.equal(planCode(peeled), PROVISIONER_NOT_ALLOWED, "remote-exec in a nested module only");
  for (const resource of peeled.configuration.root_module.module_calls.child!.module.resources) delete resource.provisioners;
  assert.equal(planCode(peeled), "OK", "with none of the three left, the same plan passes this judge");

  // local-exec on terraform_data in the root module, alone.
  const rootOnly = realConstructs();
  delete rootOnly.action_invocations;
  delete rootOnly.configuration.root_module.actions;
  delete rootOnly.configuration.root_module.module_calls.child!.module.actions;
  for (const resource of rootOnly.configuration.root_module.module_calls.child!.module.resources) delete resource.provisioners;
  assert.equal(planCode(rootOnly), PROVISIONER_NOT_ALLOWED, "local-exec on terraform_data in the root module only");

  // An invocation alone, with no declaration in the configuration, is refused too.
  const invocationOnly = realConstructs();
  delete invocationOnly.configuration.root_module.actions;
  delete invocationOnly.configuration.root_module.module_calls.child!.module.actions;
  for (const resource of [...invocationOnly.configuration.root_module.resources, ...invocationOnly.configuration.root_module.module_calls.child!.module.resources]) delete resource.provisioners;
  assert.equal(planCode(invocationOnly), ACTION_NOT_ALLOWED);
  assert.equal(planCode({ ...invocationOnly, action_invocations: undefined, deferred_action_invocations: [{}] }), ACTION_NOT_ALLOWED, "a deferred invocation");
});

test("real Terraform 1.16.4 output in the JSON syntax, AzureRM project: local-exec on terraform_data and file and remote-exec on a nested null_resource are refused", () => {
  type Az = { configuration: { root_module: { resources: { provisioners?: { type: string }[] }[]; module_calls: Record<string, { module: { resources: { provisioners?: { type: string }[] }[] } }> } } };
  const real = (): Az => JSON.parse(fixture("azure-constructs.plan.json")) as Az;
  const document = real();
  assert.deepEqual(document.configuration.root_module.resources.flatMap((r) => r.provisioners ?? []).map((p) => p.type), ["local-exec"]);
  assert.deepEqual(document.configuration.root_module.module_calls.child!.module.resources.flatMap((r) => r.provisioners ?? []).map((p) => p.type), ["file", "remote-exec"]);
  assert.equal(planCode(document), PROVISIONER_NOT_ALLOWED);
  const nestedOnly = real();
  for (const resource of nestedOnly.configuration.root_module.resources) delete resource.provisioners;
  assert.equal(planCode(nestedOnly), PROVISIONER_NOT_ALLOWED, "the nested null_resource alone");
  for (const resource of nestedOnly.configuration.root_module.module_calls.child!.module.resources) delete resource.provisioners;
  assert.equal(planCode(nestedOnly), "OK", "the control: the same plan with no provisioner");
  // The source half refuses the same project from its JSON files, before any plan.
  assert.equal(sourceCode({ "main.tf.json": fixture("azure-constructs.main.tf.json"), "child/main.tf.json": fixture("azure-constructs.child.tf.json") }), PROVISIONER_NOT_ALLOWED);
  assert.equal(sourceCode({ "main.tf.json": '{"module": {"child": {"source": "./child"}}}', "child/main.tf.json": fixture("azure-constructs.child.tf.json") }), PROVISIONER_NOT_ALLOWED, "nested module only");
});

test("real Terraform 1.16.4 output does not list a removed block or its destroy-time provisioner: the plan shows a plain delete, so the source half refuses it", () => {
  const text = fixture("removed-provisioner.plan.json");
  assert.doesNotMatch(text, /provisioner|local-exec|echo removed|"removed"/, "no trace of the removed block or its command");
  const document = JSON.parse(text) as { resource_changes: { address: string; change: { actions: string[] }; action_reason: string }[] };
  assert.deepEqual(document.resource_changes.map((c) => [c.address, c.change.actions, c.action_reason]), [["terraform_data.gone", ["delete"], "delete_because_no_resource_config"]]);
  assert.equal(planCode(document), "OK", "the limit, recorded");
  assert.match(fixture("removed-provisioner.main.tf"), /^removed \{[\s\S]*provisioner "local-exec"/m);
  assert.equal(sourceCode({ "main.tf": fixture("removed-provisioner.main.tf"), "child/main.tf": fixture("removed-provisioner.child.tf") }), PROVISIONER_WORD_IN_SOURCE);
  assert.equal(sourceCode({ "main.tf": 'module "child" {\n  source = "./child"\n}\n', "child/main.tf": fixture("removed-provisioner.child.tf") }), PROVISIONER_WORD_IN_SOURCE, "nested module only");
  assert.equal(sourceCode({ "main.tf.json": JSON.stringify({ removed: [{ from: "terraform_data.gone", lifecycle: { destroy: true }, provisioner: [{ "local-exec": { when: "destroy", command: "id" } }] }] }) }), PROVISIONER_NOT_ALLOWED, "the JSON syntax");
});

test("B1 (review of #327): a duplicate key in .tf.json cannot hide a removed block's provisioner; real Terraform 1.16.4 ran it, the judge refuses it", () => {
  const text = fixture("removed-duplicate-key.main.tf.json");
  // The fixture is the reviewer's shape, byte for byte: two "removed" keys in one object, the first with a destroy-time local-exec.
  assert.equal(text.match(/"removed"/g)?.length, 2);
  assert.match(text, /"provisioner": \{"local-exec"/);
  // What JSON.parse makes of it: the first block, and its provisioner, are gone. That is the bypass.
  assert.equal(JSON.stringify(JSON.parse(text)).includes("provisioner"), false, "JSON.parse keeps only the last key");
  // Real Terraform planned two plain deletes and listed no provisioner, so the plan half cannot see it; Terraform's apply then ran it.
  const plan = fixture("removed-duplicate-key.plan.json");
  assert.doesNotMatch(plan, /provisioner|local-exec|REMOVED-DUPLICATE-KEY|"removed"/);
  assert.deepEqual((JSON.parse(plan) as { resource_changes: { address: string; action_reason: string }[] }).resource_changes.map((c) => [c.address, c.action_reason]),
    [["terraform_data.x", "delete_because_no_resource_config"], ["terraform_data.y", "delete_because_no_resource_config"]]);
  assert.equal(planCode(JSON.parse(plan)), "OK", "the limit, recorded");
  // The source half refuses the file for its repeated key, before any key or word is judged, in the root module or a nested one.
  assert.equal(sourceCode({ "main.tf.json": text }), CONSTRUCTS_DUPLICATE_KEY);
  assert.equal(sourceCode({ "main.tf": 'module "child" {\n  source = "./child"\n}\n', "child/main.tf.json": text }), CONSTRUCTS_DUPLICATE_KEY, "nested module only");
  // Even with the repeated key removed, the provisioner is refused.
  assert.equal(sourceCode({ "main.tf.json": text.replace(/,\n\s*"removed": \{"from": "terraform_data\.y"[^\n]*\n/, "\n") }), PROVISIONER_NOT_ALLOWED);
});

test("strictJson reads strict JSON as Terraform does: a repeated key anywhere, escaped or not, is refused; anything not strict JSON is unreadable", () => {
  const code = (text: string): string => codeFrom(() => strictJson(text));
  for (const [label, text] of [
    ["top level", '{"a": 1, "a": 2}'],
    ["nested", '{"resource": {"t": {"n": {}, "n": {}}}}'],
    ["in a list", '[{"x": 1}, {"y": 1, "y": 2}]'],
    ["an escaped duplicate", '{"removed": {}, "\\u0072emoved": {}}'],
    ["a solidus escape", '{"a/b": 1, "a\\/b": 2}'],
    ["__proto__ twice", '{"__proto__": {}, "__proto__": {}}'],
  ] as const) assert.equal(code(text), CONSTRUCTS_DUPLICATE_KEY, label);
  for (const [label, text] of [
    ["trailing comma", '{"a": 1,}'], ["a comment", '{"a": 1 /* x */}'], ["single quotes", "{'a': 1}"], ["a bare word", "{a: 1}"],
    ["a raw control character", '{"a": "x\ny"}'], ["a bad escape", '{"a": "\\x"}'], ["a short unicode escape", '{"a": "\\u12"}'],
    ["trailing text", '{"a": 1} x'], ["two values", "{} {}"], ["empty", ""], ["a leading zero", '{"a": 01}'], ["NaN", '{"a": NaN}'],
    ["unterminated", '{"a": "x'], ["a missing colon", '{"a" 1}'],
  ] as const) assert.equal(code(text), CONSTRUCTS_UNREADABLE, label);
  // What it accepts it reads exactly as JSON.parse does, with every object free of a prototype.
  const sample = '{"a": [1, -2.5e3, true, false, null, "x\\u00e9\\n\\"y"], "b": {"c": {}}, "__proto__": {"d": 1}, "e": []}';
  const read = strictJson(sample) as Record<string, unknown>;
  assert.equal(JSON.stringify(read), JSON.stringify(JSON.parse(sample)));
  assert.equal(Object.getPrototypeOf(read), null);
  assert.deepEqual(Object.keys(read), ["a", "b", "__proto__", "e"], "a __proto__ key is an ordinary key");
  let deep = "";
  for (let level = 0; level < 300; level++) deep += "[";
  assert.equal(code(deep), CONSTRUCTS_TOO_DEEP);
});

test("N3 (review of #327): a source-rule refusal tells the operator that the word may be in a comment or a string; a duplicate key says what to fix", () => {
  for (const code of [PROVISIONER_WORD_IN_SOURCE, EPHEMERAL_WORD_IN_SOURCE]) assert.match(sourceRuleHint(code), /may be in a comment or a string/);
  assert.match(sourceRuleHint(CONSTRUCTS_DUPLICATE_KEY), /repeats a key/);
  for (const code of [PROVISIONER_NOT_ALLOWED, EPHEMERAL_NOT_ALLOWED, ACTION_NOT_ALLOWED, "PROVIDER_CONFIG_NOT_IN_CONTRACT"]) assert.equal(sourceRuleHint(code), "", code);
});

test("the source half refuses a provisioner block in any form, and fails closed on the word", () => {
  for (const [label, files] of [
    ["local-exec on terraform_data", { "main.tf": 'resource "terraform_data" "t" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}\n' }],
    ["remote-exec on null_resource, nested", { "main.tf": "", "m/main.tf": 'resource "null_resource" "n" {\n  provisioner "remote-exec" {\n    inline = ["id"]\n  }\n}\n' }],
    ["file, no space before the label", { "main.tf": 'resource "aws_instance" "i" {\n  provisioner"file" {}\n}\n' }],
    ["unquoted label", { "main.tf": "resource terraform_data t {\n  provisioner local-exec {}\n}\n" }],
    ["a comment (fails closed)", { "main.tf": "# no provisioner here\n" }],
    ["JSON, on a resource", { "main.tf.json": JSON.stringify({ resource: { terraform_data: { t: { provisioner: [{ "local-exec": { command: "id" } }] } } } }) }],
    ["JSON, escaped key, in a module", { "m/main.tf.json": '{"resource": {"null_resource": {"n": {"\\u0070rovisioner": {"local-exec": {"command": "id"}}}}}}' }],
  ] as const) assert.equal(sourceCode(files), (Object.keys(files) as string[]).some((name) => name.endsWith(".json")) ? PROVISIONER_NOT_ALLOWED : PROVISIONER_WORD_IN_SOURCE, label);
  // In JSON the word rule also runs over the raw text: a string value naming it is refused, lexically.
  assert.equal(sourceCode({ "main.tf.json": JSON.stringify({ locals: { note: "no provisioner here" } }) }), PROVISIONER_WORD_IN_SOURCE, "a JSON string (fails closed)");
  assert.equal(sourceCode({ "main.tf": 'locals {\n  provisioners = 1\n}\n' }), "OK", "a longer identifier");
  assert.equal(sourceCode({ "main.tf.json": JSON.stringify({ locals: { provisioners: 1 } }) }), "OK", "a longer key");
});

test("real Terraform 1.16.4 output does not list ephemeral resources at all: the plan half cannot see them, which is why the source half exists", () => {
  const text = fixture("aws-ephemeral.plan.json");
  assert.doesNotMatch(text, /ephemeral/i, "no trace of either ephemeral block, root or nested");
  assert.match(fixture("aws-ephemeral.main.tf"), /^ephemeral "aws_secretsmanager_secret_version" "e"/m);
  assert.match(fixture("aws-ephemeral.child.tf"), /^ephemeral "aws_ssm_parameter" "e"/m);
  assert.equal(planCode(JSON.parse(text)), "OK", "the limit, recorded");
  // Should a later `show -json` list one, by mode or by address, it is refused there as well.
  const resource = { address: "ephemeral.aws_ssm_parameter.e", mode: "ephemeral", type: "aws_ssm_parameter", name: "e", provider_config_key: "aws" };
  assert.equal(planCode({ configuration: { root_module: { resources: [resource] } } }), EPHEMERAL_NOT_ALLOWED);
  assert.equal(planCode({ configuration: { root_module: { module_calls: { c: { module: { resources: [{ ...resource, mode: "EPHEMERAL" }] } } } } } }), EPHEMERAL_NOT_ALLOWED);
  assert.equal(planCode({ resource_changes: [{ address: "module.c.ephemeral.aws_ssm_parameter.e", mode: "managed", type: "aws_ssm_parameter" }] }), EPHEMERAL_NOT_ALLOWED);
});

test("the plan half fails closed: a malformed tree is unreadable and a tree past 64 modules is too deep, never skipped", () => {
  const withResource = (resource: unknown) => ({ configuration: { root_module: { resources: [resource] } } });
  for (const [label, document] of [
    ["not an object", []], ["configuration not an object", { configuration: "x" }], ["root module not an object", { configuration: { root_module: [] } }],
    ["provisioners not a list", withResource({ address: "terraform_data.t", provisioners: { type: "local-exec" } })],
    ["actions not a list", { configuration: { root_module: { actions: { a: {} } } } }],
    ["invocations not a list", { action_invocations: "x" }], ["deferred invocations not a list", { deferred_action_invocations: {} }],
    ["resources not a list", { configuration: { root_module: { resources: {} } } }], ["a resource not an object", withResource("x")],
    ["module calls not an object", { configuration: { root_module: { module_calls: [] } } }],
    ["a module call not an object", { configuration: { root_module: { module_calls: { c: 1 } } } }],
    ["a changes entry not an object", { resource_changes: [null] }], ["changes not a list", { resource_changes: {} }],
  ] as const) assert.equal(planCode(document), CONSTRUCTS_UNREADABLE, label);
  const at = (depth: number, leaf: object) => {
    let module: Record<string, unknown> = { resources: [leaf] };
    for (let level = 0; level < depth; level++) module = { module_calls: { deep: { module } } };
    return { configuration: { root_module: module } };
  };
  const provisioned = { address: "terraform_data.t", mode: "managed", type: "terraform_data", provisioners: [{ type: "local-exec" }] };
  assert.equal(planCode(at(64, provisioned)), PROVISIONER_NOT_ALLOWED, "depth 64 is read");
  assert.equal(planCode(at(65, { address: "terraform_data.t", mode: "managed", type: "terraform_data" })), CONSTRUCTS_TOO_DEEP);
  // Empty lists and absent trees are simply empty.
  assert.equal(planCode({ action_invocations: [], configuration: { root_module: { actions: [], resources: [{ provisioners: [] }] } } }), "OK");
  assert.equal(planCode({}), "OK");
});

// --- the source half ----------------------------------------------------------------------------------------

test("the source half refuses an ephemeral block in any Terraform file, in the root module, a nested module or a directory the manifest does not capture", () => {
  const real = { "main.tf": fixture("aws-ephemeral.main.tf"), "child/main.tf": fixture("aws-ephemeral.child.tf") };
  assert.equal(sourceCode(real), EPHEMERAL_WORD_IN_SOURCE, "the real fixture's sources");
  assert.equal(sourceCode({ "main.tf": 'module "child" {\n  source = "./child"\n}\n', "child/main.tf": fixture("aws-ephemeral.child.tf") }), EPHEMERAL_WORD_IN_SOURCE, "nested module only");
  assert.equal(sourceCode({ "main.tf": "", "a/b/c/d/main.tf": 'ephemeral "aws_kms_secrets" "k" {}\n' }), EPHEMERAL_WORD_IN_SOURCE, "four directories down");
  assert.equal(sourceCode({ "main.tf": "", "node_modules/m/main.tf": 'ephemeral "aws_eks_cluster_auth" "a" {}\n' }), EPHEMERAL_WORD_IN_SOURCE, "a directory the manifest skips");
  assert.equal(sourceCode({ "main.tf": "", ".git/m/main.tf": 'ephemeral "aws_eks_cluster_auth" "a" {}\n' }), EPHEMERAL_WORD_IN_SOURCE);
  assert.equal(sourceCode({ "main.tf": 'module "child" {\n  source = "./child"\n}\n', "child/main.tf": fixture("aws-ephemeral.child.tf") }), EPHEMERAL_WORD_IN_SOURCE);
  for (const [label, text] of [
    ["unquoted labels", "ephemeral aws_ssm_parameter p {\n}\n"],
    ["after a comment on the same line", '/* x */ ephemeral "aws_ssm_parameter" "p" {}\n'],
    ["indented", '  ephemeral "aws_ssm_parameter" "p" {}\n'],
    ["no space before the label", 'ephemeral"aws_ssm_parameter" "p" {}\n'],
    ["a reference", 'resource "aws_s3_bucket" "b" {\n  bucket = ephemeral.aws_ssm_parameter.p.value\n}\n'],
    ["a comparison, not an assignment", 'locals {\n  x = ephemeral == 1\n}\n'],
    ["a comment (fails closed)", "# an ephemeral thing\n"],
    ["a string (fails closed)", 'locals {\n  x = "ephemeral"\n}\n'],
    ["a block in an override file", 'ephemeral "aws_ssm_parameter" "p" {}\n'],
  ] as const) assert.equal(sourceCode({ [label.includes("override") ? "x_override.tf" : "main.tf"]: text }), EPHEMERAL_WORD_IN_SOURCE, label);
  // The suffix is compared without regard to case.
  assert.equal(sourceCode({ "MAIN.TF": 'ephemeral "aws_ssm_parameter" "p" {}\n' }), EPHEMERAL_WORD_IN_SOURCE);
});

test("the source half allows ephemeral values, longer identifiers and files Terraform does not load for a plan", () => {
  for (const [label, text] of [
    ["an ephemeral variable", 'variable "token" {\n  type      = string\n  ephemeral = true\n}\n'],
    ["an ephemeral output, no spaces", 'output "o" {\n  value     = 1\n  ephemeral=true\n}\n'],
    ["the attribute across a line break", 'variable "token" {\n  ephemeral\n    = true\n}\n'],
    ["a longer identifier", 'resource "aws_s3_bucket" "aws_ephemeral_x" {\n  bucket = "my-ephemeral-env"\n}\n'],
    ["the word with a suffix", 'locals {\n  ephemerality = 1\n}\n'],
  ] as const) assert.equal(sourceCode({ "main.tf": text }), "OK", label);
  assert.equal(sourceCode({ "main.tf": "", "tests/x.tftest.hcl": 'ephemeral "aws_ssm_parameter" "p" {}\n', "q.tfquery.hcl": "ephemeral x y {}\n", "README.md": "ephemeral" }), "OK");
});

test("the source half reads JSON configuration as JSON: a top-level ephemeral key is refused however it is spelled, and an unreadable file fails closed", () => {
  assert.equal(sourceCode({ "main.tf.json": JSON.stringify({ ephemeral: { aws_ssm_parameter: { p: {} } } }) }), EPHEMERAL_NOT_ALLOWED);
  assert.equal(sourceCode({ "main.tf.json": '{"\\u0065phemeral": {"aws_ssm_parameter": {"p": {}}}}' }), EPHEMERAL_NOT_ALLOWED, "an escaped key");
  assert.equal(sourceCode({ "m/MAIN.TF.JSON": '﻿{"ephemeral": {}}' }), EPHEMERAL_NOT_ALLOWED, "upper-case suffix and a byte order mark, in a module");
  assert.equal(sourceCode({ "main.tf.json": JSON.stringify({ variable: { token: { type: "string", ephemeral: true } } }) }), "OK", "an ephemeral variable");
  assert.equal(sourceCode({ "main.tf.json": "{ not json" }), CONSTRUCTS_UNREADABLE);
  assert.equal(sourceCode({ "main.tf.json": "[]" }), CONSTRUCTS_UNREADABLE);
  const linked = tree({ "real/main.tf": "" });
  symlinkSync(join(linked, "real"), join(linked, "link"));
  assert.equal(codeFrom(() => assertNoRefusedSourceConstructs(linked)), CONSTRUCTS_UNREADABLE, "a symbolic link is neither a file nor a directory");
  assert.equal(codeFrom(() => assertNoRefusedSourceConstructs(join(root, "absent"))), CONSTRUCTS_UNREADABLE);
  let deep = "";
  for (let level = 0; level < 66; level++) deep += "d/";
  assert.equal(sourceCode({ [deep + "main.tf"]: "" }), CONSTRUCTS_TOO_DEEP);
});

// --- through the driver, for each Terraform provider wired on main ------------------------------------------

const toolDir = mkdtempSync(join(tmpdir(), "alz-constructs-tools-"));
test.after(() => removeTree(toolDir));
installFakeTerraform(toolDir);
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root); // the vault writes sealed plans under ./.runs
const KILL = join(root, "KILL");

type Provider = {
  name: "AWS" | "AZURE"; vault: string; contract: () => unknown; env: (e: ApplyEnvironment) => NodeJS.ProcessEnv; target: (e: ApplyEnvironment) => ResolvedTarget;
  show: Behavior; mainTf: string;
};
const AWS_PROVIDER = { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } };
const PROVIDERS: Provider[] = [
  { name: "AWS", vault: "", contract: () => awsContractJson(KILL), env: awsIdentityEnv, target: awsTargetOf, show: { showProviderConfig: { aws: AWS_PROVIDER } }, mainTf: 'resource "aws_s3_bucket" "pilot" {}\n' },
  { name: "AZURE", vault: "", contract: () => contractJson(KILL), env: identityEnv, target: targetOf, show: {}, mainTf: 'resource "azurerm_resource_group" "pilot" {}\n' },
];
test.before(async () => {
  for (const provider of PROVIDERS) {
    provider.vault = fresh("qualification-" + provider.name);
    await testFixtureForgeQualificationEvidence(provider.vault, undefined, provider.name);
  }
});

function harness(provider: Provider) {
  const behave = (behavior: Behavior = {}) => behaveIn(toolDir, KILL, { ...provider.show, ...behavior });
  behave({ applyAdvance: true });
  const dirs = { scratch: fresh("scratch"), evidence: fresh("evidence"), nonces: fresh("nonces") };
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writeReviewedContract(contractPath, provider.contract());
  const deps: ApplyDeps = {
    sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: provider.vault, evidenceDir: dirs.evidence, nonces: openNonceStore(dirs.nonces),
    env: provider.env("DEV"), now: () => NOW, scratchParent: dirs.scratch, toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
  };
  /** A project whose files are `extra` plus main.tf, written before the manifest is built, so the manifest binds them. */
  const project = (extra: Record<string, string> = {}, mainTf = provider.mainTf) => {
    const dir = fresh("project");
    for (const [path, text] of Object.entries(extra)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return writeProject(dir, provider.target("DEV"), mainTf);
  };
  const sealWith = (p: ReturnType<typeof project>) => sealPreview({
    invocation: human(provider.target("DEV")), environment: "DEV", target: provider.target("DEV"), manifest: p.manifest, projectRoot: p.projectRoot,
    policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER,
  }, deps);
  const applyWith = async (p: ReturnType<typeof project>, path: string, approvals: SignedApproval[]) => {
    const loaded = await loadSealedPlan(path);
    assert.ok(loaded.ok);
    return runApply({
      invocation: human(loaded.sealed.target), environment: "DEV", target: { ...loaded.sealed.target }, sealedPlan: { sealed: loaded.sealed, planBytes: loaded.planBytes },
      manifest: p.manifest, projectRoot: p.projectRoot, approvals,
    }, deps);
  };
  const applies = () => callsOf(toolDir).filter((c) => c.args[0] === "apply").length;
  const plans = () => callsOf(toolDir).filter((c) => c.args[0] === "plan").length;
  return { behave, dirs, project, sealWith, applyWith, applies, plans };
}

/** Each construct as the fake engine's `show` reports it, in the root module and one module down. */
const PLAN_CONSTRUCTS: Array<[string, string, Behavior]> = [
  ["local-exec on terraform_data, root", PROVISIONER_NOT_ALLOWED, { showConfigurationExtra: { root_module: { resources: [
    { address: "terraform_data.t", mode: "managed", type: "terraform_data", name: "t", provider_config_key: "terraform", provisioners: [{ type: "local-exec", expressions: { command: { constant_value: "id" } } }] }] } } }],
  ["remote-exec on null_resource, nested", PROVISIONER_NOT_ALLOWED, { showConfigurationExtra: { root_module: { module_calls: { child: { source: "./child", module: { resources: [
    { address: "null_resource.n", mode: "managed", type: "null_resource", name: "n", provider_config_key: "child:null", provisioners: [{ type: "remote-exec" }] }] } } } } } }],
  ["a file provisioner on a cloud resource, nested", PROVISIONER_NOT_ALLOWED, { showConfigurationExtra: { root_module: { module_calls: { child: { source: "./child", module: { resources: [
    { address: "aws_instance.i", mode: "managed", type: "aws_instance", name: "i", provider_config_key: "child:aws", provisioners: [{ type: "file" }] }] } } } } } }],
  ["a declared action, root", ACTION_NOT_ALLOWED, { showConfigurationExtra: { root_module: { actions: [{ address: "action.aws_lambda_invoke.a", type: "aws_lambda_invoke", name: "a", provider_config_key: "aws" }] } } }],
  ["a declared action, nested", ACTION_NOT_ALLOWED, { showConfigurationExtra: { root_module: { module_calls: { child: { source: "./child", module: { actions: [{ address: "action.aws_sns_publish.a", type: "aws_sns_publish" }] } } } } } }],
  ["an invocation", ACTION_NOT_ALLOWED, { showDocumentExtra: { action_invocations: [{ address: "module.child.action.aws_lambda_invoke.a", type: "aws_lambda_invoke", provider_name: "registry.terraform.io/hashicorp/aws" }] } }],
  ["an ephemeral resource, should show list one", EPHEMERAL_NOT_ALLOWED, { showConfigurationExtra: { root_module: { resources: [
    { address: "ephemeral.aws_ssm_parameter.p", mode: "ephemeral", type: "aws_ssm_parameter", name: "p", provider_config_key: "aws" }] } } }],
];

for (const provider of PROVIDERS) {
  test(provider.name + ": a provisioner, an action or an invocation in the plan stops the seal and, if it appears only at apply, stops the apply before anything is spent", async () => {
    for (const [label, code, behavior] of PLAN_CONSTRUCTS) {
      const h = harness(provider);
      h.behave(behavior);
      const refusedSeal = await h.sealWith(h.project());
      assert.equal(refusedSeal.ok, false, label);
      assert.equal((refusedSeal as { code: string }).code, "ARTIFACT_INVALID", label);
      assert.match((refusedSeal as { message: string }).message, new RegExp(escapeRegExp(code)), label);
      assert.deepEqual(readdirSync(h.dirs.scratch), [], "no scratch directory survives: " + label);

      // Sealed clean; the apply re-derives the change list from the plan bytes and meets the construct there.
      h.behave({ applyAdvance: true });
      const p = h.project();
      const sealed = await h.sealWith(p);
      assert.ok(sealed.ok, JSON.stringify(sealed));
      const approvals = [approvalFor(sealed.sealed, "alice")];
      h.behave({ ...behavior, applyAdvance: true });
      const before = h.applies();
      const result = await h.applyWith(p, sealed.path, approvals);
      assert.equal(result.ok, false, label);
      assert.match((result as { message: string }).message, new RegExp(escapeRegExp(code)), label);
      // Round 2 N2 (review of #327): the judge's own refusal surfaces, not a generic "could not start".
      assert.equal((result as { code: string }).code, "ARTIFACT_INVALID", label);
      assert.match((result as { message: string }).message, /Terraform construct the pilot refuses/, label);
      assert.equal(h.applies(), before, "no apply ran: " + label);
      assert.deepEqual(readdirSync(h.dirs.evidence), [], "nothing recorded: " + label);
      // Nothing was spent: the same approvals apply once the plan is clean again.
      h.behave({ applyAdvance: true });
      assert.ok((await h.applyWith(p, sealed.path, approvals)).ok, "the approvals were not consumed: " + label);
    }
  });

  test(provider.name + ": an ephemeral block or a removed block's provisioner in the project, root or nested module, stops the seal before init or any plan runs", async () => {
    for (const [label, code, extra, mainTf] of [
      ["root module", EPHEMERAL_WORD_IN_SOURCE, {}, provider.mainTf + 'ephemeral "aws_ssm_parameter" "p" {\n  arn = "x"\n}\n'],
      ["nested module", EPHEMERAL_WORD_IN_SOURCE, { "modules/app/main.tf": 'ephemeral "azurerm_key_vault_secret" "s" {\n  name = "x"\n}\n' }, provider.mainTf + 'module "app" {\n  source = "./modules/app"\n}\n'],
      ["JSON configuration in a nested module", EPHEMERAL_NOT_ALLOWED, { "modules/app/main.tf.json": JSON.stringify({ ephemeral: { random_password: { p: { length: 16 } } } }) }, provider.mainTf],
      ["a removed block's destroy-time local-exec", PROVISIONER_WORD_IN_SOURCE, {}, provider.mainTf + fixture("removed-provisioner.child.tf")],
      ["a .tf.json with a repeated key hiding a removed block's provisioner (B1)", CONSTRUCTS_DUPLICATE_KEY, { "modules/app/main.tf.json": fixture("removed-duplicate-key.main.tf.json") }, provider.mainTf + 'module "app" {\n  source = "./modules/app"\n}\n'],
      ["a removed block's provisioner in a nested module", PROVISIONER_WORD_IN_SOURCE, { "modules/app/main.tf": fixture("removed-provisioner.child.tf") }, provider.mainTf + 'module "app" {\n  source = "./modules/app"\n}\n'],
    ] as const) {
      const h = harness(provider);
      const before = h.plans();
      const initsBefore = callsOf(toolDir).filter((c) => c.args[0] === "init").length;
      const refusedSeal = await h.sealWith(h.project(extra, mainTf));
      assert.equal(refusedSeal.ok, false, label);
      assert.match((refusedSeal as { message: string }).message, new RegExp(escapeRegExp(code)), label);
      // N3: the operator is told what the lexical rule matched, and how to fix a repeated key.
      if (code === PROVISIONER_WORD_IN_SOURCE || code === EPHEMERAL_WORD_IN_SOURCE) assert.match((refusedSeal as { message: string }).message, /may be in a comment or a string/, label);
      if (code === CONSTRUCTS_DUPLICATE_KEY) assert.match((refusedSeal as { message: string }).message, /repeats a key/, label);
      assert.equal(h.plans(), before, "no plan ran: " + label);
      assert.equal(callsOf(toolDir).filter((c) => c.args[0] === "init").length, initsBefore, "no init ran: " + label);
      assert.deepEqual(readdirSync(h.dirs.scratch), [], "no scratch directory survives: " + label);
    }
    // The control: an ephemeral variable is a value, not a resource, and seals.
    const h = harness(provider);
    const ok = await h.sealWith(h.project({}, provider.mainTf + 'variable "token" {\n  type      = string\n  ephemeral = true\n}\n'));
    assert.ok(ok.ok, JSON.stringify(ok));
  });
}

test("AZURE (RB2): a module-nested use of an unreviewed or lookalike provider stops the seal; a nested azurerm use seals", async () => {
  const azure = PROVIDERS.find((p) => p.name === "AZURE")!;
  const nested = (resource: Record<string, unknown>): Behavior => ({ showConfigurationExtra: { root_module: { module_calls: { app: { source: "./modules/app", module: { module_calls: { deep: { source: "./deep", module: { resources: [resource] } } } } } } } } });
  for (const [label, behavior] of [
    ["an aws resource two modules down", nested({ address: "aws_s3_bucket.b", mode: "managed", type: "aws_s3_bucket", name: "b", provider_config_key: "app.deep:aws" })],
    ["a lookalike azurerm by its provider name in the plan", { showResources: [{ address: "module.app.azurerm_resource_group.g", type: "azurerm_resource_group", provider_name: "registry.terraform.io/attacker/azurerm", change: { actions: ["create"], before: null, after: {} } }] }],
    ["a nested resource whose provider is unnamed", { showResources: [{ address: "module.app.azurerm_resource_group.g", type: "azurerm_resource_group", provider_name: null, change: { actions: ["create"], before: null, after: {} } }] }],
  ] as const) {
    const h = harness(azure);
    h.behave(behavior as Behavior);
    const refused = await h.sealWith(h.project());
    assert.equal(refused.ok, false, label);
    assert.match((refused as { message: string }).message, /PROVIDER_CONFIG_NOT_IN_CONTRACT/, label);
  }
  const h = harness(azure);
  h.behave(nested({ address: "azurerm_resource_group.g", mode: "managed", type: "azurerm_resource_group", name: "g", provider_config_key: "app.deep:azurerm" }));
  const ok = await h.sealWith(h.project());
  assert.ok(ok.ok, JSON.stringify(ok));
});

/**
 * Real `terraform init` lock-file syntax (Terraform 1.16.4, offline mirror, 2026-10-27): the reviewed hashicorp/aws 6.68.0 and
 * hashicorp/azurerm 4.81.0 entries as init wrote them, and hashicorp/null 3.2.4. `sealLockWith` swaps a version in place.
 */
const REAL_LOCK_SEAL = [
  '# This file is maintained automatically by "terraform init".', "# Manual edits may be lost in future updates.", "",
  'provider "registry.terraform.io/hashicorp/aws" {', '  version     = "6.68.0"', '  constraints = ">= 5.0.0, < 7.0.0"', "  hashes = [",
  '    "h1:79hHQtjGSCiXBZK+VDiNUdI2SLXbNaHf+CHySvKFnvA=",', "  ]", "}", "",
  'provider "registry.terraform.io/hashicorp/azurerm" {', '  version     = "4.81.0"', '  constraints = "4.81.0"', "  hashes = [",
  '    "h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg=",', "  ]", "}", "",
  'provider "registry.terraform.io/hashicorp/null" {', '  version     = "3.2.4"', "}", "",
].join("\n");
const sealLockWith = (source: "aws" | "azurerm" | "null", version: string): string =>
  REAL_LOCK_SEAL.replace(new RegExp("(" + escapeRegExp('provider "registry.terraform.io/hashicorp/' + source + '" {\n  version     = "') + ')[^"]+"'), "$1" + version + '"');

for (const provider of PROVIDERS) {
  test(provider.name + ": the seal refuses a bound lock that pins aws or azurerm at a version the denied types were not reviewed against, before init (review of #327, round 4)", async () => {
    for (const [source, version] of [["aws", "6.69.0"], ["aws", "6.67.0"], ["azurerm", "4.82.0"], ["azurerm", "4.80.0"]] as const) {
      const h = harness(provider);
      const initsBefore = callsOf(toolDir).filter((c) => c.args[0] === "init").length;
      const p = writeProject(fresh("project"), provider.target("DEV"), provider.mainTf, sealLockWith(source, version));
      const refusedSeal = await h.sealWith(p);
      assert.equal(refusedSeal.ok, false, source + " " + version);
      assert.match((refusedSeal as { message: string }).message, /PROVIDER_VERSION_NOT_REVIEWED/, source + " " + version);
      assert.match((refusedSeal as { message: string }).message, /reviewed: registry\.terraform\.io\/hashicorp\/aws 6\.68\.0, registry\.terraform\.io\/hashicorp\/azurerm 4\.81\.0\)/);
      assert.equal(callsOf(toolDir).filter((c) => c.args[0] === "init").length, initsBefore, "no init ran");
      assert.deepEqual(readdirSync(h.dirs.scratch), [], "no scratch directory survives");
    }
    // The exact reviewed versions seal, and another provider's version is not judged.
    for (const lock of [REAL_LOCK_SEAL, sealLockWith("null", "3.2.5")]) {
      const h = harness(provider);
      const sealed = await h.sealWith(writeProject(fresh("project"), provider.target("DEV"), provider.mainTf, lock));
      assert.ok(sealed.ok, JSON.stringify(sealed));
    }
  });
}

test("at apply and cleanup the same refusal surfaces by the judge's code and the reviewed versions (review of #327, round 4)", () => {
  const judged = planJudgeRefusal("PROVIDER_VERSION_NOT_REVIEWED");
  assert.equal(judged?.refusal, "ARTIFACT_INVALID");
  assert.match(judged!.message, /\(PROVIDER_VERSION_NOT_REVIEWED\)\. The lock file pins a provider version the denied-type lists were not reviewed against \(reviewed: registry\.terraform\.io\/hashicorp\/aws 6\.68\.0, registry\.terraform\.io\/hashicorp\/azurerm 4\.81\.0\)/);
});

for (const provider of PROVIDERS) {
  test(provider.name + ": after init, what Terraform actually selected is judged before any plan: a foreign or unadmitted source, an unreviewed version, or unreadable selections stop the seal (review of #327, round 5)", async () => {
    const own = provider.name === "AWS" ? "registry.terraform.io/hashicorp/aws" : "registry.terraform.io/hashicorp/azurerm";
    const reviewed = provider.name === "AWS" ? "6.68.0" : "4.81.0";
    for (const [label, selections, code] of [
      ["the cloud's provider at an unreviewed version", { [own]: provider.name === "AWS" ? "6.70.0" : "4.82.0" }, "PROVIDER_VERSION_NOT_REVIEWED"],
      ["the same provider from an OpenTofu registry host", { ["registry.opentofu.org/hashicorp/" + own.split("/").pop()]: reviewed }, "PROVIDER_NOT_ADMITTED"],
      ["an aliased source in another namespace", { ["registry.terraform.io/attacker/" + own.split("/").pop()]: reviewed }, "PROVIDER_NOT_ADMITTED"],
      ["the other cloud", { [provider.name === "AWS" ? "registry.terraform.io/hashicorp/azurerm" : "registry.terraform.io/hashicorp/aws"]: provider.name === "AWS" ? "4.81.0" : "6.68.0" }, "PROVIDER_NOT_ADMITTED"],
      ["azapi", { "registry.terraform.io/azure/azapi": "2.7.0" }, "PROVIDER_NOT_ADMITTED"],
      ["selections missing", null, "PROVIDER_SELECTIONS_UNREADABLE"],
      ["selections not an object", "aws", "PROVIDER_SELECTIONS_UNREADABLE"],
      ["a version that is not text", { [own]: 6 }, "PROVIDER_SELECTIONS_UNREADABLE"],
    ] as const) {
      const h = harness(provider);
      h.behave({ providerSelections: selections as never });
      const before = h.plans();
      const refusedSeal = await h.sealWith(h.project());
      assert.equal(refusedSeal.ok, false, label);
      assert.match((refusedSeal as { message: string }).message, new RegExp("\\(" + escapeRegExp(code) + "\\)"), label);
      assert.equal(h.plans(), before, "no plan ran: " + label);
      assert.deepEqual(readdirSync(h.dirs.scratch), [], "no scratch directory survives: " + label);
    }
    // Admitted: nothing selected (a built-in-only project, as the emulated runs), the cloud's provider at the reviewed version, and a no-cloud one.
    for (const selections of [{}, { [own]: reviewed, "registry.terraform.io/hashicorp/random": "3.7.2" }]) {
      const h = harness(provider);
      h.behave({ providerSelections: selections });
      const sealed = await h.sealWith(h.project());
      assert.ok(sealed.ok, JSON.stringify(sealed));
    }
  });
}
