import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Azure pilot bootstrap (bootstrap/azure, docs/act-pilot-bootstrap.md Step 1): the three-stage chain by default and an
// explicit DEV-only mode. SYNTHETIC and offline. The default run reads the Terraform text; the opt-in run executes the
// configuration's own `terraform test` (mocked providers, plan only) when ALZ_BOOTSTRAP_TERRAFORM names a Terraform binary
// whose providers are installable offline (TF_CLI_CONFIG_FILE pointing at a filesystem mirror). Neither touches a cloud.

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, "bootstrap", "azure");
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
/** The text of one top-level HCL block, from its header to the next top-level block. */
const block = (text: string, header: string): string => {
  const start = text.indexOf(header);
  assert.ok(start >= 0, header + " is declared");
  const next = text.slice(start + header.length).search(/\n(?:variable|module|output|resource|locals|moved|provider|run|mock_provider) /);
  return next < 0 ? text.slice(start) : text.slice(start, start + header.length + next);
};

test("the default stays the three-stage chain; DEV-only is explicit and is the only other mode", () => {
  const variable = block(read("variables.tf"), 'variable "enabled_environments" {');
  assert.match(variable, /default\s+=\s+\["DEV", "QA", "PROD"\]/);
  assert.match(variable, /toset\(var\.enabled_environments\) == toset\(\["DEV"\]\) \|\| toset\(var\.enabled_environments\) == toset\(\["DEV", "QA", "PROD"\]\)/);
  assert.match(variable, /length\(var\.enabled_environments\) == length\(distinct\(var\.enabled_environments\)\)/);
  // An entry or a subject for an environment that is not enabled is refused, never silently ignored.
  assert.match(block(read("variables.tf"), 'variable "environments" {'), /toset\(\[for name, e in var\.environments : name if e != null\]\) == toset\(var\.enabled_environments\)/);
  assert.match(block(read("variables.tf"), 'variable "oidc_subjects" {'), /contains\(var\.enabled_environments, e\)/);
  // Only QA and PROD are conditional; DEV is always created. Federated credentials follow the enabled environments.
  const environments = read("environments.tf");
  assert.doesNotMatch(block(environments, 'module "environment_dev" {'), /count/);
  assert.match(block(environments, 'module "environment_qa" {'), /count\s+=\s+contains\(var\.enabled_environments, "QA"\) \? 1 : 0/);
  assert.match(block(environments, 'module "environment_prod" {'), /count\s+=\s+contains\(var\.enabled_environments, "PROD"\) \? 1 : 0/);
  assert.match(read("identities.tf"), /environments\s+=\s+toset\(var\.enabled_environments\)/);
  assert.match(read("outputs.tf"), /for env in var\.enabled_environments : env =>/);
});

test("both modes share one environment module, so the state and role controls cannot diverge", () => {
  const module = read("modules/environment/main.tf");
  for (const control of [/shared_access_key_enabled\s+=\s+false/, /default_to_oauth_authentication\s+=\s+true/, /allow_nested_items_to_be_public\s+=\s+false/,
    /min_tls_version\s+=\s+"TLS1_2"/, /default_action\s+=\s+"Deny"/, /versioning_enabled\s+=\s+true/,
    /role_definition_name\s+=\s+"Storage Blob Data Reader"/, /role_definition_name\s+=\s+"Storage Blob Data Contributor"/,
    /role_definition_name\s+=\s+"Reader"/, /role_definition_name\s+=\s+"Contributor"/]) {
    assert.match(module, control);
  }
  // Every environment is the same module; the DEV-only mode adds no second copy with its own settings.
  assert.equal(read("environments.tf").match(/source = "\.\/modules\/environment"/g)?.length, 3);
  // No secret or certificate credential exists in either mode.
  assert.doesNotMatch(read("identities.tf"), /azuread_application_password|azuread_application_certificate|azuread_service_principal_password/);
});

test("the offline Terraform tests cover both modes and every refusal", () => {
  const tests = read("tests/environments.tftest.hcl");
  for (const provider of ['mock_provider "azuread"', 'alias = "dev"', 'alias = "qa"', 'alias = "prod"']) assert.ok(tests.includes(provider), provider);
  for (const run of ["chain_is_the_default", "chain_refuses_a_shared_subscription", "chain_refuses_a_shared_state_account", "chain_refuses_a_missing_environment",
    "dev_only_creates_dev_alone_with_the_same_controls", "dev_only_refuses_a_qa_or_prod_entry", "dev_only_refuses_a_qa_or_prod_subject",
    "dev_only_refuses_a_shared_dev_subject", "only_dev_or_the_full_chain_is_accepted", "qa_alone_is_refused", "a_repeated_environment_is_refused"]) {
    assert.match(block(tests, 'run "' + run + '" {'), /command = plan/, run);
  }
  // Plan only, with mocked providers: no run may apply.
  assert.doesNotMatch(tests, /command\s*=\s*apply/);
  const example = read("terraform.tfvars.example");
  assert.match(example, /enabled_environments = \["DEV", "QA", "PROD"\]/);
  assert.match(example, /enabled_environments = \["DEV"\]/);
});

const TERRAFORM = process.env.ALZ_BOOTSTRAP_TERRAFORM;
test("opt-in: terraform init, validate and test pass offline (mocked providers)", { skip: TERRAFORM ? false : "set ALZ_BOOTSTRAP_TERRAFORM to a Terraform binary and TF_CLI_CONFIG_FILE to an offline provider mirror" }, () => {
  const work = mkdtempSync(join(tmpdir(), "alz-bootstrap-azure-"));
  try {
    cpSync(DIR, work, { recursive: true, filter: (source) => !/[\\/]\.terraform(?:[\\/]|$)|\.tfstate|\.tfvars$/.test(source) });
    const run = (...args: string[]) => {
      const result = spawnSync(TERRAFORM!, args, { cwd: work, encoding: "utf8", env: { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" }, timeout: 300_000 });
      assert.equal(result.status, 0, args.join(" ") + "\n" + result.stdout + result.stderr);
      return result.stdout;
    };
    run("fmt", "-recursive", "-check");
    run("init", "-backend=false", "-input=false", "-no-color");
    run("validate", "-no-color");
    assert.match(run("test", "-no-color"), /Success! 11 passed, 0 failed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
