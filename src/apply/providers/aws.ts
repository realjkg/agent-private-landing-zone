import { EXECUTION_IDENTITIES, iamRoleIdentity, identityVariables } from "../../tools/identity.js";
import { TOKEN_FILE } from "../constants.js";
import { stop } from "../engine.js";
import type { ProviderBlock, ProviderSpec, ProviderUse } from "../provider.js";
import { KEY_SEGMENT, ambientRefusal, isRecord, pickIdentityValue } from "./shared.js";
import { awsContainerFamilyOf } from "../../observe/aws-containers.js";

/**
 * Everything the pilot knows about AWS with the S3 backend (docs/act-pilot-apply.md,
 * "Providers"). Nothing outside this file names an AWS field, variable or backend type.
 *
 * UNVERIFIED: the AWS formats below are from memory. The AWS documentation hosts were unreachable when this
 * was written, so none was checked against them. Account id: 12 digits. Region: like us-east-1. S3 bucket
 * name: 3 to 63 characters, lowercase letters, digits, hyphens and dots, starting and ending with a letter or
 * digit (no ".." is this file's own extra caution). IAM role ARN: arn:aws:iam::<12 digits>:role/<name>,
 * standard "aws" partition only. The attribute names in `backendLocation` and `DENIED_ATTRIBUTE`, the S3 backend settings
 * `use_lockfile` (native locking, Terraform 1.10 and later) and `assume_role_with_web_identity` are likewise from
 * memory, and no real Terraform ran them. A wrong validator refuses a good value (fails closed). A wrong or missing name
 * in `DENIED_ATTRIBUTE` would miss a bad one, so that list is checked against the provider's documentation before live use.
 */

/** One environment's target. `account` in a `ResolvedTarget` is the account id. */
export type AwsTarget = {
  accountId: string;
  region: string;
  /** The S3 backend, written as `<bucket>/<key>`. State locking is the backend's native lock file (`use_lockfile`); no DynamoDB table. */
  backend: string;
  workspace: string;
  /** CDK engine only (`engines/cdk.ts`): the CloudFormation capabilities a change set may use in this environment. Part of the reviewed contract. */
  capabilities?: string[];
};

const ACCOUNT_ID = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const BUCKET = /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ROLE_SEGMENT = "[A-Za-z0-9+=,.@_-]+";
const ROLE_ARN = new RegExp("^arn:aws:iam::([0-9]{12}):role/" + ROLE_SEGMENT + "(?:/" + ROLE_SEGMENT + ")*$");
const accountOfRole = (arn: string): string | undefined => arn.length <= 2048 ? ROLE_ARN.exec(arn)?.[1] : undefined;

function backendOk(value: string): boolean {
  const [bucket, ...key] = value.split("/");
  return BUCKET.test(bucket) && key.length > 0 && key.every((s) => KEY_SEGMENT.test(s));
}

/**
 * Anything that lets a child reach AWS other than through its own web-identity role: static keys, a session
 * token, a shared profile or config file, container credentials, or the instance metadata service (which the
 * runner also switches off for every apply child).
 */
const FALLBACK_VARIABLE = /^(AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_.*|EC2_METADATA.*)|ARM_.*|AZURE_.*)$/;

/** The shared refusals, and a token file that is not an absolute path: a relative one means the runner's directory to the check and the work directory to the child. */
function ambient(env: NodeJS.ProcessEnv) {
  const refusal = ambientRefusal(env, {
    fallback: FALLBACK_VARIABLE, ambient: /^AWS_/, fallbackTo: "static, ambient or another cloud's credentials",
    advice: "The apply identities use AWS_ROLE_ARN with AWS_WEB_IDENTITY_TOKEN_FILE only.",
  });
  if (refusal) return refusal;
  const relative = EXECUTION_IDENTITIES.filter((identity) => {
    const path = identityVariables(env, identity).get("AWS_WEB_IDENTITY_TOKEN_FILE");
    return path !== undefined && !TOKEN_FILE.test(path);
  }).map((identity) => "ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE");
  return relative.length === 0 ? undefined : {
    ok: false as const, code: "IDENTITY_NOT_CONFIGURED" as const, message: "These token file paths are not absolute paths of plain characters: " + relative.join(", ") + ".",
  };
}

/**
 * The partial backend configuration init saves: the contract's bucket, key and region, native locking, and the
 * STATE_WRITE role's web-identity settings (role ARN and token file path, neither a secret). Every value is
 * checked against a strict pattern before it is written into HCL.
 */
function backendLocation(target: AwsTarget): string {
  if (!backendOk(target.backend) || !REGION.test(target.region)) return stop("BACKEND_NOT_IN_CONTRACT");
  const [bucket, ...key] = target.backend.split("/");
  return [`bucket = "${bucket}"`, `key = "${key.join("/")}"`, `region = "${target.region}"`, "use_lockfile = true", ""].join("\n");
}

