import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { codeOf } from "../src/apply/engine.js";
import type { ProviderBlock, ProviderUse } from "../src/apply/provider.js";
import { AWS, AWS_DATA_SOURCES, AWS_DENIED_TYPES, AWS_DENIED_TYPES_REVIEWED_AGAINST } from "../src/apply/providers/aws.js";
import { AZURE, AZURE_DATA_SOURCES, AZURE_DENIED_TYPES, AZURE_DENIED_TYPES_REVIEWED_AGAINST } from "../src/apply/providers/azure.js";
import { AWS_DEV_TARGET, AWS_REGION, DEV_TARGET, TENANT, awsIdentityEnv, awsRoleArn, identityEnv } from "./helpers/apply-fixtures.js";

// Review of #320 (6451892239), N1, N2, N3 and N7. SYNTHETIC: the specs' functions are driven with the `show -json` and saved-backend
// shapes the fake engine and the emulated runs use. Every account, role, bucket and subscription is fake.

const AWS_NAME = "registry.terraform.io/hashicorp/aws";
const AWS_BLOCK: ProviderBlock = { name: "aws", full_name: AWS_NAME, expressions: { region: { references: ["var.region"] } } };
const AWS_PINNED = { accountId: AWS_DEV_TARGET.account, region: AWS_REGION, backend: AWS_DEV_TARGET.backend, workspace: "default" };
const AZURE_PINNED = { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default" };
const codeFrom = (run: () => unknown): string => { try { run(); return "OK"; } catch (error) { return codeOf(error); } };
const data = (type: string, provider: ProviderUse["provider"]): ProviderUse => ({ address: "data." + type + ".x", mode: "data", type, provider });
const managed = (type: string, provider: ProviderUse["provider"]): ProviderUse => ({ address: type + ".x", mode: "managed", type, provider });
const aws = { name: "aws", full_name: AWS_NAME };
const awsJudge = (uses: ProviderUse[], blocks: ProviderBlock[] = [AWS_BLOCK]) => codeFrom(() => AWS.assertProviderConfig(blocks, AWS_PINNED, awsIdentityEnv("DEV"), uses));

test("N2: every AWS use is judged against the provider allowlist, a use whose provider has no block and a use with no provider named included", () => {
  assert.equal(awsJudge([managed("aws_cloudwatch_log_group", aws)]), "OK", "control");
  for (const [label, use] of [
    ["data.http with no block", data("http", { full_name: "registry.terraform.io/hashicorp/http" })],
    ["data.http by its local name", data("http", { name: "http" })],
    ["an azurerm resource in an AWS plan", managed("azurerm_resource_group", { full_name: "registry.terraform.io/hashicorp/azurerm" })],
    ["a lookalike namespace", managed("aws_s3_bucket", { full_name: "registry.terraform.io/attacker/aws" })],
    ["a resource with no provider named", managed("aws_s3_bucket", {})],
    ["a data source with no provider named", data("aws_caller_identity", {})],
  ] as const) assert.equal(awsJudge([use]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", label);
  // The built-in provider's local name is `terraform`: a use named only so is the built-in one, judged by its own rule.
  assert.equal(awsJudge([managed("terraform_data", { name: "terraform" })]), "OK");
  assert.equal(awsJudge([data("terraform_remote_state", { name: "terraform" })]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT");
});

test("N1: only the reviewed AWS data sources are read; every other data source, a token or secret reader among them, is refused, and so is a use whose mode is unsaid", () => {
  for (const type of AWS_DATA_SOURCES) assert.equal(awsJudge([data(type, aws)]), "OK", type);
  for (const type of [
    "aws_redshift_cluster_credentials", "aws_redshiftserverless_credentials", "aws_api_gateway_api_key", "aws_api_gateway_api_keys", "aws_s3_object",
    "aws_instance", "aws_glue_connection", "aws_lambda_invocation", "aws_ecr_authorization_token", "aws_eks_cluster_auth", "aws_secretsmanager_secret_version",
    "aws_ssm_parameter", "aws_kms_secrets", "aws_cognito_user_pool_client", "aws_vpc", "aws_iam_role",
  ]) {
    assert.equal(awsJudge([data(type, aws)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type);
    assert.equal(awsJudge([{ address: "module.app.data." + type + ".x", mode: "managed", type, provider: aws }]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + " under a data address");
    assert.equal(awsJudge([{ address: type + ".x", mode: "", type, provider: aws }]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + " with no mode");
  }
  // Managed resources are not data sources: a resource holds what the project configures.
  for (const type of ["aws_s3_object", "aws_ssm_parameter", "aws_instance"]) assert.equal(awsJudge([managed(type, aws)]), "OK", type);
});

test("N3: the saved s3 backend is an allowlist, the contract's bucket and key compared on their own, and a saved role is STATE_WRITE's own", () => {
  const env = awsIdentityEnv("DEV");
  const [bucket, ...key] = AWS_DEV_TARGET.backend.split("/");
  const saved = (config: Record<string, unknown> = {}) => ({ type: "s3", config: { bucket, key: key.join("/"), region: AWS_REGION, use_lockfile: true, access_key: null, endpoint: null, ...config } });
  const role = { role_arn: awsRoleArn("STATE_WRITE", "DEV"), web_identity_token_file: env.ALZ_STATE_WRITE_AWS_WEB_IDENTITY_TOKEN_FILE };
  const ok = (backend: Record<string, unknown>, e: NodeJS.ProcessEnv = env) => AWS.savedBackendMatches(backend, AWS_PINNED, e);
  assert.equal(ok(saved()), true, "the location-only seal");
  assert.equal(ok(saved({ assume_role_with_web_identity: role })), true, "STATE_WRITE's settings");
  assert.equal(ok(saved({ assume_role_with_web_identity: { ...role, session_name: null } })), true, "null nested settings are unset");
  for (const [label, change] of [
    ["an endpoint", { endpoint: "http://127.0.0.1:9000" }], ["static keys", { access_key: "AKIAFAKE" }], ["a profile", { profile: "x" }],
    ["a later attribute", { a_future_attribute: "x" }], ["a falsy unknown", { skip_credentials_validation: false }],
    ["locking off", { use_lockfile: false }], ["another region", { region: "eu-west-1" }],
    ["bucket and key shifted across the slash", { bucket: bucket + "/" + key[0], key: key.slice(1).join("/") }],
    ["APPLY's role", { assume_role_with_web_identity: { ...role, role_arn: awsRoleArn("APPLY", "DEV") } }],
    ["another token file", { assume_role_with_web_identity: { ...role, web_identity_token_file: "/run/other-token" } }],
    ["an extra role setting", { assume_role_with_web_identity: { ...role, policy: "{}" } }],
    ["a role that is not an object", { assume_role_with_web_identity: "arn" }],
  ] as const) assert.equal(ok(saved(change)), false, label);
  const noWriter = { ...env };
  delete noWriter.ALZ_STATE_WRITE_AWS_ROLE_ARN;
  assert.equal(ok(saved({ assume_role_with_web_identity: role }), noWriter), false, "a saved role with no STATE_WRITE role to match");
  assert.equal(ok({ ...saved(), type: "azurerm" }), false);
});

test("N7: only the reviewed Azure data sources are read; SAS minting, Key Vault secrets, storage keys and the built-in remote state are refused", () => {
  const azurerm = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
  const judge = (uses: ProviderUse[]) => codeFrom(() => AZURE.assertProviderConfig([], AZURE_PINNED, identityEnv("DEV"), uses));
  for (const type of AZURE_DATA_SOURCES) assert.equal(judge([data(type, azurerm)]), "OK", type);
  for (const type of ["azurerm_storage_account_sas", "azurerm_storage_account_blob_container_sas", "azurerm_key_vault_secret", "azurerm_storage_account", "azurerm_kubernetes_cluster"]) {
    assert.equal(judge([data(type, azurerm)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type);
    assert.equal(judge([{ address: type + ".x", mode: "", type, provider: azurerm }]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + " with no mode");
  }
  assert.equal(judge([data("terraform_remote_state", { name: "terraform", full_name: "terraform.io/builtin/terraform" })]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  assert.equal(judge([data("http", { full_name: "registry.terraform.io/hashicorp/http" })]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  assert.equal(judge([managed("azurerm_storage_account", azurerm), managed("azurerm_key_vault_secret", azurerm)]), "OK", "managed resources are not judged by this rule");
});

test("RB2: every Azure use is judged against the provider allowlist by exact source, a lookalike, an unnamed provider and another cloud refused; azapi and azuread are not admitted (review of #327, B2)", () => {
  const azurerm = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
  const AZURERM_BLOCK: ProviderBlock = { ...azurerm, expressions: { subscription_id: { references: ["var.subscription_id"] } } };
  const judge = (uses: ProviderUse[], blocks: ProviderBlock[] = [AZURERM_BLOCK]) => codeFrom(() => AZURE.assertProviderConfig(blocks, AZURE_PINNED, identityEnv("DEV"), uses));
  for (const [label, use] of [
    ["azurerm", managed("azurerm_resource_group", azurerm)],
    ["random", managed("random_string", { full_name: "registry.terraform.io/hashicorp/random" })],
    ["the built-in value holder", managed("terraform_data", { name: "terraform" })],
  ] as const) assert.equal(judge([use]), "OK", label);
  for (const [label, use] of [
    ["data.http with no block", data("http", { full_name: "registry.terraform.io/hashicorp/http" })],
    ["a managed resource of an unreviewed provider", managed("external_thing", { full_name: "registry.terraform.io/hashicorp/external" })],
    ["an aws resource in an Azure plan", managed("aws_s3_bucket", { full_name: "registry.terraform.io/hashicorp/aws" })],
    ["a google resource", managed("google_storage_bucket", { name: "google" })],
    ["a lookalike namespace", managed("azurerm_resource_group", { full_name: "registry.terraform.io/hashicorpp/azurerm" })],
    ["a lookalike host", managed("azurerm_resource_group", { full_name: "example.com/hashicorp/azurerm" })],
    ["a lookalike suffix", managed("azurerm_resource_group", { full_name: "registry.terraform.io/attacker/azurerm" })],
    ["azapi under hashicorp, which is not Microsoft's", managed("azapi_resource", { full_name: "registry.terraform.io/hashicorp/azapi" })],
    ["a resource with no provider named", managed("azurerm_resource_group", {})],
    ["a module-nested resource with no provider named", { address: "module.app.azurerm_resource_group.x", mode: "managed", type: "azurerm_resource_group", provider: {} }],
    ["a module-nested lookalike", { address: "module.app.module.deep.azurerm_resource_group.x", mode: "managed", type: "azurerm_resource_group", provider: { full_name: "registry.terraform.io/attacker/azurerm" } }],
  ] as const) assert.equal(judge([managed("azurerm_resource_group", azurerm), use as ProviderUse]), use.mode === "data" ? "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT" : "PROVIDER_CONFIG_NOT_IN_CONTRACT", label);
  // B2: azapi and azuread are not admitted in this release, by any use or block, with their own code. The reviewer's probes: an
  // azapi resource (any ARM type under any parent), azapi_update_resource (a PATCH of anything), azapi_data_plane_resource,
  // azapi_resource_action, a minted directory credential and a Graph grant, in the root module or nested.
  const azapi = { full_name: "registry.terraform.io/azure/azapi" };
  const azuread = { full_name: "registry.terraform.io/hashicorp/azuread" };
  for (const [label, use] of [
    ["azapi_resource", managed("azapi_resource", azapi)], ["azapi_update_resource", managed("azapi_update_resource", azapi)],
    ["azapi_data_plane_resource", managed("azapi_data_plane_resource", azapi)], ["azapi_resource_action", managed("azapi_resource_action", azapi)],
    ["azuread_application_password", managed("azuread_application_password", azuread)], ["azuread_app_role_assignment", managed("azuread_app_role_assignment", azuread)],
    ["azuread by its local name", managed("azuread_application", { name: "azuread" })],
    ["azapi nested two modules down", { address: "module.a.module.b.azapi_resource.x", mode: "managed", type: "azapi_resource", provider: azapi }],
  ] as const) assert.equal(judge([managed("azurerm_resource_group", azurerm), use as ProviderUse]), "PROVIDER_NOT_ADMITTED", label);
  // A local name alone resolves to hashicorp/azapi, which is not Microsoft's provider: an unreviewed one, refused as such.
  assert.equal(judge([managed("azapi_resource", { name: "azapi" })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT");
  // Their data sources stay outside N7's reviewed list, refused first by that rule.
  assert.equal(judge([data("azapi_resource", azapi)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  assert.equal(judge([data("azuread_client_config", azuread)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  // A provider block of either, whatever subscription or tenant it names (the reviewer's probe: another subscription, another tenant).
  for (const block of [
    { name: "azapi", full_name: "registry.terraform.io/azure/azapi", expressions: { subscription_id: { constant_value: "00000000-0000-0000-0000-00000000beef" } } },
    { name: "azuread", full_name: "registry.terraform.io/hashicorp/azuread", expressions: { tenant_id: { constant_value: "00000000-0000-0000-0000-00000000beef" } } },
    { name: "azapi", full_name: "registry.terraform.io/azure/azapi" }, { name: "azuread" },
  ]) assert.equal(judge([], [AZURERM_BLOCK, block]), "PROVIDER_NOT_ADMITTED", JSON.stringify(block));
  // The built-in provider: `terraform_data` only, judged by its provider and by its prefix when the provider is unnamed or forged.
  assert.equal(judge([managed("terraform_unknown", { name: "terraform" })]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT");
  assert.equal(judge([managed("terraform_unknown", azurerm)]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT", "a built-in type under another provider's name");
  // Provider blocks: only allowed providers may be configured, and a lookalike block is not judged as azurerm, it is refused.
  for (const block of [
    { name: "aws", full_name: "registry.terraform.io/hashicorp/aws" }, { name: "http", full_name: "registry.terraform.io/hashicorp/http" },
    { name: "azurerm", full_name: "registry.terraform.io/attacker/azurerm" }, { name: "external" },
  ]) assert.equal(judge([], [AZURERM_BLOCK, block]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", JSON.stringify(block));
  // The constant subscription check still holds for the azurerm block.
  assert.equal(judge([], [{ ...azurerm, expressions: { subscription_id: { constant_value: "00000000-0000-0000-0000-00000000dead" } } }]), "PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT");
});

test("N1 and round 2 B1 (review of #327): a managed type that runs code or deploys a template instead of holding a resource is refused on both providers, in any module and for any action", () => {
  const azurerm = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
  const azureJudge = (uses: ProviderUse[]) => codeFrom(() => AZURE.assertProviderConfig([], AZURE_PINNED, identityEnv("DEV"), uses));
  assert.deepEqual([...AZURE_DENIED_TYPES].sort(), [
    "azurerm_arc_kubernetes_cluster_extension", "azurerm_arc_machine_extension", "azurerm_blueprint_assignment", "azurerm_kubernetes_cluster_extension", "azurerm_kusto_script",
    "azurerm_managed_application", "azurerm_management_group_policy_remediation", "azurerm_management_group_template_deployment",
    "azurerm_resource_deployment_script_azure_cli", "azurerm_resource_deployment_script_azure_power_shell", "azurerm_resource_group_policy_remediation",
    "azurerm_resource_group_template_deployment", "azurerm_resource_policy_remediation", "azurerm_stack_hci_extension", "azurerm_subscription_policy_remediation",
    "azurerm_subscription_template_deployment", "azurerm_tenant_template_deployment", "azurerm_virtual_machine_extension", "azurerm_virtual_machine_run_command",
    "azurerm_virtual_machine_scale_set_extension",
  ]);
  for (const type of AZURE_DENIED_TYPES) {
    assert.equal(azureJudge([managed(type, azurerm)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
    assert.equal(azureJudge([{ address: "module.app." + type + ".x", mode: "managed", type, provider: azurerm }]), "PROVIDER_TYPE_NOT_ALLOWED", type + " nested");
  }
  assert.equal(azureJudge([managed("azurerm_virtual_machine", azurerm), managed("azurerm_kubernetes_cluster", azurerm)]), "OK", "the machines themselves are resources");
  assert.deepEqual([...AWS_DENIED_TYPES].sort(), [
    "aws_cloudformation_stack", "aws_cloudformation_stack_instances", "aws_cloudformation_stack_set", "aws_cloudformation_stack_set_instance", "aws_imagebuilder_image",
    "aws_lambda_invocation", "aws_sagemaker_hyper_parameter_tuning_job", "aws_sagemaker_labeling_job", "aws_sagemaker_training_job", "aws_servicecatalog_provisioned_product",
    "aws_ssm_association",
  ]);
  for (const type of AWS_DENIED_TYPES) {
    assert.equal(awsJudge([managed(type, aws)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
    assert.equal(awsJudge([{ address: "module.app." + type + ".x", mode: "managed", type, provider: aws }]), "PROVIDER_TYPE_NOT_ALLOWED", type + " nested");
  }
  // The data source keeps its own refusal (review of #322): it is not on the reviewed list.
  assert.equal(awsJudge([data("aws_lambda_invocation", aws)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  assert.equal(awsJudge([managed("aws_lambda_function", aws), managed("aws_ssm_document", aws)]), "OK", "the function and the document themselves are resources");
});

test("round 2 B1 (review of #327): one row per template deployment, whatever the action, and every AWS stack container family the cleanup keeps", () => {
  const azurerm = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
  const azureJudge = (uses: ProviderUse[]) => codeFrom(() => AZURE.assertProviderConfig([], AZURE_PINNED, identityEnv("DEV"), uses));
  // `providerUsesOf` lists a type from the configuration, the changes (create, update, delete or no-op alike) and the states, so
  // the rule depends on the type alone; one row each.
  for (const type of ["azurerm_resource_group_template_deployment", "azurerm_subscription_template_deployment", "azurerm_management_group_template_deployment", "azurerm_tenant_template_deployment"]) {
    assert.equal(azureJudge([managed(type, azurerm)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
  }
  for (const type of ["aws_cloudformation_stack", "aws_cloudformation_stack_set", "aws_cloudformation_stack_set_instance", "aws_cloudformation_stack_instances", "aws_servicecatalog_provisioned_product"]) {
    assert.equal(awsJudge([managed(type, aws)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
  }
  // The same class by the cleanup's one list of stack containers (src/observe/aws-containers.ts), so a family added there is refused here too.
  for (const type of ["aws_serverlessapplicationrepository_cloudformation_stack", "aws_sagemaker_project", "aws_proton_service", "aws_elastic_beanstalk_environment",
    "aws_ssmquicksetup_configuration_manager", "aws_datazone_environment", "aws_controltower_control"]) {
    assert.equal(awsJudge([managed(type, aws)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
  }
  // (aws_proton_service is not in hashicorp/aws 6.68.0; the family's `aws_proton_` namespace prefix refuses whatever a later version adds.)
  // Ordinary resources stay resources.
  assert.equal(awsJudge([managed("aws_cloudwatch_log_group", aws), managed("aws_s3_bucket", aws)]), "OK");
  assert.equal(azureJudge([managed("azurerm_resource_group", azurerm), managed("azurerm_virtual_network", azurerm)]), "OK");
});

test("round 3 B1 (review of #327): one row per type the full-schema sweep found, deploying a template or running code at apply", () => {
  const azurerm = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
  const azureJudge = (uses: ProviderUse[]) => codeFrom(() => AZURE.assertProviderConfig([], AZURE_PINNED, identityEnv("DEV"), uses));
  for (const type of ["azurerm_managed_application", "azurerm_blueprint_assignment", "azurerm_resource_policy_remediation", "azurerm_resource_group_policy_remediation",
    "azurerm_subscription_policy_remediation", "azurerm_management_group_policy_remediation", "azurerm_kubernetes_cluster_extension",
    "azurerm_arc_kubernetes_cluster_extension", "azurerm_kusto_script"]) assert.equal(azureJudge([managed(type, azurerm)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
  for (const type of ["aws_imagebuilder_image", "aws_sagemaker_training_job", "aws_sagemaker_hyper_parameter_tuning_job", "aws_sagemaker_labeling_job"]) {
    assert.equal(awsJudge([managed(type, aws)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
  }
  // Their reviewed neighbors stay resources.
  assert.equal(azureJudge([managed("azurerm_kubernetes_cluster", azurerm), managed("azurerm_kusto_database", azurerm), managed("azurerm_policy_definition", azurerm)]), "OK");
  assert.equal(awsJudge([managed("aws_imagebuilder_image_recipe", aws), managed("aws_sagemaker_model", aws)]), "OK");
});

test("the denied types were reviewed against the full pinned schemas; a change of either pin fails until they are reviewed again", () => {
  const STALE = "re-review the denied types against the new schema";
  assert.equal(AWS_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/aws 6.68.0", STALE);
  assert.equal(AZURE_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/azurerm 4.81.0", STALE);
  const root = new URL("../", import.meta.url);
  const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
  // The provider versions the repository's real-tool evidence was captured with (test/fixtures/live/MANIFEST.json) are the reviewed ones.
  const manifest = read("test/fixtures/live/MANIFEST.json");
  for (const [name, reviewed] of [["aws", AWS_DENIED_TYPES_REVIEWED_AGAINST], ["azurerm", AZURE_DENIED_TYPES_REVIEWED_AGAINST]] as const) {
    const recorded = new Set([...manifest.matchAll(new RegExp("hashicorp/" + name + " (\\d+\\.\\d+\\.\\d+)", "g"))].map((m) => "hashicorp/" + name + " " + m[1]));
    assert.deepEqual([...recorded], [reviewed], name + ": the evidence names another version; " + STALE);
  }
  // Every version constraint the repository commits for either provider, in Terraform files and in generated configuration, is the
  // one recorded with the review. A widened or moved constraint admits another schema.
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const path = dir + entry.name;
      if (entry.isDirectory()) { if (!entry.name.startsWith(".") && entry.name !== "node_modules") walk(path + "/"); continue; }
      if (!/\.(tf|ts)$/.test(entry.name)) continue;
      const lines = read(path).split("\n");
      lines.forEach((line, index) => {
        const provider = /source\s*=\s*\\?"hashicorp\/(aws|azurerm)\\?"/.exec(line)?.[1];
        const version = provider ? /version\s*=\s*\\?"([^"\\]+)\\?"/.exec(lines.slice(index + 1, index + 3).join("\n"))?.[1] : undefined;
        if (provider) found.push(path + " " + provider + " " + (version ?? "UNCONSTRAINED"));
      });
    }
  };
  for (const dir of ["bootstrap/", "qualification/", "src/", "config/"]) walk(dir);
  assert.deepEqual(found.sort(), [
    "bootstrap/aws/versions.tf aws >= 5.0, < 7.0",
    "bootstrap/azure/modules/environment/versions.tf azurerm ~> 4.0",
    "bootstrap/azure/versions.tf azurerm ~> 4.0",
    "qualification/aws/act-dev1-canary/main.tf aws >= 5.0.0, < 7.0.0",
    "src/build/azure-terraform.ts azurerm >= 4.0, < 5.0",
    "src/qualification/aws-terraform-agent.ts aws >= 5.0, < 7.0",
  ], "a provider version constraint changed; " + STALE);
});
