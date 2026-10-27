import assert from "node:assert/strict";
import test from "node:test";

import { codeOf } from "../src/apply/engine.js";
import type { ProviderBlock, ProviderUse } from "../src/apply/provider.js";
import { AWS, AWS_DATA_SOURCES } from "../src/apply/providers/aws.js";
import { AZURE, AZURE_DATA_SOURCES } from "../src/apply/providers/azure.js";
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