function backendConfig(env: NodeJS.ProcessEnv, target: AwsTarget): string {
  const pick = (name: string, ok: RegExp): string => pickIdentityValue(env, "STATE_WRITE", name, ok);
  return backendLocation(target) + [
    "assume_role_with_web_identity = {",
    `  role_arn = "${pick("AWS_ROLE_ARN", ROLE_ARN)}"`,
    `  web_identity_token_file = "${pick("AWS_WEB_IDENTITY_TOKEN_FILE", TOKEN_FILE)}"`,
    "}",
    "",
  ].join("\n");
}

/** The settings init may save with a value: exactly what `backendLocation` and `backendConfig` write (review N3 of #320: an allowlist). */
const SAVED_SETTINGS: ReadonlySet<string> = new Set(["bucket", "key", "region", "use_lockfile", "assume_role_with_web_identity"]);
const ROLE_SETTINGS: ReadonlySet<string> = new Set(["role_arn", "web_identity_token_file"]);

/**
 * The backend init saved, which the plan embeds: the s3 type, the contract's bucket and key (each compared on its own) and region,
 * native locking on, and every other setting absent or `null` (an endpoint, a profile, static keys, another role or a later backend
 * version's attribute is refused). `assume_role_with_web_identity`, when saved, holds exactly STATE_WRITE's own `AWS_ROLE_ARN` and
 * `AWS_WEB_IDENTITY_TOKEN_FILE` in `env` (the environment init's configuration was written from), and nothing else with a value.
 */
function savedBackendMatches(backend: Record<string, unknown>, target: AwsTarget, env: NodeJS.ProcessEnv): boolean {
  const config = isRecord(backend.config) ? backend.config : {};
  const [bucket, ...key] = target.backend.split("/");
  const stateWrite = identityVariables(env, "STATE_WRITE");
  const role = config.assume_role_with_web_identity;
  const roleOk = role === undefined || role === null || (isRecord(role) &&
    role.role_arn === stateWrite.get("AWS_ROLE_ARN") && ROLE_ARN.test(String(role.role_arn)) &&
    role.web_identity_token_file === stateWrite.get("AWS_WEB_IDENTITY_TOKEN_FILE") && TOKEN_FILE.test(String(role.web_identity_token_file)) &&
    Object.entries(role).every(([name, value]) => ROLE_SETTINGS.has(name) || value === null));
  return backend.type === "s3" && config.bucket === bucket && config.key === key.join("/") && config.region === target.region && config.use_lockfile === true &&
    roleOk && Object.entries(config).every(([name, value]) => SAVED_SETTINGS.has(name) || value === null);
}

const constantOf = (expression: unknown): unknown => isRecord(expression) && expression.constant_value !== null ? expression.constant_value : undefined;
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).map(String);
/** A nested block in `show -json` is a list of objects of expressions (one object is read the same way). */
const blocksOf = (expression: unknown): Record<string, unknown>[] => (Array.isArray(expression) ? expression : [expression]).filter(isRecord);

const isSet = (expression: unknown): boolean => !(isRecord(expression) && expression.constant_value === null);

const HASHICORP = "registry.terraform.io/hashicorp/";
const AWS_PROVIDER = HASHICORP + "aws";
/**
 * Terraform's built-in provider, which `show -json` lists under this name whenever a project uses one of its types. The real engine
 * exposed its absence from the allowlist (docs/act-pilot-simulation-aws.md): the built-in-only fixture the emulated simulation runs
 * could not be sealed. It is allowed for exactly one type, `BUILTIN_ALLOWED_TYPE` (`assertBuiltinUses`), never as a whole.
 */
const BUILTIN_PROVIDER = "terraform.io/builtin/terraform";
/** The providers a project may use besides aws: the built-in one (one type of it) and ones that reach no cloud. Any other (azurerm, a second cloud, a lookalike namespace) is refused. */
const ALLOWED_PROVIDERS: readonly string[] = [AWS_PROVIDER, BUILTIN_PROVIDER, ...["random", "null", "time", "tls"].map((name) => HASHICORP + name)];
/**
 * The one built-in type a pilot project may use: a managed value holder that reaches nothing. `terraform_remote_state` is a data
 * source that reads another backend with the running identity's credentials, and any built-in type this file does not name is
 * unknown; both are refused (`PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT`). Judged by the provider the plan names and, failing closed, by the
 * type's `terraform_` prefix, which no allowed registry provider owns, so a use whose provider the plan left unnamed is still judged.
 */
