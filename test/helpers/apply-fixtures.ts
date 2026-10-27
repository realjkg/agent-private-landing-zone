import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { signApproval } from "../../src/apply/approval.js";
import { providerSpec } from "../../src/apply/provider.js";
import { writeQualificationEvidence } from "../../src/apply/contract.js";
import { finalizeArtifact, releaseReservation, reserveArtifact } from "../../src/apply/ledger.js";
import type { SealRequest } from "../../src/apply/driver.js";
import { armTypeOf } from "../../src/observe/arm-id.js";
import { APPLY_ADAPTER, CLEANUP_ADAPTER } from "../../src/apply/terraform.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyResult, SealedPlan, SignedApproval } from "../../src/apply/types.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../../src/teardown/driver/adapters/terraform.js";
import type { QualificationRecord } from "../../src/teardown/driver/qualification.js";
import type { ResolvedTarget } from "../../src/teardown/driver/types.js";
import { buildManifest, canonicalJson, type ArtifactManifest } from "../../src/teardown/manifest.js";
import { captureProjectFiles } from "../../src/teardown/snapshot.js";

// Shared by test/apply-driver, apply-seal and apply-terraform. Explicit fixtures
// only: no real tenant, subscription, approver or credential. The engine is a
// fake executable, so everything built on it pins logic, NOT real-engine behavior.

export const PLAN_CANARY = "CANARY_PLAN_BYTES_c1";
export const VALUE_CANARY = "CANARY_PLAN_VALUE_c2";
export const STATE_CANARY = "CANARY_STATE_VALUE_c3";
export const OUTPUT_CANARY = "CANARY_APPLY_OUTPUT_c4";
export const CANARIES = [PLAN_CANARY, VALUE_CANARY, STATE_CANARY, OUTPUT_CANARY];

