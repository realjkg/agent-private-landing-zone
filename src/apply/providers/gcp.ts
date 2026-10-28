import { checkCredentialConfiguration, projectOfServiceAccount, SERVICE_ACCOUNT } from "../../tools/gcp-credentials.js";
import { EXECUTION_IDENTITIES, identityVariables, samePrincipalValue, type ExecutionIdentity } from "../../tools/identity.js";
import { TOKEN_FILE } from "../constants.js";
import { stop } from "../engine.js";
import type { IdentityRefusal, ProviderBlock, ProviderSpec, ProviderUse } from "../provider.js";
import { KEY_SEGMENT, ambientRefusal, isRecord, pickIdentityValue } from "./shared.js";

/**
 * Everything the pilot knows about Google Cloud with the `gcs` backend and the `hashicorp/google` provider
 * (docs/act-pilot-gcp-terraform-g0.md; the GCP release-path PLAN, owner approval 6433121154 on issue #39). Nothing
 * outside this file names a GCP field, variable or backend type.
 *
 * ADMITTED IN CODE, DEV ONLY (owner decision 6481421924 on issue #39). "GCP" is a `ProviderId`, this spec is in the `SPECS` table
 * (src/apply/provider.ts), and the contract admits GCP with the Terraform engine under the DEV-only scope only (src/apply/contract.ts,
 * `DEV_ONLY_PATHS`). An APPLY still needs the owner's reviewed contract with an `authorize` entry and a canary allowlist, and the
 * repository ships none, so ACT stays DISABLED.
 *
 * Self-contained by design: the identity collapse checks for the two GCP principal variables and the built-in provider rule
 * live here rather than in the shared modules (src/tools/identity.ts, providers/aws.ts), so this slice changes nothing the
 * AWS and Azure paths run.
 *
 * Fail-closed defaults the owner adopted with the PLAN: P1 (a credential configuration carrying its own
 * `service_account_impersonation_url` is refused), P2 (`STORAGE_EMULATOR_HOST` is refused by name, in every identity and in
 * the runner's own environment, and no backend setting ever names an endpoint) and P4 (the state bucket is protected under
 * every identifier form, `backendBucketForms`). The S0 spike (docs/act-pilot-simulation-gcp.md, finding G1) showed that
 * `access_token` is saved in plaintext and embedded in the plan, so no backend configuration or saved backend may carry one.
 *
 * UNVERIFIED: the GCP formats below are from memory, as the PLAN marks them. Project id: 6 to 30 characters, lowercase
 * letters, digits and hyphens, starting with a letter and not ending with a hyphen. Region: like europe-west4. Bucket: this
 * file accepts only the dotless form (3 to 63 lowercase letters, digits, hyphens and underscores, starting and ending with a
 * letter or digit, no "goog" prefix and no "google"), a deliberate narrowing. Service account: `<6 to 30 chars>@<project>.iam.gserviceaccount.com`.
 * A wrong validator refuses a good value (fails closed). The denied-attribute lists are checked against the provider's
 * documentation before live use, as on AWS.
 */

/**
 * The credential-configuration check and the service-account pattern live in src/tools/gcp-credentials.ts, outside src/apply, so
 * the GCP reader (src/observe/gcp-rest.ts) applies the same check without reaching the apply path (test/apply-boundary.test.ts).
 */
export { checkCredentialConfiguration, projectOfServiceAccount, type ConfigurationResult } from "../../tools/gcp-credentials.js";

/** One environment's target. `account` in a `ResolvedTarget` is the project id. */
export type GcpTarget = {
  projectId: string;
  region: string;
  /** The gcs backend, written as `<bucket>/<prefix>`. Locking is the backend's native lock object (`<prefix>/<workspace>.tflock`). */
  backend: string;
  workspace: string;
  /** Optional `organizations/<n>` or `folders/<n>`: a readiness check for DISCOVERY only. It carries no authority. */
  parent?: string;
};