const BUILTIN_ALLOWED_TYPE = "terraform_data";
const BUILTIN_TYPE = /^terraform_/;
const DATA_ADDRESS = /(^|\.)data\./;
function assertBuiltinUses(uses: readonly ProviderUse[]): void {
  for (const use of uses) {
    const id = use.provider.full_name ?? (use.provider.name !== undefined ? HASHICORP + use.provider.name : undefined);
    if (id !== BUILTIN_PROVIDER && !BUILTIN_TYPE.test(use.type) && use.provider.name !== "terraform") continue;
    if (use.mode === "data" || DATA_ADDRESS.test(use.address) || use.type !== BUILTIN_ALLOWED_TYPE) stop("PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT");
  }
}
/**
 * The reviewed data sources a pilot project may read (review N1 of #320): metadata about the running identity and place, the IAM
 * policy document renderer (local, reads nothing), and the minimal workload's own type. A data source is read at plan time, as
 * the identity that plans, so its result sits in the sealed plan every approver handles and, after the apply, in the state: any
 * other one, of this provider or any other (a token or secret reader such as `aws_ecr_authorization_token`,
 * `aws_secretsmanager_secret_version`, `aws_redshift_cluster_credentials` or `aws_s3_object`; `aws_lambda_invocation`, which
 * runs a function; `http` from another provider), is refused (PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT). A type joins the list by
 * review. The refusal comes after the plan ran, so it keeps the result out of the sealed plan and the state; it cannot undo the
 * read itself, which the planning identity's IAM bounds (docs/act-pilot-apply.md, AWS). Terraform's built-in data sources are
 * judged by `assertBuiltinUses`. A use whose mode the plan leaves unsaid is judged as a data source.
 */
export const AWS_DATA_SOURCES: ReadonlySet<string> = new Set([
  "aws_caller_identity", "aws_region", "aws_partition", "aws_default_tags", "aws_iam_policy_document", "aws_cloudwatch_log_group",
]);
const isDataUse = (use: ProviderUse): boolean => use.mode !== "managed" || DATA_ADDRESS.test(use.address);
/**
 * Types of an allowed provider that run code or deploy a template instead of holding a resource (review of #327, N1 and round 2 B1; the same reason Terraform actions
 * and provisioners are refused): `aws_lambda_invocation` invokes a function at apply, as APPLY, and `aws_ssm_association` runs a
 * document (commands) on instances. Both are in hashicorp/aws 6.68.0's schema (checked 2026-10-27). A managed use is refused
 * (`PROVIDER_TYPE_NOT_ALLOWED`); a data source of the first is refused as outside `AWS_DATA_SOURCES`.
 */
export const AWS_DENIED_TYPES: ReadonlySet<string> = new Set([
  "aws_lambda_invocation", "aws_ssm_association",
  // Template deployments (review of #327, round 2, B1): one plan row hides a whole CloudFormation template, its custom resources
  // and, for stack sets, other accounts and regions, none of it in the change list; a Service Catalog product provisions one the
  // same way. All five are in hashicorp/aws 6.68.0's schema (checked 2026-10-28). The CDK engine is separate and has its own judge.
  "aws_cloudformation_stack", "aws_cloudformation_stack_set", "aws_cloudformation_stack_set_instance", "aws_cloudformation_stack_instances",
  "aws_servicecatalog_provisioned_product",
]);
/**
 * Every use's provider is an allowed one, no managed use is of a denied type (`AWS_DENIED_TYPES`), and a use whose provider the plan
 * does not name is refused (review N2 of #320: a resource
 * or data source of a provider with no configuration block, `data.http.x` among them, is still judged); every data source is reviewed.
 */