export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const H = (char: string): string => char.repeat(64);
export const LOCK = '# lock\nprovider "registry.terraform.io/hashicorp/azurerm" {\n  version = "4.10.0"\n}\n';
export const TENANT = "11111111-1111-4111-8111-111111111111";
export const DEV_TARGET: ResolvedTarget = { account: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default" };
export const QA_TARGET: ResolvedTarget = { account: "44444444-4444-4444-8444-444444444444", backend: "fixtureqastore/tfstate/qa.tfstate", workspace: "default" };
export const PROD_TARGET: ResolvedTarget = { account: "33333333-3333-4333-8333-333333333333", backend: "fixtureprodstore/tfstate/prod.tfstate", workspace: "default" };
export const targetOf = (environment: ApplyEnvironment): ResolvedTarget => ({ DEV: DEV_TARGET, QA: QA_TARGET, PROD: PROD_TARGET })[environment];
// AWS: obviously fake account ids, buckets and role ARNs. No real account, bucket or role.
export const AWS_REGION = "us-east-1";
export const AWS_DEV_TARGET: ResolvedTarget = { account: "111111111111", backend: "examplefake-dev-state/pilot/dev.tfstate", workspace: "default" };
export const AWS_QA_TARGET: ResolvedTarget = { account: "222222222222", backend: "examplefake-qa-state/pilot/qa.tfstate", workspace: "default" };
export const AWS_PROD_TARGET: ResolvedTarget = { account: "333333333333", backend: "examplefake-prod-state/pilot/prod.tfstate", workspace: "default" };
export const awsTargetOf = (environment: ApplyEnvironment): ResolvedTarget => ({ DEV: AWS_DEV_TARGET, QA: AWS_QA_TARGET, PROD: AWS_PROD_TARGET })[environment];
const AWS_ROLES = { DISCOVERY: "alz-discovery", STATE: "alz-state", STATE_WRITE: "alz-state-write", APPLY: "alz-apply" } as const;
export const awsRoleArn = (identity: keyof typeof AWS_ROLES, environment: ApplyEnvironment): string =>
  "arn:aws:iam::" + awsTargetOf(environment).account + ":role/" + AWS_ROLES[identity] + "-" + environment.toLowerCase();
export const NOW = new Date("2026-10-11T12:00:00.000Z");
export const POLICY = "2026-10-11.1";
/** The product commit the fixture seals and applies from (the CLI reads the real one from the checkout or the image stamp). */
export const SOURCE_COMMIT = "5ec0de0000000000000000000000000000c0ffee";
export const OPERATOR = "operator.fixture";
export const ENGINE_VERSION = "1.9.5";

// --- the fake engine ---------------------------------------------------------------------------

/** Behaviors are read from behavior.json beside the executable, so each test chooses how the engine acts. */
export type Behavior = {
  version?: string; workspace?: string; failOn?: string; planSalt?: string;
  initWrites?: Array<{ path: string; content: string }>;
  applyExit?: number; applyStderr?: string; applyAdvance?: boolean; applyKill?: boolean;
  /** Creates this file as soon as the named subcommand starts (a kill switch appearing mid-run). */
  touchKillOn?: string;
  /** The apply waits until this file exists (or is stopped), so a test can act while it runs. */
  applyWaitFor?: string;
  /** SIGINT is ignored, so only the final kill ends the apply. */
  ignoreSigint?: boolean;
  /** Plants this text in stderr of the named failing subcommand. */
  failStderr?: string;
  /** Sends this signal to the process that started the engine as soon as the named subcommand starts (a person closing the terminal mid-run). */
  signalParentOn?: { cmd: string; signal: string };
  /** The apply leaves these files in its working directory before it ends (errored.tfstate, crash.log). */
  applyWrites?: Array<{ path: string; content: string }>;
  /** `show` reports one more resource than the plan the seal listed. */
  showExtra?: boolean;
  /** `show` lists only `showResources`, without the two default azurerm resources. */
  showOnlyConfigured?: boolean;
  /** Raw `resource_changes` entries (imports, moves, forgets, hostile addresses), `output_changes` and `configuration.provider_config` that `show` adds. */
  showResources?: unknown[];
  /** When set, `show` stamps these tags on every created resource it lists (under `unitTagAttribute`, default `tags_all`), as a provider's default_tags would. */
  unitTags?: Record<string, string>;
  unitTagAttribute?: string;
  showOutputChanges?: Record<string, unknown>;
  showProviderConfig?: Record<string, unknown>;
  /** What `init` saves in .terraform/terraform.tfstate. Default: the azurerm (or, under an AWS role, the s3) backend of the target whose subscription or account init runs under; null saves none. */
  savedBackend?: unknown;
  /** Raw state resources `state pull` reports (state format 4), so a blueprint can be read after an apply. Default: one resource with a canary attribute and no identifier. */
  stateResources?: unknown[];
  /** After a destroy plan, `show` of the cleanup plan lists a delete of each `-target` address; these raw `resource_changes` are added (a dependent, an update). */
  destroyExtra?: unknown[];
  /** The destroy plan's `show` leaves out these targeted addresses (the state no longer holds them). */
  destroyOmit?: string[];
  /** The cleanup apply removes these state resources (by type.name) from later `state pull` answers; default: every targeted one. */
  destroyKeeps?: string[];
};

const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
const [cmd, sub] = args;
const serialFile = path.join(dir, "serial.txt");
const serial = () => Number(fs.readFileSync(serialFile, "utf8"));
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: process.env, backendFileExists: fs.existsSync(path.resolve(process.cwd(), "../alz-backend.tfbackend")), ...extra }) + "\\n");
const backend = () => { const a = args.find((x) => x.startsWith("-backend-config=")); return a ? fs.readFileSync(path.resolve(process.cwd(), a.slice(16)), "utf8") : undefined; };
if (b.touchKillOn === cmd) fs.writeFileSync(b.killPath, "stop");
if (b.signalParentOn && b.signalParentOn.cmd === cmd) process.kill(process.ppid, b.signalParentOn.signal);
if (b.failOn === cmd) { log({}); process.stderr.write(b.failStderr || "boom ${VALUE_CANARY}"); process.exit(1); }
if (cmd === "version") { log({}); process.stdout.write(JSON.stringify({ terraform_version: b.version })); }
else if (cmd === "init") {
  fs.mkdirSync(".terraform", { recursive: true });
  // Entra ID is saved only when the backend-config file or the project's own block sets it, as the real engine does (docs/act-pilot-simulation.md (a): nothing from the environment is saved).
  const entra = /use_azuread_auth\\s*=\\s*true/.test((backend() || "") + fs.readdirSync(".").filter((n) => n.endsWith(".tf")).map((n) => fs.readFileSync(n, "utf8")).join("\\n"));
  if (b.savedBackend !== null) {
    const def = (${JSON.stringify({ [DEV_TARGET.account]: DEV_TARGET.backend, [QA_TARGET.account]: QA_TARGET.backend, [PROD_TARGET.account]: PROD_TARGET.backend })})[process.env.ARM_SUBSCRIPTION_ID];
    const [account, container, ...key] = (def || "").split("/");
    // The S3 backend of the account the role ARN names, with the region and native locking the partial configuration sets.
    const [bucket, ...s3key] = ((${JSON.stringify(Object.fromEntries([AWS_DEV_TARGET, AWS_QA_TARGET, AWS_PROD_TARGET].map((t) => [t.account, t.backend])))})[(process.env.AWS_ROLE_ARN || "").split(":")[4]] || "").split("/");
    const backend = b.savedBackend || (process.env.AWS_ROLE_ARN
      ? { type: "s3", config: { bucket, key: s3key.join("/"), region: process.env.AWS_REGION, use_lockfile: true } }
      : { type: "azurerm", config: { storage_account_name: account, container_name: container, key: key.join("/"), use_azuread_auth: entra ? true : null } });
    fs.writeFileSync(path.join(".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
  }
  for (const w of b.initWrites || []) { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.content); }
  const bc = args.find((x) => x.startsWith("-backend-config="));
  log({ backendConfig: backend(), backendMode: bc ? fs.statSync(path.resolve(process.cwd(), bc.slice(16))).mode & 0o777 : undefined });
}
else if (cmd === "workspace") { log({}); if (sub === "show") process.stdout.write(b.workspace + "\\n"); }
else if (cmd === "state" && sub === "pull") {
  log({});
  const destroyedFile = path.join(dir, "destroyed.json");
  const destroyed = fs.existsSync(destroyedFile) ? JSON.parse(fs.readFileSync(destroyedFile, "utf8")) : [];
  const resources = (b.stateResources || [{ mode: "managed", type: "terraform_data", name: "canary", instances: [{ attributes: { password: "${STATE_CANARY}" } }] }])
    .filter((r) => !destroyed.includes((r.module ? r.module + "." : "") + r.type + "." + r.name));
  process.stdout.write(JSON.stringify({ version: 4, serial: serial(), resources }));
}
else if (cmd === "plan") {
  const p = path.resolve(process.cwd(), args.find((a) => a.startsWith("-out=")).slice(5));
  fs.writeFileSync(p, "BINARY-PLAN ${PLAN_CANARY} " + (b.planSalt || "") + (args.includes("-destroy") ? " DESTROY" : ""));
  if (args.includes("-destroy")) fs.writeFileSync(path.join(dir, "targets.json"), JSON.stringify(args.filter((a) => a.startsWith("-target=")).map((a) => a.slice(8))));
  log({ planPath: p });
}
else if (cmd === "show" && args[2] && args[2].endsWith("alz-cleanup.tfplan")) {
  log({});
  const targets = JSON.parse(fs.readFileSync(path.join(dir, "targets.json"), "utf8")).filter((t) => !(b.destroyOmit || []).includes(t));
  const typeOf = (address) => address.replace(/^(module\.[^.]+\.)*/, "").split(".")[0];
  process.stdout.write(JSON.stringify({
    format_version: "1.2", errored: false,
    resource_changes: [...targets.map((address) => ({ address, type: typeOf(address), change: { actions: ["delete"], before: { secret: "${VALUE_CANARY}" }, after: null } })), ...(b.destroyExtra || [])],
    output_changes: {},
    configuration: { provider_config: b.showProviderConfig || { azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions: { subscription_id: { references: ["var.subscription_id"] } } } } },
  }));
}
else if (cmd === "show") {
  log({});
  process.stdout.write(JSON.stringify({
    format_version: "1.2", errored: false, variables: { db_password: { value: "${VALUE_CANARY}" } },
    resource_changes: [
      ...(b.showOnlyConfigured ? [] : [
        { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", change: { actions: ["create"], before: null, after: { properties: { k: "${VALUE_CANARY}" } } } },
        { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", change: { actions: ["update"], before: {}, after: {} } },
      ]),
      ...(b.showExtra ? [{ address: "azurerm_key_vault.extra", type: "azurerm_key_vault", change: { actions: ["delete"], before: {}, after: null } }] : []),
      ...(b.showResources || []).map((r) => (b.unitTags && r && r.change && (r.change.actions || []).includes("create"))
        ? { ...r, change: { ...r.change, after: { ...(r.change.after || {}), [b.unitTagAttribute || "tags_all"]: b.unitTags } } } : r),
    ],
    output_changes: b.showOutputChanges || {},
    configuration: { provider_config: b.showProviderConfig || { azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions: { subscription_id: { references: ["var.subscription_id"] } } } } },
  }));
}
else if (cmd === "apply") {
  // A held apply installs its signal handlers before it records the call: tests treat the recorded call as "the engine is
  // running", so a signal sent right after it must meet these handlers, never the default one.
  if (b.applyWaitFor) {
    process.on("SIGINT", () => { if (b.ignoreSigint) return; fs.appendFileSync(path.join(dir, "signals.txt"), "SIGINT\\n"); process.exit(1); });
    process.on("SIGTERM", () => { fs.appendFileSync(path.join(dir, "signals.txt"), "SIGTERM\\n"); process.exit(1); });
  }
  for (const w of b.applyWrites || []) fs.writeFileSync(w.path, w.content);
  const p = path.resolve(process.cwd(), args[3]);
  const bytes = fs.readFileSync(p);
  log({ planSha: crypto.createHash("sha256").update(bytes).digest("hex"), planMode: fs.statSync(p).mode & 0o777, planText: bytes.toString("utf8"), planDir: path.dirname(p), pid: process.pid });
  const finish = () => {
    if (b.applyAdvance) fs.writeFileSync(serialFile, String(serial() + 1));
    // A cleanup apply removes the targeted resources from the state the fake reports afterward (unless the test keeps some).
    if (bytes.toString("utf8").endsWith("DESTROY") && fs.existsSync(path.join(dir, "targets.json"))) {
      const gone = JSON.parse(fs.readFileSync(path.join(dir, "targets.json"), "utf8")).filter((t) => !(b.destroyKeeps || []).includes(t));
      fs.writeFileSync(path.join(dir, "destroyed.json"), JSON.stringify(gone));
    }
    process.stdout.write("APPLY-OUTPUT ${OUTPUT_CANARY}");
    if (b.applyKill) process.kill(process.pid, "SIGKILL");
    if (b.applyStderr) process.stderr.write(b.applyStderr);
    process.exit(b.applyExit || 0);
  };
  if (b.applyWaitFor) {
    const tick = () => { if (fs.existsSync(b.applyWaitFor)) finish(); else setTimeout(tick, 20); };
    tick();
  } else finish();
}
else { log({ unexpected: true }); process.exit(2); }
`;

export function installFakeTerraform(toolDir: string): void {
  writeFileSync(join(toolDir, "terraform"), FAKE, { mode: 0o755 });
  chmodSync(join(toolDir, "terraform"), 0o755);
}

export function behave(toolDir: string, killPath: string, behavior: Behavior = {}): void {
  writeFileSync(join(toolDir, "behavior.json"), JSON.stringify({ version: ENGINE_VERSION, workspace: "default", killPath, ...behavior }));
  writeFileSync(join(toolDir, "serial.txt"), "7");
  for (const name of ["calls.jsonl", "signals.txt", "targets.json", "destroyed.json"]) rmSync(join(toolDir, name), { force: true });
  rmSync(killPath, { force: true });
}

// --- the fake AWS CLI the verifier reads with ------------------------------------------------------------------

/**
 * A fake `aws` for the independent verifier (src/observe): it answers `cloudcontrol get-resource` from a list of existing
 * identifiers and `resourcegroupstaggingapi get-resources` from a list of tagged ARNs, and records every call. Logic
 * only: NOT the real Cloud Control API. Install it in its own tool directory, beside the fake terraform's.
 */
export type AwsReadBehavior = {
  /** Identifiers that exist. */
  existing?: string[];
  /** Identifiers whose read fails with this stderr. */
  fail?: Record<string, string>;
  /** Existing KMS keys reported in KeyState PendingDeletion. */
  pendingDeletion?: string[];
  /** ARNs the tagging API lists. */
  tagged?: string[];
  /** Every call exits non-zero with this stderr (an identity without access). */
  failAll?: string;
};
const FAKE_AWS_READS = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "aws-behavior.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "aws-calls.jsonl"), JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + "\\n");
if (b.failAll) { process.stderr.write(b.failAll); process.exit(254); }
if (args[0] === "cloudcontrol" && args[1] === "get-resource") {
  const identifier = args[args.indexOf("--identifier") + 1];
  if (b.fail && b.fail[identifier]) { process.stderr.write(b.fail[identifier]); process.exit(254); }
  if ((b.existing || []).includes(identifier)) {
    const pending = (b.pendingDeletion || []).includes(identifier);
    process.stdout.write(JSON.stringify({ TypeName: args[3], ResourceDescription: { Identifier: identifier, Properties: JSON.stringify({ Secret: "CANARY_CLOUD_PROPERTY_c5", KeyState: pending ? "PendingDeletion" : "Enabled" }) } }));
    process.exit(0);
  }
  process.stderr.write("An error occurred (ResourceNotFoundException) when calling the GetResource operation: not found");
  process.exit(254);
}
if (args[0] === "resourcegroupstaggingapi") {
  process.stdout.write(JSON.stringify({ ResourceTagMappingList: (b.tagged || []).map((arn) => ({ ResourceARN: arn, Tags: [] })) }));
  process.exit(0);
}
process.stderr.write("unexpected"); process.exit(2);
`;
export function installFakeAwsReads(awsToolDir: string): void {
  writeFileSync(join(awsToolDir, "aws"), FAKE_AWS_READS, { mode: 0o755 });
  chmodSync(join(awsToolDir, "aws"), 0o755);
}
export function behaveAwsReads(awsToolDir: string, behavior: AwsReadBehavior = {}): void {
  writeFileSync(join(awsToolDir, "aws-behavior.json"), JSON.stringify(behavior));
  rmSync(join(awsToolDir, "aws-calls.jsonl"), { force: true });
}
export const awsReadCallsOf = (awsToolDir: string): { args: string[]; env: Record<string, string>; cwd: string }[] => existsSync(join(awsToolDir, "aws-calls.jsonl"))
  ? readFileSync(join(awsToolDir, "aws-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string>; cwd: string })
  : [];

/** A raw state resource (format 4) for the fake's `state pull`: one instance with an id and, when given, an ARN. */
export const stateResource = (type: string, name: string, id: string, arn?: string, module?: string) => ({
  ...(module ? { module } : {}), mode: "managed", type, name, provider: 'provider["registry.terraform.io/hashicorp/aws"]',
  instances: [{ schema_version: 0, attributes: { id, ...(arn ? { arn } : {}), secret_value: STATE_CANARY } }],
});

/** An azurerm state resource: its `id` is the ARM resource id, which is what the Azure reader asks about. */
export const azureStateResource = (type: string, name: string, id: string, module?: string) => ({
  ...(module ? { module } : {}), mode: "managed", type, name, provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
  instances: [{ schema_version: 0, attributes: { id, secret_value: STATE_CANARY } }],
});

// --- the scripted Azure Resource Manager client the reader reads with ---------------------------------------------

/**
 * A scripted HTTP client for the Azure reader (src/observe/azure-rest.ts): the token endpoint answers the DISCOVERY
 * identity's federated token with an access token; management.azure.com answers provider API versions, one resource
 * by id (from a list of existing ids) and the tag listing (from a list of tagged ids). Logic only: NOT the real API.
 * Every request is recorded so a test can prove what was sent, to which host, and that no token appeared where it must not.
 */
export type ArmBehavior = {
  /** ARM ids that exist. */
  existing?: string[];
  /** ARM ids whose read answers this status. */
  fail?: Record<string, number>;
  /** Ids the tag listing returns (resources and resource groups together), split across pages when `pages` is set. */
  tagged?: string[];
  pages?: number;
  /** The token endpoint answers this status instead of 200. */
  tokenStatus?: number;
  /** Every management request answers this status (an identity without access). */
  failAll?: number;
  /** Resource types (namespace/type) the provider does not list. */
  unknownTypes?: string[];
  /** Resource types (namespace/type) the provider offers only in preview API versions. */
  previewOnlyTypes?: string[];
};
export type ArmCall = { method: string; url: string; headers: Record<string, string>; body?: string };
/** The federated token the fake identity carries, and the access token the fake endpoint issues: canaries that must never appear in a record. */
export const ARM_FEDERATED_TOKEN_CANARY = "CANARY_FEDERATED_TOKEN_f3d3r4t3d";
export const ARM_ACCESS_TOKEN_CANARY = "CANARY_ACCESS_TOKEN_4cc355";
export function fakeArmHttp(behavior: ArmBehavior = {}): { http: (request: ArmCall) => Promise<{ status: number; body: string }>; calls: ArmCall[]; behave(next: ArmBehavior): void } {
  const calls: ArmCall[] = [];
  let b = behavior;
  // The resource's own type is its last `/providers/` pair (an extension resource sits under a tracked one), as the real provider reports it; parsed by position like the product, so a group or an account named `providers` is a name.
  const typeOf = (id: string): string => { const type = armTypeOf(id); return type === undefined ? "Unknown/unknown" : type.namespace + "/" + type.typePath; };
  const http = async (request: ArmCall) => {
    calls.push({ ...request, headers: { ...request.headers } });
    const url = new URL(request.url);
    if (url.host === "login.microsoftonline.com") {
      const params = new URLSearchParams(request.body ?? "");
      if (params.get("client_assertion") !== ARM_FEDERATED_TOKEN_CANARY || params.get("grant_type") !== "client_credentials") return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
      if (b.tokenStatus && b.tokenStatus !== 200) return { status: b.tokenStatus, body: JSON.stringify({ error: "CANARY_CLOUD_ERROR_c6" }) };
      return { status: 200, body: JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: ARM_ACCESS_TOKEN_CANARY }) };
    }
    if (url.host !== "management.azure.com") return { status: 0, body: "" };
    if (request.headers.authorization !== "Bearer " + ARM_ACCESS_TOKEN_CANARY) return { status: 401, body: JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }) };
    if (b.failAll) return { status: b.failAll, body: JSON.stringify({ error: { code: "CANARY_CLOUD_ERROR_c6", message: "CANARY_CLOUD_ERROR_c6" } }) };
    const path = decodeURIComponent(url.pathname);
    const providers = /^\/subscriptions\/[^/]+\/providers\/([A-Za-z0-9.]+)$/.exec(path);
    if (providers) {
      const namespace = providers[1];
      // The real provider lists every type it offers whether or not a resource exists; the fake knows a few common ones plus whatever the scenario names.
      const KNOWN_TYPES = ["Microsoft.OperationalInsights/workspaces", "Microsoft.Storage/storageAccounts", "Microsoft.Storage/storageAccounts/blobServices/containers", "Microsoft.Authorization/roleAssignments", "Microsoft.Authorization/locks", "Microsoft.Resources/deployments", "Microsoft.Compute/virtualMachines", "Microsoft.KeyVault/vaults"];
      const types = new Set([...KNOWN_TYPES, ...[...(b.existing ?? []), ...Object.keys(b.fail ?? {}), ...(b.tagged ?? [])].map(typeOf)].filter((t) => t.toLowerCase().startsWith(namespace.toLowerCase() + "/")).map((t) => t.slice(namespace.length + 1)));
      const resourceTypes = [...types].filter((t) => !(b.unknownTypes ?? []).includes(namespace + "/" + t))
        .map((t) => ({ resourceType: t, apiVersions: (b.previewOnlyTypes ?? []).includes(namespace + "/" + t) ? ["2024-01-01-preview"] : ["2024-01-01-preview", "2023-05-01"] }));
      return { status: 200, body: JSON.stringify({ namespace, resourceTypes }) };
    }
    if (/^\/subscriptions\/[^/]+\/(resources|resourcegroups)$/i.test(path) && url.searchParams.has("$filter")) {
      const collection = path.toLowerCase().endsWith("/resources") ? "resources" : "groups";
      const all = (b.tagged ?? []).filter((id) => (typeOf(id) === "Microsoft.Resources/resourceGroups" ? "groups" : "resources") === collection);
      const pages = Math.max(1, b.pages ?? 1);
      const page = Number(url.searchParams.get("$skiptoken") ?? "0");
      const size = Math.ceil(all.length / pages) || 1;
      const value = all.slice(page * size, (page + 1) * size).map((id) => ({ id, name: id.split("/").pop(), type: typeOf(id), tags: { "alz-unit": "x" } }));
      const next = page + 1 < pages ? request.url.replace(/&\$skiptoken=\d+/, "") + "&$skiptoken=" + (page + 1) : undefined;
      return { status: 200, body: JSON.stringify({ value, ...(next ? { nextLink: next } : {}) }) };
    }
    const lower = path.toLowerCase();
    const failing = Object.entries(b.fail ?? {}).find(([id]) => id.toLowerCase() === lower);
    if (failing) return { status: failing[1], body: JSON.stringify({ error: { code: "CANARY_CLOUD_ERROR_c6", message: "CANARY_CLOUD_ERROR_c6" } }) };
    const found = (b.existing ?? []).find((id) => id.toLowerCase() === lower);
    if (found) return { status: 200, body: JSON.stringify({ id: found, name: found.split("/").pop(), type: typeOf(found), properties: { secret: "CANARY_CLOUD_PROPERTY_c5" } }) };
    return { status: 404, body: JSON.stringify({ error: { code: "ResourceNotFound", message: "not found" } }) };
  };
  return { http, calls, behave: (next) => { b = next; calls.length = 0; } };
}

