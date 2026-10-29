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
  // Every mode requires each enabled environment's pilot resource group (owner decision of 2026-10-28), so APPLY and DISCOVERY never
  // fall back to the whole subscription; the environment module refuses one without it too.
  assert.match(block(read("variables.tf"), 'variable "environments" {'),
    /alltrue\(\[for e in values\(var\.environments\) : try\(trimspace\(e\.apply_resource_group_name\), ""\) != "" if e != null\]\)/);
  assert.match(block(read("modules/environment/variables.tf"), 'variable "settings" {'), /try\(trimspace\(var\.settings\.apply_resource_group_name\) != "", false\)/);
  assert.doesNotMatch(read("modules/environment/main.tf"), /local\.subscription_scope\s*:/, "no subscription fallback for APPLY or DISCOVERY");
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
    /role_definition_name\s+=\s+"Reader"/]) {
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
    "dev_only_refuses_a_shared_dev_subject", "only_dev_or_the_full_chain_is_accepted", "qa_alone_is_refused", "a_repeated_environment_is_refused",
    "dev_only_refuses_a_missing_pilot_group", "dev_only_refuses_a_blank_pilot_group", "chain_refuses_a_missing_pilot_group", "chain_scopes_every_environment_to_its_pilot_group",
    "apply_role_is_exact_and_scoped_to_the_pilot_group", "apply_role_refuses_a_missing_pilot_group_in_the_module", "bicep_is_off_by_default",
    "bicep_role_is_exact_and_scoped_to_the_dev_pilot_group", "bicep_refuses_the_three_stage_chain", "bicep_refuses_dev_without_a_pilot_group",
    "bicep_role_refuses_a_missing_pilot_group_in_the_module"]) {
    assert.match(block(tests, 'run "' + run + '" {'), /command = plan/, run);
  }
  // Plan only, with mocked providers: no run may apply.
  assert.doesNotMatch(tests, /command\s*=\s*apply/);
  const example = read("terraform.tfvars.example");
  assert.match(example, /enabled_environments = \["DEV", "QA", "PROD"\]/);
  assert.match(example, /enabled_environments = \["DEV"\]/);
});