function assertUses(uses: readonly ProviderUse[]): void {
  for (const use of uses) {
    const id = providerIdOf(use.provider);
    if (id === undefined || !ALLOWED_PROVIDERS.includes(id)) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    // And every stack container family the cleanup already keeps (../../observe/aws-containers.ts): one plan row that deploys a
    // template (a SAR application, a SageMaker project, Proton, Elastic Beanstalk, Quick Setup, DataZone, Control Tower).
    if (!isDataUse(use) && (AWS_DENIED_TYPES.has(use.type) || awsContainerFamilyOf(use.type) !== undefined)) stop("PROVIDER_TYPE_NOT_ALLOWED");
    if (id !== BUILTIN_PROVIDER && isDataUse(use) && !AWS_DATA_SOURCES.has(use.type)) stop("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  }
}
/** A use's provider: its full name, or from its local name alone the built-in provider for `terraform` and a hashicorp one otherwise. */
const providerIdOf = (provider: ProviderUse["provider"]): string | undefined =>
  provider.full_name ?? (provider.name === "terraform" ? BUILTIN_PROVIDER : provider.name !== undefined ? HASHICORP + provider.name : undefined);

/**
 * What the aws provider takes from the APPLY identity's environment and nowhere else: static or shared credentials and
 * config files, endpoints, proxies, a trust store, the metadata service, and the `skip_*` switches that turn off the account
 * check. Refused whether constant or an expression, because an expression resolves to the same thing.
 */
const DENIED_ATTRIBUTE = /^(access_key|secret_key|token|profile|shared_credentials_files?|shared_config_files?|endpoints|http_proxy|https_proxy|no_proxy|custom_ca_bundle|ec2_metadata_service_endpoint(_mode)?|insecure|skip_.*)$/;
/** A token (file) names another identity's credential. The role is the APPLY identity's, whose token comes from its own environment. */
const DENIED_ROLE_ATTRIBUTE = /^web_identity_token(_file)?$/;

/**
 * The provider half of the contract binding. Only the allowed providers may appear (`ALLOWED_PROVIDERS`), in a provider block and as
 * the provider of every resource and data source the plan names (a use with no provider named is refused); of the built-in provider
 * only `terraform_data` resources (`assertBuiltinUses`); and only the reviewed data sources (`AWS_DATA_SOURCES`). In an aws
 * provider block no attribute of `DENIED_ATTRIBUTE` is set; a constant `allowed_account_ids` must include the contract's
 * account, a constant `forbidden_account_ids` must not; and a constant `role_arn` in `assume_role` or
 * `assume_role_with_web_identity` must be the APPLY identity's own role (any role in another account is refused as such),
 * with no token of its own. An expression for an account or a role (a variable, a data source) is not checkable from the
 * plan and is not judged; the runbook says so. A block's `region` is not judged: a second region is ordinary, and the
 * account is what the credentials bound.
 */
function assertProviderConfig(blocks: readonly ProviderBlock[], target: AwsTarget, env: NodeJS.ProcessEnv, uses: readonly ProviderUse[]): void {
  assertBuiltinUses(uses);
  assertUses(uses);
  const applyRole = iamRoleIdentity(identityVariables(env, "APPLY").get("AWS_ROLE_ARN") ?? "");
  for (const provider of blocks) {
    const id = provider?.full_name ?? HASHICORP + provider?.name;
    if (!ALLOWED_PROVIDERS.includes(id)) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    if (id !== AWS_PROVIDER) continue;
    const expressions = provider.expressions ?? {};
    if (Object.entries(expressions).some(([name, expression]) => DENIED_ATTRIBUTE.test(name) && isSet(expression))) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    const allowed = constantOf(expressions.allowed_account_ids);
    if (allowed !== undefined && listOf(allowed).length > 0 && !listOf(allowed).includes(target.accountId)) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
    const forbidden = constantOf(expressions.forbidden_account_ids);
    if (forbidden !== undefined && listOf(forbidden).includes(target.accountId)) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
    for (const block of [expressions.assume_role, expressions.assume_role_with_web_identity].flatMap(blocksOf)) {
      if (Object.entries(block).some(([name, expression]) => DENIED_ROLE_ATTRIBUTE.test(name) && isSet(expression))) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
      const role = constantOf(block.role_arn);
      if (role === undefined) continue;
      if (accountOfRole(String(role)) !== target.accountId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
      if (applyRole === undefined || iamRoleIdentity(String(role)) !== applyRole) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    }
  }
}

export const AWS: ProviderSpec = {
  id: "AWS",
  accountFields: { accountId: (v) => ACCOUNT_ID.test(v), region: (v) => REGION.test(v) },
  backendOk,
  account: (target) => (target as AwsTarget).accountId,
  accountNoun: "account",
  targetNoun: "account and region",
  clientIdVariable: "AWS_ROLE_ARN",
  clientIdOk: (v) => accountOfRole(v) !== undefined && v === v.toLowerCase(),
  principalPerEnvironment: true,
  logSource: "AWS CloudTrail logs (STS role assumptions and S3 data events)",
  identityTargetVariables: {
    AWS_ROLE_ARN: (v, t) => accountOfRole(v) === (t as AwsTarget).accountId,
    AWS_REGION: (v, t) => v.toLowerCase() === (t as AwsTarget).region,
  },
  ambientRefusal: ambient,
  backendConfig: (env, target) => backendConfig(env, target as AwsTarget),
  savedBackendMatches: (saved, target, env) => savedBackendMatches(saved, target as AwsTarget, env),
  // The product override pins the s3 backend; the plan embeds what the seal-time init saved from the product's own backend file.
  backendType: "s3",
  backendLocation: (target) => backendLocation(target as AwsTarget),
  filledAtApply: ["assume_role_with_web_identity"],
  tagAttributes: ["tags_all", "tags"],
  assertProviderConfig: (blocks, target, env, uses) => assertProviderConfig(blocks, target as AwsTarget, env, uses),
};