/** The spec's own type: `ProviderSpec` with its id and backend type fixed. */
export type GcpProviderSpec = ProviderSpec & { id: "GCP"; backendType: "gcs" };

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/;
const BUCKET = /^(?!goog)(?!.*google)[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;
const PARENT = /^(organizations|folders)\/[1-9][0-9]{0,24}$/;

/** The variables each identity carries, and nothing else under a Google prefix. The suffix is what the engine's child receives. */
const CREDENTIALS = "GOOGLE_APPLICATION_CREDENTIALS";
const IMPERSONATE = "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT";
export const GCP_IDENTITY_VARIABLES: readonly string[] = [CREDENTIALS, IMPERSONATE, "GOOGLE_PROJECT", "GOOGLE_REGION"];

function backendOk(value: string): boolean {
  const [bucket, ...prefix] = value.split("/");
  return BUCKET.test(bucket) && prefix.length > 0 && prefix.every((s) => KEY_SEGMENT.test(s));
}

/**
 * Anything that lets a child reach Google other than through its own credential configuration and impersonated service
 * account: every other `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `GCE_*` variable (key files, access tokens, a backend's own
 * credentials or encryption key, client certificates, the metadata server), the storage emulator (P2), and another cloud's
 * credentials. An allowlist by name: a Google variable this file does not name is refused.
 */
const FALLBACK_VARIABLE = /^(?!GOOGLE_(APPLICATION_CREDENTIALS|IMPERSONATE_SERVICE_ACCOUNT|PROJECT|REGION)$)(GOOGLE_.*|GCLOUD_.*|CLOUDSDK_.*|GCE_.*|STORAGE_EMULATOR_HOST|AWS_.*|ARM_.*|AZURE_.*)$/;

/** P2: the storage emulator variable, refused by name wherever it appears. The S6 test harness sets it in its own child only. */
const EMULATOR_VARIABLE = "STORAGE_EMULATOR_HOST";


const notConfigured = (message: string): IdentityRefusal => ({ ok: false, code: "IDENTITY_NOT_CONFIGURED", message });

/** One service account whatever its case or padding; one credential configuration whatever its path spelling, symlink or hard link. */
const PRINCIPAL_SAME: Readonly<Record<string, (a: string, b: string) => boolean>> = {
  [IMPERSONATE]: (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase(),
  [CREDENTIALS]: (a, b) => samePrincipalValue("TOKEN_FILE", a, "TOKEN_FILE", b),
};

/**
 * Two identities that impersonate the same service account or read the same credential configuration, and an identity that
 * carries the operator's own (`GOOGLE_*` outside `ALZ_`, which is never handed to a child), are one principal. Names only.
 */
function collapsedPrincipals(env: NodeJS.ProcessEnv): IdentityRefusal | undefined {
  const between: string[] = [];
  const operator: string[] = [];
  EXECUTION_IDENTITIES.forEach((a, index) => {
    for (const [name, same] of Object.entries(PRINCIPAL_SAME)) {
      const value = identityVariables(env, a).get(name);
      if (value === undefined) continue;
      for (const b of EXECUTION_IDENTITIES.slice(index + 1)) {
        const other = identityVariables(env, b).get(name);
        if (other !== undefined && same(value, other)) between.push(a + " and " + b + " (" + name + ")");
      }
      const own = env[name];
      if (own !== undefined && own !== "" && same(value, own)) operator.push("ALZ_" + a + "_" + name + " equals " + name);
    }
  });
  if (between.length > 0) {
    return { ok: false, code: "IDENTITY_COLLAPSED", message: "These identities carry the same secret or client id: " + between.join("; ") + ". Each identity must be a separate principal." };
  }
  return operator.length === 0 ? undefined : {
    ok: false, code: "IDENTITY_COLLAPSED", message: "These identities carry the operator's own credentials: " + operator.join("; ") + ". No identity is the operator.",
  };
}

/**
 * The provider's identity refusals, after the shared ones: the emulator variable in the runner's own environment (P2); an
 * identity without both its credential configuration and its service account (a missing one would fall back to Application
 * Default Credentials); a credential configuration that is not a workload identity federation file source (P1 included); and
 * two identities whose configurations read the same token file.
 */
function ambient(env: NodeJS.ProcessEnv): IdentityRefusal | undefined {
  if (env[EMULATOR_VARIABLE] !== undefined) {
    return notConfigured(EMULATOR_VARIABLE + " is set in this environment. It redirects Terraform state to another server with no credential; the pilot refuses it.");
  }
  const refusal = ambientRefusal(env, {
    fallback: FALLBACK_VARIABLE, ambient: /^(GOOGLE|GCLOUD|CLOUDSDK)_/, fallbackTo: "a key file, an access token, the gcloud CLI, the metadata server, the storage emulator or another cloud's credentials",
    advice: "The apply identities use GOOGLE_APPLICATION_CREDENTIALS (a workload identity federation configuration) with GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, GOOGLE_PROJECT and GOOGLE_REGION only.",
  });
  if (refusal) return refusal;
  const incomplete: string[] = [];
  const unusable: string[] = [];
  const tokenFiles: [ExecutionIdentity, string][] = [];
  for (const identity of EXECUTION_IDENTITIES) {
    const variables = identityVariables(env, identity);
    if (variables.size === 0) continue;
    for (const name of [CREDENTIALS, IMPERSONATE]) if (!variables.has(name)) incomplete.push("ALZ_" + identity + "_" + name);
    const impersonated = variables.get(IMPERSONATE);
    if (impersonated !== undefined && projectOfServiceAccount(impersonated) === undefined) unusable.push("ALZ_" + identity + "_" + IMPERSONATE + " is not a service account email");
    const path = variables.get(CREDENTIALS);
    if (path === undefined) continue;
    const result = checkCredentialConfiguration(path);
    if (result.ok) tokenFiles.push([identity, result.tokenFile]);
    else unusable.push("ALZ_" + identity + "_" + CREDENTIALS + " " + result.reason);
  }
  if (incomplete.length > 0) return notConfigured("These identity variables are not set: " + incomplete.join(", ") + ". Without them a child would fall back to Application Default Credentials.");
  const collapsed = collapsedPrincipals(env);
  if (collapsed) return collapsed;
  if (unusable.length > 0) return notConfigured("These credential settings are refused: " + unusable.join("; ") + ".");
  const shared: string[] = [];
  tokenFiles.forEach(([a, fileA], index) => {
    for (const [b, fileB] of tokenFiles.slice(index + 1)) if (samePrincipalValue("TOKEN_FILE", fileA, "TOKEN_FILE", fileB)) shared.push(a + " and " + b);
  });
  return shared.length === 0 ? undefined : {
    ok: false, code: "IDENTITY_COLLAPSED",
    message: "These identities' credential configurations read the same token file: " + shared.join("; ") + ". Each identity must be a separate principal.",
  };
}

/** The contract target's bucket and prefix only. Never an endpoint (P2), an access token or an encryption key. */
function backendLocation(target: GcpTarget): string {
  if (!backendOk(target.backend)) return stop("BACKEND_NOT_IN_CONTRACT");
  const [bucket, ...prefix] = target.backend.split("/");
  return [`bucket = "${bucket}"`, `prefix = "${prefix.join("/")}"`, ""].join("\n");
}

/**
 * The partial backend configuration init saves: the contract's location and the STATE_WRITE identity's credential
 * configuration path and service account email (neither a secret). Every value is checked against a strict pattern before
 * it is written into HCL, and the email must be of the target's project.
 */
const CREDENTIALS_SETTING = "credentials";
const IMPERSONATE_SETTING = "impersonate_service_account";

function backendConfig(env: NodeJS.ProcessEnv, target: GcpTarget): string {
  const email = pickIdentityValue(env, "STATE_WRITE", IMPERSONATE, SERVICE_ACCOUNT);
  if (projectOfServiceAccount(email) !== target.projectId) return stop("STATE_WRITE_BACKEND_CONFIG_INVALID");
  return backendLocation(target) + [
    `${CREDENTIALS_SETTING} = "${pickIdentityValue(env, "STATE_WRITE", CREDENTIALS, TOKEN_FILE)}"`,
    `${IMPERSONATE_SETTING} = "${email}"`,
    "",
  ].join("\n");
}

/**
 * The settings init may save with a value: exactly what `backendLocation` and `backendConfig` write (review N2 of #305: an
 * allowlist). Init saves every other attribute of the backend's schema as `null` (the S0 spike's saved shape, finding B), and an
 * environment default is not saved. So a token or encryption key (stored in plaintext and embedded in the plan, spike finding G1),
 * an endpoint (finding H), delegates (an impersonation chain) and any attribute a later backend version adds are all refused.
 */
const SAVED_SETTINGS: ReadonlySet<string> = new Set(["bucket", "prefix", CREDENTIALS_SETTING, IMPERSONATE_SETTING]);

/**
 * The bucket and prefix init saved must be the contract's, under the gcs type; `credentials` and `impersonate_service_account`,
 * when saved, must be exactly the STATE_WRITE identity's own `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
 * in `env` (the environment init's configuration was written from); and every other setting must be absent or `null`.
 */
function savedBackendMatches(backend: Record<string, unknown>, target: GcpTarget, env: NodeJS.ProcessEnv): boolean {
  const config = isRecord(backend.config) ? backend.config : {};
  const [bucket, ...prefix] = target.backend.split("/");
  const stateWrite = identityVariables(env, "STATE_WRITE");
  const unsetOr = (name: string, variable: string, ok: RegExp): boolean =>
    config[name] === undefined || config[name] === null || (typeof config[name] === "string" && ok.test(config[name] as string) && stateWrite.get(variable) === config[name]);
  // Each part on its own (review N5 of #320): a bucket and prefix joined differently cannot name the same "<bucket>/<prefix>".
  return backend.type === "gcs" && config.bucket === bucket && config.prefix === prefix.join("/") &&
    unsetOr(CREDENTIALS_SETTING, CREDENTIALS, TOKEN_FILE) && unsetOr(IMPERSONATE_SETTING, IMPERSONATE, SERVICE_ACCOUNT) &&
    Object.entries(config).every(([name, value]) => SAVED_SETTINGS.has(name) || value === null);
}

const HASHICORP = "registry.terraform.io/hashicorp/";
const GOOGLE_PROVIDER = HASHICORP + "google";
const BUILTIN_PROVIDER = "terraform.io/builtin/terraform";
/** `hashicorp/google` and providers that reach no cloud. `google-beta` is refused (PLAN Q7): a beta resource is not in the reader's table. */
const ALLOWED_PROVIDERS: readonly string[] = [GOOGLE_PROVIDER, BUILTIN_PROVIDER, ...["random", "null", "time", "tls"].map((name) => HASHICORP + name)];
/**
 * What the google provider takes from the APPLY identity's environment and nowhere else: credentials, tokens, impersonation,
 * scopes, endpoints and the universe, and the request and billing overrides. Refused whether constant or an expression.
 */
const DENIED_ATTRIBUTE = /^(credentials|access_token|impersonate_service_account(_delegates)?|scopes|.*_custom_endpoint|universe_domain|request_reason|billing_project|user_project_override|external_credentials)$/;

/**
 * Terraform's built-in provider is allowed for `terraform_data` resources only, the rule providers/aws.ts applies (#279): a
 * `terraform_remote_state` data source reads another backend with the running identity, and any other built-in type is unknown.
 * Judged by the provider the plan names and, failing closed, by the `terraform_` type prefix, which no allowed provider owns.
 */
function assertBuiltinUses(uses: readonly ProviderUse[]): void {
  for (const use of uses) {
    if (providerIdOf(use.provider) !== BUILTIN_PROVIDER && !/^terraform_/.test(use.type) && use.provider.name !== "terraform") continue;
    if (use.mode === "data" || /(^|\.)data\./.test(use.address) || use.type !== "terraform_data") stop("PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT");
  }
}

/** A provider's id: its full name, or from its local name alone the built-in provider for `terraform` and a hashicorp one otherwise. */
const providerIdOf = (provider: Pick<ProviderBlock, "name" | "full_name">): string | undefined =>
  provider.full_name ?? (provider.name === "terraform" ? BUILTIN_PROVIDER : provider.name !== undefined ? HASHICORP + provider.name : undefined);
const isSet = (expression: unknown): boolean => expression !== undefined && !(isRecord(expression) && expression.constant_value === null);

/**
 * The reviewed data sources a GCP pilot project may read (review N3 of #305, made an allowlist by review N1 of #320): the project
 * (metadata) and the canary's own type. A data source is read at plan time, as the identity that plans, so its result sits in the
 * sealed plan every approver handles and, after the apply, in the state: any other one, of any provider, is refused
 * (PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT). That keeps out the running identity's OAuth access token (`google_client_config`), tokens,
 * ID tokens and signed JWTs minted for a service account, Secret Manager payloads, KMS-decrypted plaintext, signed URLs
 * (`google_storage_object_signed_url`), object contents (`google_storage_bucket_object_content`), cluster credentials
 * (`google_container_cluster`) and Terraform's `terraform_remote_state`. A type joins the list by review. The refusal keeps the
 * result out of the sealed plan; it cannot undo the read, which DISCOVERY's IAM bounds. A use whose mode is unsaid is judged as a
 * data source. Both types are in hashicorp/google 8.9.0's schema (checked 2026-10-28).
 */
export const GCP_DATA_SOURCES: ReadonlySet<string> = new Set(["google_project", "google_pubsub_topic"]);
const DATA_ADDRESS = /(^|\.)data\./;
const isDataUse = (use: ProviderUse): boolean => use.mode !== "managed" || DATA_ADDRESS.test(use.address);

/**
 * The attribute that names the project each reviewed data source reads (review N3 of #323): `google_project` reads any project
 * DISCOVERY can see (labels, number, billing account id), and `google_pubsub_topic` a topic in any project. Each must name the
 * contract's project as a constant in the configuration, so an omitted project (the provider's default) or an expression is refused
 * (PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT), and a constant or a read value naming another project is refused
 * (PROVIDER_ACCOUNT_NOT_IN_CONTRACT). The read happened at plan time; the refusal keeps its result out of the sealed plan.
 */
const DATA_SOURCE_PROJECT: Readonly<Record<string, string>> = { google_project: "project_id", google_pubsub_topic: "project" };

function assertDataSourceProjects(uses: readonly ProviderUse[], target: GcpTarget): void {
  const configured = new Set<string>();
  for (const use of uses) {
    const attribute = Object.hasOwn(DATA_SOURCE_PROJECT, use.type) ? DATA_SOURCE_PROJECT[use.type] : undefined;
    if (attribute === undefined || !isDataUse(use)) continue;
    if (use.expressions !== undefined) {
      configured.add(use.type);
      const expression = use.expressions[attribute];
      const constant = isRecord(expression) && Object.keys(expression).length === 1 ? expression.constant_value : undefined;
      if (typeof constant !== "string") stop("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
      if (constant !== target.projectId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
    }
    const read = use.values?.[attribute];
    if (typeof read === "string" && read !== target.projectId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
  }
  // A read the configuration tree does not show could not be judged: refused, never assumed to be the contract's project.
  for (const use of uses) {
    if (Object.hasOwn(DATA_SOURCE_PROJECT, use.type) && isDataUse(use) && !configured.has(use.type)) stop("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  }
}

/**
 * The attributes that name the project a managed google resource lives in (review N1 of #339). Every google resource carries its
 * own project, so the provider block's binding alone does not bind a resource. For each managed use of the google provider: a
 * configured `project` or `project_id` must be absent (the provider block's, which `assertProviderConfig` requires to be the
 * contract's constant) or a plain constant equal to the contract's project; a planned value of either must be the contract's
 * project; and one the plan leaves unknown until apply is refused. Another project is PROVIDER_ACCOUNT_NOT_IN_CONTRACT; an
 * expression, a value that is not text or an unknown one is PROVIDER_CONFIG_NOT_IN_CONTRACT, because it cannot be judged before the
 * apply runs. Region and location are not judged here (the canary topic is global; a later reviewed type with a location adds it).
 */
const RESOURCE_PROJECT_ATTRIBUTES: readonly string[] = ["project", "project_id"];

function assertResourceProjects(uses: readonly ProviderUse[], target: GcpTarget): void {
  for (const use of uses) {
    if (isDataUse(use) || providerIdOf(use.provider) !== GOOGLE_PROVIDER) continue;
    for (const attribute of RESOURCE_PROJECT_ATTRIBUTES) {
      if (use.expressions !== undefined && Object.hasOwn(use.expressions, attribute)) {
        const expression = use.expressions[attribute];
        const constant = isRecord(expression) && Object.keys(expression).length === 1 ? expression.constant_value : undefined;
        if (typeof constant !== "string") stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
        if (constant !== target.projectId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
      }
      if (use.unknown !== undefined && use.unknown[attribute] !== undefined && use.unknown[attribute] !== false) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
      if (use.values !== undefined && use.values[attribute] !== undefined && use.values[attribute] !== null) {
        if (typeof use.values[attribute] !== "string") stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
        if (use.values[attribute] !== target.projectId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
      }
    }
  }
}

/**
 * Types of the google provider that run code, or deploy a template or another tool's configuration, at apply or on their own
 * schedule, instead of holding a resource (the same reason the AWS and Azure lists exist, review of #327, N1 and rounds 2 and 3, and
 * the reason Terraform actions and provisioners are refused): one plan row would hide what runs, as whom and where. A managed use is
 * refused (`PROVIDER_TYPE_NOT_ALLOWED`); a data source of one is already outside `GCP_DATA_SOURCES`. Each is in hashicorp/google
 * 8.9.0's schema (a sweep of the full pinned schema, 1392 resource types, checked 2026-10-28; seven added by review N2 of #339). The canary allowlist already refuses
 * any type it does not name; this list is defense in depth so a later allowlist can never name one of these.
 */
export const GCP_DENIED_TYPES: ReadonlySet<string> = new Set([
  // Template and IaC deployments: Deployment Manager deploys a template, Infrastructure Manager runs a Terraform configuration.
  "google_deployment_manager_deployment", "google_config_deployment",
  // Builds at apply: a function or an App Engine version builds the source with Cloud Build when it is deployed; an App Hosting build
  // runs a build; a Cloud Build trigger runs arbitrary build steps as a Cloud Build service account whenever its event fires.
  "google_cloudfunctions_function", "google_cloudfunctions2_function", "google_app_engine_standard_app_version", "google_app_engine_flexible_app_version",
  "google_firebase_app_hosting_build", "google_cloudbuild_trigger",
  // Jobs that run code at apply: a Cloud Run job starts an execution when `start_execution_token` or `run_execution_token` is set; a
  // Dataflow job or flex template launches a pipeline; a Dataproc job, batch or GDC Spark application submits Spark or Hadoop code; a
  // BigQuery job runs a query, load, copy or extract; a Vertex AI custom or pipeline job runs training code; a Colab notebook
  // execution runs a notebook; a Dataplex task runs Spark code; a Healthcare pipeline job runs a pipeline; a Cloud SQL provision script
  // runs SQL against an instance; a Storage batch operations job rewrites or deletes objects in bulk.
  "google_cloud_run_v2_job", "google_dataflow_job", "google_dataflow_flex_template_job", "google_dataproc_job", "google_dataproc_batch",
  "google_dataproc_gdc_spark_application", "google_bigquery_job", "google_vertex_ai_custom_job", "google_vertex_ai_pipeline_job",
  "google_colab_notebook_execution", "google_dataplex_task", "google_healthcare_pipeline_job", "google_sql_provision_script", "google_storage_batch_operations_job",
  // Code on a schedule: Composer runs Airflow and its DAGs; a scheduled query (a BigQuery data transfer configuration) runs SQL as a
  // service account; a Colab schedule runs notebooks; a Data Pipelines pipeline launches Dataflow jobs.
  "google_composer_environment", "google_bigquery_data_transfer_config", "google_colab_schedule", "google_data_pipeline_pipeline",
  // Commands on machines and clusters: OS Config patch deployments (with pre- and post-patch scripts), OS policy assignments and policy
  // orchestrators run commands on VMs; VM extension policies install extensions on VMs; a GKE Hub feature or feature membership
  // installs and runs software (Config Sync, Policy Controller, service mesh) in clusters.
  "google_os_config_patch_deployment", "google_os_config_os_policy_assignment", "google_os_config_v2_policy_orchestrator",
  "google_os_config_v2_policy_orchestrator_for_folder", "google_os_config_v2_policy_orchestrator_for_organization",
  "google_compute_global_vm_extension_policy", "google_compute_zone_vm_extension_policy", "google_gke_hub_feature", "google_gke_hub_feature_membership",
  // Review N2 of #339, by this list's own criterion: a Dataproc cluster runs its initialization actions' scripts on every node at
  // creation; a VM, an instance template's VMs and a Workbench instance run their startup scripts (and Workbench its post-startup
  // script); a Cloud Scheduler job makes authenticated calls as a service account on its schedule; a Cloud Deploy automation promotes
  // and deploys releases on its own; a Dataplex data scan runs its rules (SQL) on its schedule, the first at creation when on demand.
  "google_dataproc_cluster", "google_compute_instance", "google_compute_instance_template", "google_workbench_instance",
  "google_cloud_scheduler_job", "google_clouddeploy_automation", "google_dataplex_datascan",
]);
/**
 * The schema `GCP_DENIED_TYPES` and `GCP_DATA_SOURCES` were reviewed against, in full: hashicorp/google 8.9.0 (released 2026-10-27).
 * test/apply-gcp-admission.test.ts fails ("re-review the denied types against the new schema") when it changes, and a lock or an
 * init that selects any other google version is refused (`PROVIDER_VERSION_NOT_REVIEWED`, src/apply/lockfile.ts).
 */
export const GCP_DENIED_TYPES_REVIEWED_AGAINST = "hashicorp/google 8.9.0";

/**
 * The provider half of the contract binding. Only the allowed providers may appear, in a provider block or as the provider
 * of anything the plan names, and a use whose provider the plan does not name is refused (review N4 of #305); of the built-in
 * provider only `terraform_data` resources; no managed use of a denied type (`GCP_DENIED_TYPES`, PROVIDER_TYPE_NOT_ALLOWED); only the
 * reviewed data sources (`GCP_DATA_SOURCES`, PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT), each naming the contract's project
 * (`assertDataSourceProjects`); every managed google resource's project, configured or planned, is the contract's
 * (`assertResourceProjects`); and a google use needs a google provider block. In every google block no attribute of `DENIED_ATTRIBUTE`
 * is set, `default_labels` is set (the unit labels come from it), and `project` is a plain constant equal to the contract's project
 * (review N1 of #339: an absent project or an expression is refused). `region` and `zone` are not judged.
 */
function assertProviderConfig(blocks: readonly ProviderBlock[], target: GcpTarget, uses: readonly ProviderUse[]): void {
  assertBuiltinUses(uses);
  for (const use of uses) {
    const id = providerIdOf(use.provider);
    if (id === undefined || !ALLOWED_PROVIDERS.includes(id)) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    if (!isDataUse(use) && GCP_DENIED_TYPES.has(use.type)) stop("PROVIDER_TYPE_NOT_ALLOWED");
    if (id !== BUILTIN_PROVIDER && isDataUse(use) && !GCP_DATA_SOURCES.has(use.type)) stop("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT");
  }
  assertDataSourceProjects(uses, target);
  assertResourceProjects(uses, target);
  // A google use needs a google provider block, whose project and default_labels are judged below (review N1 of #339): with none,
  // the provider would take its project from the environment and its labels from nowhere the plan shows.
  if (uses.some((use) => providerIdOf(use.provider) === GOOGLE_PROVIDER) && !blocks.some((block) => providerIdOf(block ?? {}) === GOOGLE_PROVIDER)) {
    stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
  }
  for (const provider of blocks) {
    const id = providerIdOf(provider ?? {});
    if (id === undefined || !ALLOWED_PROVIDERS.includes(id)) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    if (id !== GOOGLE_PROVIDER) continue;
    const expressions = provider.expressions ?? {};
    if (Object.entries(expressions).some(([name, expression]) => DENIED_ATTRIBUTE.test(name) && isSet(expression))) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    if (!isSet(expressions.default_labels)) stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    // Every google block, each alias included, names the contract's project as a plain constant (review N1 of #339): an absent
    // project, an expression or a value that is not text cannot be judged from the plan, so it is refused, never assumed.
    const project = expressions.project;
    const constant = isRecord(project) && Object.keys(project).length === 1 ? project.constant_value : undefined;
    if (typeof constant !== "string") stop("PROVIDER_CONFIG_NOT_IN_CONTRACT");
    if (constant !== target.projectId) stop("PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
  }
}

/**
 * P4: every identifier form under which a state bucket can appear in a recorded id or attribute: the bare name, `b/<bucket>`,
 * `projects/_/buckets/<bucket>`, `gs://<bucket>`, the full resource name `//storage.googleapis.com/projects/_/buckets/<bucket>`
 * and the JSON API self links. The cleanup classifier (slice S4) protects a resource that names any of them.
 */
export function backendBucketForms(bucket: string): string[] {
  return [
    bucket, "b/" + bucket, "projects/_/buckets/" + bucket, "gs://" + bucket, "//storage.googleapis.com/projects/_/buckets/" + bucket,
    "https://storage.googleapis.com/storage/v1/b/" + bucket, "https://www.googleapis.com/storage/v1/b/" + bucket,
  ];
}

/**
 * Whether a recorded value names one of `buckets` under any form, as the whole value, as one of its space- or
 * comma-separated parts (an IAM member id is `b/<bucket> <role> <member>`), or as the prefix of a path inside the bucket.
 * Compared lowercase, which only ever protects more.
 */
export function namesBackendBucket(value: string, buckets: readonly string[]): boolean {
  const parts = value.toLowerCase().split(/[\s,]+/).filter((part) => part !== "");
  const forms = buckets.flatMap((bucket) => backendBucketForms(bucket.toLowerCase()));
  return parts.some((part) => forms.some((form) => part === form || part.startsWith(form + "/")));
}

const asGcp = (target: unknown): GcpTarget => target as GcpTarget;

export const GCP: GcpProviderSpec = {
  id: "GCP",
  accountFields: { projectId: (v) => PROJECT_ID.test(v), region: (v) => REGION.test(v) },
  // The optional organization or folder DISCOVERY's readiness check names; when stated it is in the run's target hash.
  optionalTargetFields: { parent: (v) => PARENT.test(v) },
  backendOk,
  account: (target) => asGcp(target).projectId,
  accountNoun: "project",
  targetNoun: "project and region",
  clientIdVariable: IMPERSONATE,
  clientIdOk: (v) => projectOfServiceAccount(v) !== undefined && v === v.toLowerCase(),
  // A service account email names its project, and each environment is its own project.
  principalPerEnvironment: true,
  logSource: "Cloud Audit Logs (service account impersonation and Cloud Storage data access)",
  identityTargetVariables: {
    [IMPERSONATE]: (v, t) => projectOfServiceAccount(v) === asGcp(t).projectId,
    GOOGLE_PROJECT: (v, t) => v === asGcp(t).projectId,
    GOOGLE_REGION: (v, t) => v.toLowerCase() === asGcp(t).region,
  },
  ambientRefusal: ambient,
  backendConfig: (env, target) => backendConfig(env, asGcp(target)),
  savedBackendMatches: (saved, target, env) => savedBackendMatches(saved, asGcp(target), env),
  backendType: "gcs",
  backendLocation: (target) => backendLocation(asGcp(target)),
  // Spike finding F: `apply <planfile>` takes the backend's connection and credentials from the apply process's environment.
  filledAtApply: [CREDENTIALS_SETTING, IMPERSONATE_SETTING],
  // What init may select (review of #327, round 5): the allowed providers, by exact registry source. The built-in provider is never selected.
  selectableProviders: ALLOWED_PROVIDERS.filter((source) => source !== BUILTIN_PROVIDER),
  tagAttributes: ["effective_labels", "labels"],
  assertProviderConfig: (blocks, target, _env, uses) => assertProviderConfig(blocks, asGcp(target), uses),
};

/** Whether a contract target's optional `parent` is well formed (the contract validator uses `optionalTargetFields`). */
export const gcpParentOk = (value: string): boolean => PARENT.test(value);