/** The quoted strings of one `name = [ ... ]` list in the module's locals. */
const listOf = (text: string, name: string): string[] => {
  const match = new RegExp(name + "\\s*=\\s*\\[([^\\]]*)\\]").exec(text);
  assert.ok(match, name + " is declared");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

test("APPLY holds narrowly scoped custom roles at the pilot resource group, never Contributor; each action is reviewed and none can grant, wildcard or touch a group (owner decision of 2026-10-28)", () => {
  const module = read("modules/environment/main.tf");
  // The Azure Terraform canary: one virtual network, read (the import check and the read-back), written (with its tags), deleted at cleanup.
  assert.deepEqual(listOf(module, "apply_actions"), ["Microsoft.Network/virtualNetworks/read", "Microsoft.Network/virtualNetworks/write", "Microsoft.Network/virtualNetworks/delete"]);
  // The Bicep canary (owner decision E2): the deployment what-if, one deployment stack with deny settings, and its virtual network.
  assert.deepEqual(listOf(module, "bicep_stack_actions"), [
    "Microsoft.Resources/deployments/read", "Microsoft.Resources/deployments/write", "Microsoft.Resources/deployments/operationstatuses/read",
    "Microsoft.Resources/deployments/validate/action", "Microsoft.Resources/deployments/whatIf/action",
    "Microsoft.Resources/deploymentStacks/read", "Microsoft.Resources/deploymentStacks/write", "Microsoft.Resources/deploymentStacks/delete",
    "Microsoft.Resources/deploymentStacks/validate/action", "Microsoft.Resources/deploymentStacks/manageDenySetting/action",
    "Microsoft.Network/virtualNetworks/read", "Microsoft.Network/virtualNetworks/write", "Microsoft.Network/virtualNetworks/delete",
  ]);
  for (const action of [...listOf(module, "apply_actions"), ...listOf(module, "bicep_stack_actions")]) {
    assert.ok(!action.includes("*"), action + ": no wildcard");
    assert.ok(!/^microsoft\.authorization\//i.test(action), action + ": no authorization action (no role or deny assignment, no lock, no policy)");
    assert.ok(!/^microsoft\.resources\/subscriptions\/resourcegroups\//i.test(action), action + ": no resource group action");
    assert.ok(!/^microsoft\.resources\/subscriptions\/[^/]+$/i.test(action) && !/providers\/register|\/register\/action/i.test(action), action + ": no subscription or registration action");
  }
  // Both roles are defined at, assignable at and assigned at the pilot resource group only, by id; no built-in role is given to APPLY.
  for (const name of ["apply", "bicep_stack_apply"]) {
    const index = name === "apply" ? "" : "[0]";
    const definition = block(module, 'resource "azurerm_role_definition" "' + name + '" {');
    assert.match(definition, /scope\s+=\s+azurerm_resource_group\.apply\[0\]\.id/, name);
    assert.match(definition, /assignable_scopes = \[azurerm_resource_group\.apply\[0\]\.id\]/, name);
    assert.match(definition, /not_actions = \[\]/, name);
    assert.doesNotMatch(definition, /data_actions/, name);
    const assignment = block(module, 'resource "azurerm_role_assignment" "' + name + '" {');
    assert.match(assignment, /scope\s+=\s+azurerm_resource_group\.apply\[0\]\.id/, name);
    assert.ok(assignment.includes("role_definition_id = azurerm_role_definition." + name + index + ".role_definition_resource_id"), name + ": assigned by the custom role's id");
    assert.match(assignment, /principal_id\s+=\s+var\.principal_ids\["APPLY"\]/, name);
  }
  assert.doesNotMatch(module, /role_definition_name\s*=\s*"(Contributor|Owner|User Access Administrator|Role Based Access Control Administrator)"/, "no broad built-in role anywhere");
  // DISCOVERY stays genuinely read-only: the built-in Reader (`*/read`, no data actions) at the pilot group, and nothing else.
  const discovery = block(module, 'resource "azurerm_role_assignment" "discovery" {');
  assert.match(discovery, /scope\s+=\s+local\.apply_scope/);
  assert.match(discovery, /role_definition_name\s+=\s+"Reader"/);
  assert.equal(module.match(/principal_ids\["DISCOVERY"\]/g)?.length, 1, "DISCOVERY has exactly one role assignment");
  assert.match(module, /apply_scope = azurerm_resource_group\.apply\[0\]\.id/);
});

test("APPLY and the state (owner decision 6486426552): denied by absence of any grant, no explicit deny exists, and Azure Terraform stays BLOCKED on it", () => {
  const module = read("modules/environment/main.tf");
  // Absence of grant: APPLY's only assignments are its two custom roles at the pilot resource group (checked above); none names a
  // state scope, no role definition carries a data action, and the account takes neither a shared key nor a SAS.
  const assignments = [...module.matchAll(/resource "azurerm_role_assignment" "([a-z_]+)" \{/g)].map((m) => m[1]);
  const toApply = assignments.filter((name) => /principal_ids\["APPLY"\]/.test(block(module, 'resource "azurerm_role_assignment" "' + name + '" {')));
  assert.deepEqual(toApply, ["apply", "bicep_stack_apply"]);
  for (const name of toApply) {
    const assignment = block(module, 'resource "azurerm_role_assignment" "' + name + '" {');
    assert.doesNotMatch(assignment, /azurerm_(storage_container|storage_account|resource_group)\.state\b/, name + ": no state scope");
  }
  for (const name of ["state", "state_write"]) {
    assert.doesNotMatch(block(module, 'resource "azurerm_role_assignment" "' + name + '" {'), /principal_ids\["APPLY"\]/, name);
  }
  assert.doesNotMatch(module, /data_actions/, "no role definition grants a data action");
  const account = block(module, 'resource "azurerm_storage_account" "state" {');
  assert.match(account, /shared_access_key_enabled\s+=\s+false/);
  assert.match(account, /default_to_oauth_authentication\s+=\s+true/);
  // No explicit deny: the module says so and why, and claims no deny assignment it cannot create or show.
  assert.match(module, /EFFECTIVE \(explicit\) denial, and this configuration has none/);
  assert.doesNotMatch(module, /azurerm_[a-z_]*deny|deny_assignment/i, "no deny assignment is claimed");
  // So the release row stays BLOCKED, and says this is one of the reasons. Adding a real deny means changing both.
  const status = JSON.parse(readFileSync(join(ROOT, "config", "release", "status.json"), "utf8")) as { gates: { gate: string; status: string; nextAction: string }[] };
  const row = status.gates.find((g) => g.gate === "act:azure-terraform");
  assert.ok(row);
  assert.equal(row.status, "BLOCKED");
  assert.match(row.nextAction, /no explicit deny of APPLY on the state/);
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
    assert.match(run("test", "-no-color"), /Success! 22 passed, 0 failed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