export type Call = {
  args: string[]; cwd: string; env: Record<string, string>; backendConfig?: string; planPath?: string;
  planSha?: string; planMode?: number; backendMode?: number; backendFileExists?: boolean; planText?: string; planDir?: string; pid?: number;
};
export const callsOf = (toolDir: string): Call[] => existsSync(join(toolDir, "calls.jsonl"))
  ? readFileSync(join(toolDir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call)
  : [];
export const signalsOf = (toolDir: string): string[] => existsSync(join(toolDir, "signals.txt"))
  ? readFileSync(join(toolDir, "signals.txt"), "utf8").trim().split("\n") : [];

// --- identities --------------------------------------------------------------------------------

/** The four identities for one environment's tenant and subscription, plus the operator's own ambient credentials (never to reach a child). */
export const identityEnv = (environment: ApplyEnvironment): NodeJS.ProcessEnv => {
  const place = (name: string) => ({
    ["ALZ_" + name + "_ARM_TENANT_ID"]: TENANT, ["ALZ_" + name + "_ARM_SUBSCRIPTION_ID"]: targetOf(environment).account,
  });
  return {
    HOME: "/home/operator", ARM_CLIENT_SECRET: "operator-ambient-secret", AZURE_CLIENT_SECRET: "operator-azure-secret",
    ALZ_DISCOVERY_ARM_CLIENT_ID: "discovery-client-1", ALZ_DISCOVERY_ARM_CLIENT_SECRET: "discovery-secret-aaaa", ...place("DISCOVERY"),
    ALZ_STATE_ARM_CLIENT_ID: "state-client-2", ALZ_STATE_ARM_CLIENT_SECRET: "state-secret-bbbb", ...place("STATE"),
    ALZ_STATE_WRITE_ARM_CLIENT_ID: "statewrite-client-3", ALZ_STATE_WRITE_ARM_CLIENT_SECRET: "statewrite-secret-cccc", ...place("STATE_WRITE"),
    ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: "/run/fixture/statewrite-oidc-token",
    ALZ_APPLY_ARM_CLIENT_ID: "apply-client-4", ALZ_APPLY_ARM_CLIENT_SECRET: "apply-secret-dddd", ...place("APPLY"),
  } as NodeJS.ProcessEnv;
};
export const ENV = identityEnv("DEV");

/** The four AWS identities for one environment (each its own role and token file, no static key), plus the operator's own ambient keys (never to reach a child). */
export const awsIdentityEnv = (environment: ApplyEnvironment): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { HOME: "/home/operator", AWS_ACCESS_KEY_ID: "AKIAFAKEOPERATORKEY00", AWS_SECRET_ACCESS_KEY: "operator-ambient-aws-secret" };
  for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const) {
    env["ALZ_" + identity + "_AWS_ROLE_ARN"] = awsRoleArn(identity, environment);
    env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = "/run/fixture/" + identity.toLowerCase() + "-" + environment.toLowerCase() + "-token";
    env["ALZ_" + identity + "_AWS_REGION"] = AWS_REGION;
  }
  return env;
};

