import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { inspectPilotContract } from "../src/apply/contract.js";
import { approvers } from "./helpers/apply-fixtures.js";

// bootstrap/gcp (slice S2 of the GCP release-path PLAN, owner approval 6433121154 on issue #39). SYNTHETIC and static: this reads
// the owner-run package's text and never runs Terraform. Its behavior under a mocked provider is `terraform test`
// (bootstrap/gcp/tests/bootstrap.tftest.hcl), recorded in docs/act-pilot-bootstrap-gcp.md. Neither is evidence about Google Cloud.

const DIR = join(import.meta.dirname, "..", "bootstrap", "gcp");
const hcl = (name: string): string => readFileSync(join(DIR, name), "utf8");
const all = (): string => readdirSync(DIR).filter((name) => name.endsWith(".tf")).map(hcl).join("\n");
/** The HCL without comments, descriptions and error messages, so a rule cannot be satisfied or broken by prose. */
const code = (): string => all().split("\n").filter((line) => !/^\s*#/.test(line) && !/^\s*(description|error_message)\s*=/.test(line)).join("\n");
const template = JSON.parse(readFileSync(join(DIR, "..", "config.gcp.template.json"), "utf8")) as Record<string, any>;

test("the package is the documented files, and never creates a key, a key-bearing credential or a basic role", () => {
  assert.deepEqual(readdirSync(DIR).sort(), ["guardrails.tf", "main.tf", "outputs.tf", "state.tf", "terraform.tfvars.example", "tests", "variables.tf", "versions.tf"]);
  const source = code();
  for (const banned of ["google_service_account_key", "google_service_account_access_token", "private_key", "access_token", "client_secret", "service_account_impersonation_url", "allUsers", "allAuthenticatedUsers"]) {
    assert.equal(source.includes(banned), false, banned);
  }
  // Owner decision D12 (6483366237): no predefined role at all. The only role the code names is the workload identity binding of each
  // service account to its own subject; every project grant is a custom role, and the old APPLY allowlist is gone (must be empty).
  assert.deepEqual([...new Set(source.match(/roles\/[A-Za-z.]+/g))], ["roles/iam.workloadIdentityUser"]);
  assert.match(source, /condition\s+= length\(var\.apply_additional_roles\) == 0/);
  assert.equal(source.includes('resource "google_project_iam_member" "apply_additional"'), false, "no path grants a predefined role");
  assert.match(source, /hashicorp\/google"/);
  assert.equal(source.includes("google-beta"), false, "the bootstrap uses hashicorp/google only");
});

test("each service account trusts one exact subject through workload identity federation, and the provider admits the engine's subjects only", () => {
  const main = hcl("main.tf");
  assert.match(main, /role\s+= "roles\/iam\.workloadIdentityUser"/);
  assert.match(main, /member\s+= "principal:\/\/iam\.googleapis\.com\/\$\{google_iam_workload_identity_pool\.pilot\.name\}\/subject\/\$\{var\.oidc_subjects\[each\.key\]\}"/);
  assert.equal(/principalSet:\/\//.test(main), false, "no principal set: one subject per account");
  assert.match(main, /attribute_condition = join\(" && ", concat\(\n\s+\["assertion\.sub in \[/);
  // Optional exact claims (review N3) are ANDed in, never ORed, and validated like the subjects before they reach CEL.
  assert.match(main, /\[for claim, value in var\.oidc_required_claims : "assertion\.\$\{claim\} == \\"\$\{value\}\\""\]/);
  assert.match(hcl("variables.tf"), /\^\[a-z\]\[a-z0-9_\]\{0,63\}\$/);
  // The subjects are interpolated into CEL, so the validation must keep quotes, backslashes and wildcards out.
  assert.match(hcl("variables.tf"), /\^\[A-Za-z0-9:\._\/@-\]\{1,127\}\$/);
});

test("D12 (lane G1): DISCOVERY reads topics and searches the project's assets, APPLY creates and deletes topics (TERRAFORM also reads them back), no update, publish, subscribe, IAM or service permission, and services are enabled by the bootstrap only", () => {
  const main = hcl("main.tf");
  const [api, terraform] = [/workload_permissions = local\.api \? \{([\s\S]*?)\} : \{/.exec(main)?.[1] ?? "", /\} : \{\n([\s\S]*?)\n {2}\}\n/.exec(main)?.[1] ?? ""];
  assert.match(api, /DISCOVERY = \["cloudasset\.assets\.searchAllResources", "pubsub\.topics\.get"\]/);
  assert.match(api, /APPLY\s+= \["pubsub\.topics\.create", "pubsub\.topics\.delete"\]/);
  assert.match(terraform, /DISCOVERY = \["cloudasset\.assets\.searchAllResources", "pubsub\.topics\.get"\]/);
  assert.match(terraform, /APPLY\s+= \["pubsub\.topics\.create", "pubsub\.topics\.delete", "pubsub\.topics\.get"\]/);
  const source = code();
  for (const banned of ["pubsub.topics.update", "pubsub.topics.publish", "pubsub.topics.setIamPolicy", "pubsub.subscriptions.", "serviceusage.", "iam.serviceAccounts.getAccessToken", "resourcemanager.projects.setIamPolicy\"", "cloudasset.assets.list"]) {
    assert.equal(source.includes(banned), false, banned);
  }
  assert.match(main, /\["iam\.googleapis\.com", "iamcredentials\.googleapis\.com", "sts\.googleapis\.com", "pubsub\.googleapis\.com", "cloudasset\.googleapis\.com"\]/);
  // Both paths are DEV only (#339; owner decision 6481421924), and the header says so.
  assert.match(hcl("variables.tf"), /condition\s+= var\.environment == "DEV"/);
  assert.match(hcl("versions.tf"), /Run once per engine in the DEV project only/);
  assert.equal(/QA and PROD/.test(hcl("versions.tf")), false, "the header no longer says QA and PROD for TERRAFORM");
});

test("path 6 (GCP_API) gets exactly its Pub/Sub grants, in DEV only, with its own accounts and no state bucket or bucket grant", () => {
  const main = hcl("main.tf");
  assert.match(main, /identities = toset\(local\.api \? \["DISCOVERY", "APPLY"\]/);
  assert.match(main, /engine_tag = local\.api \? "api-" : ""/);
  const variables = hcl("variables.tf");
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| var\.environment == "DEV"/);
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| var\.state_bucket_name == null/);
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| length\(var\.apply_additional_roles\) == 0/);
  const state = hcl("state.tf");
  for (const block of ["state_roles = local.terraform ?", "state_bindings = local.terraform ?", "count                       = local.terraform ? 1 : 0"]) assert.ok(state.includes(block), block);
  assert.deepEqual(Object.keys(template.GCP_API.contractTargets), ["DEV"]);
  // D12 checklist item 8: the GCP_API target in decision D9's shape.
  assert.deepEqual(template.GCP_API.contractTargets.DEV, {
    projectId: "examplefake-dev", region: "europe-west4", backend: "GCP_API_NO_STATE", workspace: "default", topicPrefix: "alz-act-dev1-", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] },
  });
  assert.match(hcl("variables.tf"), /\^alz-\[a-z0-9-\]\{1,40\}-\$/);
  assert.deepEqual(Object.keys(template.GCP_API.serviceAccounts.DEV), ["DISCOVERY", "APPLY"]);
});

test("the state bucket separates STATE (read, lock object only) from STATE_WRITE, and APPLY and DISCOVERY are denied every object", () => {
  const state = hcl("state.tf");
  assert.match(state, /uniform_bucket_level_access = true/);
  assert.match(state, /public_access_prevention\s+= "enforced"/);
  assert.match(state, /versioning \{\s+enabled = true/);
  assert.match(state, /state_lock\s+= \["storage\.objects\.create", "storage\.objects\.delete"\]/);
  assert.match(state, /STATE_lock\s+= \{ role = "state_lock", identity = "STATE", .*endsWith\(\\"\.tflock\\"\)/);
  assert.equal(/identity = "APPLY"/.test(state), false, "APPLY has no bucket grant");
  const guard = hcl("guardrails.tf");
  assert.match(guard, /iam\.disableServiceAccountKeyCreation/);
  assert.match(guard, /denied_principals\s+= \[local\.deny_principal\["APPLY"\], local\.deny_principal\["DISCOVERY"\]\]/);
  // Review N2: APPLY can never re-grant, reconfigure or delete a bucket, so not the state bucket either.
  assert.match(guard, /deny_bucket_administration = \[for verb in \["setIamPolicy", "update", "delete"\] : "storage\.googleapis\.com\/buckets\.\$\{verb\}"\]/);
  assert.match(guard, /denied_principals\s+= \[local\.deny_principal\["APPLY"\]\]\n\s+denied_permissions = local\.deny_bucket_administration/);
});

test("owner items P3 and P5 stay off by default, and P3 can never match a state object", () => {
  const variables = hcl("variables.tf");
  assert.match(variables, /variable "lock_version_retention_days" \{[\s\S]*?default\s+= null/);
  assert.match(variables, /variable "enable_storage_data_access_logs" \{[\s\S]*?default\s+= false/);
  assert.match(hcl("state.tf"), /matches_suffix\s+= \["\.tflock"\]/);
  assert.equal(all().includes('".tfstate"'), false);
});

test("the template and the outputs name the provider spec's four identity variables and a credential configuration it accepts", () => {
  assert.deepEqual(template.identityVariables.perIdentity, [
    "ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS", "ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "ALZ_<IDENTITY>_GOOGLE_PROJECT", "ALZ_<IDENTITY>_GOOGLE_REGION",
  ]);
  const shape = template.credentialConfigurationShape;
  assert.deepEqual(Object.keys(shape).sort(), ["audience", "credential_source", "subject_token_type", "token_url", "type"]);
  assert.equal(shape.type, "external_account");
  assert.deepEqual(Object.keys(shape.credential_source), ["file"]);
  const outputs = hcl("outputs.tf");
  for (const key of ["type               = \"external_account\"", "token_url          = \"https://sts.googleapis.com/v1/token\"", "credential_source  = { file = var.token_files[i] }"]) assert.ok(outputs.includes(key), key);
  const text = JSON.stringify({ ...template, NOTE: undefined });
  for (const banned of ["private_key", "client_secret", "refresh_token", "access_token", "service_account_impersonation_url"]) assert.equal(text.includes(banned), false, banned);
  for (const [env, accounts] of Object.entries(template.TERRAFORM.serviceAccounts as Record<string, Record<string, string>>)) {
    const project = template.TERRAFORM.contractTargets[env].projectId;
    for (const email of Object.values(accounts)) assert.match(email, new RegExp("^alz-pilot-" + env.toLowerCase() + "-[a-z-]+@" + project + "\\.iam\\.gserviceaccount\\.com$"));
  }
  assert.match(template.NOTE, /TEMPLATE, NOT A CONTRACT/);
});

test("the mocked terraform test suite covers every refusal the package promises", () => {
  const suite = readFileSync(join(DIR, "tests", "bootstrap.tftest.hcl"), "utf8");
  assert.match(suite, /^mock_provider "google" \{/m);
  for (const run of [
    "terraform_engine_dev", "api_engine_dev", "p3_lock_versions_opt_in", "refuses_api_outside_dev", "refuses_api_with_state_bucket", "refuses_api_with_additional_roles",
    "refuses_owner_role", "refuses_editor_role", "refuses_iam_admin_role", "refuses_shared_subject", "refuses_subject_that_ends_a_cel_string", "refuses_wildcard_subject",
    "refuses_missing_identity_subject", "refuses_relative_or_shared_token_file", "refuses_budget_without_billing_account",
    "pins_required_claims", "refuses_required_claim_that_ends_a_cel_string", "refuses_required_claim_with_an_expression_name",
    "refuses_terraform_outside_dev", "refuses_api_without_topic_prefix", "refuses_malformed_topic_prefix", "refuses_topic_prefix_on_terraform", "parent_is_carried_owner_declared",
    "refuses_malformed_parent", "refuses_pubsub_viewer_role", "refuses_pubsub_publisher_role", "refuses_logging_viewer_role",
    "refuses_storage_admin_role", "refuses_deployment_manager_editor_role", "refuses_cloud_build_editor_role", "refuses_any_admin_or_unreviewed_role",
  ]) assert.match(suite, new RegExp('^run "' + run + '" \\{', "m"), run);
});

test("the TERRAFORM template's DEV target and settings make a contract the GCP validator accepts, DEV only, with embedStateWrite", () => {
  const settings = template.TERRAFORM.contractSettings as Record<string, unknown>;
  assert.deepEqual(settings, { embedStateWrite: true, enabledEnvironments: ["DEV"] });
  assert.deepEqual(Object.keys(template.TERRAFORM.contractTargets), ["DEV"], "no QA or PROD target: path 5 is DEV only");
  const contract = {
    schemaVersion: 1, enabled: false, provider: "GCP", engine: "TERRAFORM", targets: template.TERRAFORM.contractTargets, ...settings,
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: ".runs/apply/KILL",
  };
  const result = inspectPilotContract(contract);
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(hcl("outputs.tf"), /output "contract_settings"/);
});
