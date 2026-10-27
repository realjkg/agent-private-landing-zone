import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
  // roles/owner and roles/editor appear only in the validation that refuses them.
  const roleLines = source.split("\n").filter((line) => /roles\/(owner|editor)/.test(line));
  assert.ok(roleLines.length > 0 && roleLines.every((line) => /contains\(\["roles\/owner", "roles\/editor"\], r\)/.test(line)), roleLines.join("\n"));
  assert.match(source, /hashicorp\/google"/);
  assert.equal(source.includes("google-beta"), false, "the bootstrap uses hashicorp/google only");
});

test("each service account trusts one exact subject through workload identity federation, and the provider admits the engine's subjects only", () => {
  const main = hcl("main.tf");
  assert.match(main, /role\s+= "roles\/iam\.workloadIdentityUser"/);
  assert.match(main, /member\s+= "principal:\/\/iam\.googleapis\.com\/\$\{google_iam_workload_identity_pool\.pilot\.name\}\/subject\/\$\{var\.oidc_subjects\[each\.key\]\}"/);
  assert.equal(/principalSet:\/\//.test(main), false, "no principal set: one subject per account");
  assert.match(main, /attribute_condition\s+= "assertion\.sub in \[/);
  // The subjects are interpolated into CEL, so the validation must keep quotes, backslashes and wildcards out.
  assert.match(hcl("variables.tf"), /\^\[A-Za-z0-9:\._\/@-\]\{1,127\}\$/);
});

test("path 6 (GCP_API) gets exactly its Pub/Sub grants, in DEV only, with its own accounts and no state bucket or bucket grant", () => {
  const main = hcl("main.tf");
  const api = /workload_permissions = local\.api \? \{([\s\S]*?)\} : \{/.exec(main)?.[1] ?? "";
  assert.match(api, /DISCOVERY = \["pubsub\.topics\.get"\]/);
  assert.match(api, /APPLY\s+= \["pubsub\.topics\.create", "pubsub\.topics\.delete"\]/);
  assert.match(main, /identities = toset\(local\.api \? \["DISCOVERY", "APPLY"\]/);
  assert.match(main, /engine_tag = local\.api \? "api-" : ""/);
  const variables = hcl("variables.tf");
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| var\.environment == "DEV"/);
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| var\.state_bucket_name == null/);
  assert.match(variables, /condition\s+= var\.engine != "GCP_API" \|\| length\(var\.apply_additional_roles\) == 0/);
  const state = hcl("state.tf");
  for (const block of ["state_roles = local.terraform ?", "state_bindings = local.terraform ?", "count                       = local.terraform ? 1 : 0"]) assert.ok(state.includes(block), block);
  assert.deepEqual(Object.keys(template.GCP_API.contractTargets), ["DEV"]);
  assert.deepEqual(template.GCP_API.contractTargets.DEV, { projectId: "examplefake-dev" });
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
  ]) assert.match(suite, new RegExp('^run "' + run + '" \\{', "m"), run);
});