// --- approvers and the pinned contract ----------------------------------------------------------

const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
export const keys = { alice: newKey(), bob: newKey(), carol: newKey(), mallory: newKey() };
export const approvers = [
  { id: "alice", publicKeyPem: keys.alice.pub, environments: ["DEV", "QA", "PROD"] },
  { id: "bob", publicKeyPem: keys.bob.pub, environments: ["DEV", "QA", "PROD"] },
  { id: "carol", publicKeyPem: keys.carol.pub, environments: ["DEV"] },
];

export const contractJson = (killPath: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "AZURE", engine: "TERRAFORM",
  targets: {
    DEV: { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default" },
    QA: { tenantId: TENANT, subscriptionId: QA_TARGET.account, backend: QA_TARGET.backend, workspace: "default" },
    PROD: { tenantId: TENANT, subscriptionId: PROD_TARGET.account, backend: PROD_TARGET.backend, workspace: "default" },
  },
  requiredApprovals: { DEV: 1, QA: 1, PROD: 2 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: killPath, ...over,
});

/** The committed pin the contract is loaded against: its canonical sha256, in `<path>.sha256`. */
export const pinPathOf = (contractPath: string): string => contractPath + ".sha256";
export function writePinnedContract(contractPath: string, contract: unknown): void {
  writeFileSync(contractPath, JSON.stringify(contract));
  writeFileSync(pinPathOf(contractPath), sha(canonicalJson(contract as never)) + "\n");
}

export const awsContractJson = (killPath: string, over: Record<string, unknown> = {}) => ({
  ...contractJson(killPath), provider: "AWS",
  targets: Object.fromEntries((["DEV", "QA", "PROD"] as const).map((e) => [e, { accountId: awsTargetOf(e).account, region: AWS_REGION, backend: awsTargetOf(e).backend, workspace: "default" }])),
  ...over,
});

// --- qualification -------------------------------------------------------------------------------

/** The shape of an apply qualification record. `evidenceHash` is a bare hash unless the caller wrote evidence for it. */
export const applyRecordOf = (over: Partial<QualificationRecord> = {}): QualificationRecord => ({
  engine: "TERRAFORM", adapterVersion: APPLY_ADAPTER.adapterVersion, engineVersion: ENGINE_VERSION, argvDigest: APPLY_ADAPTER.argvDigest,
  qualifiedAt: "2026-10-11T00:00:00.000Z", evidenceHash: H("e"), ...over,
});

const forgedEvidenceForTests = (adapterVersion: string, argvDigest: string, provider: "AZURE" | "AWS") => ({
  schemaVersion: 1 as const, engine: "TERRAFORM" as const, realEngine: true as const, backendIdentitySeparated: true as const,
  ...(provider === "AWS"
    ? { accountId: AWS_DEV_TARGET.account, region: AWS_REGION, backend: AWS_DEV_TARGET.backend, workspace: "default",
      stateWriteClientId: awsRoleArn("STATE_WRITE", "DEV"), applyClientId: awsRoleArn("APPLY", "DEV") }
    : { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default",
      stateWriteClientId: "statewrite-client-3", applyClientId: "apply-client-4" }),
  terraformSha256: sha(FAKE), adapterVersion, argvDigest, engineVersion: ENGINE_VERSION,
  qualifiedAt: "2026-10-11T00:00:00.000Z",
});

/**
 * TEST FIXTURE. FORGES qualification evidence: it attests `realEngine` and `backendIdentitySeparated` without any real
 * engine run or cloud-log check, which `./alz apply qualify` only does after a person's attestation. Production code
 * must never call it; it lives under test/, which nothing in src/ imports.
 * Writes into `vaultDir`, where the driver reads its records from: the apply adapter's, the preview adapter's, or both.
 * A vault holding only one shows the other adapter is not qualified.
 */
export async function testFixtureForgeQualificationEvidence(vaultDir: string, only?: "apply" | "preview", provider: "AZURE" | "AWS" = "AZURE"): Promise<{ applyRecord: QualificationRecord; previewRecord: QualificationRecord }> {
  const write = async (adapterVersion: string, argvDigest: string, skip: boolean): Promise<string> => {
    const evidence = forgedEvidenceForTests(adapterVersion, argvDigest, provider);
    if (skip) return sha(canonicalJson(evidence as never));
    const written = await writeQualificationEvidence(evidence, providerSpec(provider)!, vaultDir);
    if (!written.ok) throw new Error("fixture qualification evidence rejected");
    return written.evidenceHash;
  };
  const applyHash = await write(APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest, only === "preview");
  // The cleanup adapter is qualified with the apply adapter (`./alz apply qualify` records both from the same run).
  await write(CLEANUP_ADAPTER.adapterVersion, CLEANUP_ADAPTER.argvDigest, only === "preview");
  const previewHash = await write(ADAPTER_VERSION, terraformArgvDigest("TERRAFORM"), only === "apply");
  return {
    applyRecord: applyRecordOf({ evidenceHash: applyHash }),
    previewRecord: {
      engine: "TERRAFORM", adapterVersion: ADAPTER_VERSION, engineVersion: ENGINE_VERSION, argvDigest: terraformArgvDigest("TERRAFORM"),
      qualifiedAt: "2026-10-11T00:00:00.000Z", evidenceHash: previewHash,
    },
  };
}

// --- projects and approvals ----------------------------------------------------------------------

export type Project = { projectRoot: string; manifest: ArtifactManifest; resolved: SealRequest["resolved"] };
/** The Azure project's own backend block: Entra ID on, nothing else set (the partial configuration and the identity's `ARM_*` variables fill the rest). */
export const AZURE_BACKEND_TF = 'terraform {\n  backend "azurerm" {\n    use_azuread_auth = true\n  }\n}\n';
/** The default Azure project: the backend block above and one resource. */
export const AZURE_MAIN_TF = AZURE_BACKEND_TF + 'resource "azurerm_resource_group" "pilot" {}\n';
export function writeProject(projectRoot: string, target: ResolvedTarget, mainTf = AZURE_MAIN_TF): Project {
  writeFileSync(join(projectRoot, "main.tf"), mainTf);
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), LOCK);
  const resolved: SealRequest["resolved"] = {
    engineVersion: ENGINE_VERSION, providers: [{ source: "registry.terraform.io/hashicorp/azurerm", version: "4.10.0" }],
    lockFileSha256: sha(LOCK), dependencies: [], inputs: [{ name: "region", identity: H("f") }],
  };
  const manifest = buildManifest({
    engine: "TERRAFORM", mode: "PROJECT", target, unitHash: H("1"), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved,
  });
  return { projectRoot, manifest, resolved };
}

export const human = (target: ResolvedTarget, operatorId = OPERATOR) => ({
  operatorId, interactiveSession: true as const, confirmedTarget: { ...target }, confirmedAt: NOW.toISOString(),
});

export const approvalFor = (sealed: SealedPlan, who: keyof typeof keys, over: Partial<SignedApproval["statement"]> = {}): SignedApproval =>
  signApproval({
    schemaVersion: 1, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target, approverId: who,
    issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
    nonce: randomBytes(16).toString("hex"), ...over,
  }, keys[who].priv);

/** Records an applied artifact the way a run does: reserve it, then replace the reservation with the evidence. A rejected record leaves nothing behind. */
export async function recordApplied(evidence: ApplyEvidence, evidenceDir: string): Promise<ApplyResult> {
  const reserved = await reserveArtifact(evidence.artifactSha256, evidenceDir, NOW);
  if (!reserved.ok) return reserved;
  const written = await finalizeArtifact(evidence, evidenceDir);
  if (!written.ok) await releaseReservation(evidence.artifactSha256, evidenceDir);
  return written;
}
