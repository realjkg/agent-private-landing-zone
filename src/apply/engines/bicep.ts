import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadToolPins } from "../../deps/pins.js";
import { parseArmId } from "../../observe/arm-id.js";
import { copyTree, projectDifference } from "../../teardown/driver/adapters/project-copy.js";
import { removeTree } from "../../teardown/driver/cleanup.js";
import { argvDigest } from "../../teardown/driver/qualification.js";
import type { AdapterDescriptor } from "../../teardown/driver/types.js";
import { canonicalJson } from "../../teardown/manifest.js";
import { readBicepWhatIfTags } from "../../teardown/readers.js";
import { approvedToolDirs, resolveExecutable } from "../../tools/child-env.js";
import { identityVariables } from "../../tools/identity.js";
import { interceptStopSignals, runBoundedProcess, runStoppableProcess, type StoppableResult } from "../../tools/process.js";
import { PROFILES, type ProcessProfile } from "../../tools/profiles.js";
import type { ToolName, ToolResult } from "../../tools/types.js";
import { sha256 } from "../../util/sha256.js";
import { SAFE_VALUE, TOKEN_FILE, stripInvisible } from "../constants.js";
import { assertUsable, checkedOutput, stop, withoutIdentities } from "../engine.js";
import type { ApplyEnd, EngineApplyRun, EngineCleanupRun, EngineContext, EngineRunInput, EngineSpec, StopControl } from "../engine-spec.js";
import type { AzureTarget } from "../providers/azure.js";
import { isRecord } from "../providers/shared.js";
import type { PlanChange, SealedUnit } from "../types.js";
import type { PilotUnit } from "../unit.js";

/**
 * The Azure Bicep / ARM engine spec (docs/act-pilot-bicep.md, path 4 of the narrow ACT-DEV release): one empty, tagged virtual
 * network, compiled from the project's `main.bicep` by the pinned bicep and deployed into the EXISTING pilot resource group (#304)
 * as one resource-group deployment stack with deny settings on. The run never creates, adopts or deletes a resource group, and
 * never registers a provider. Sealing compiles, checks the ARM JSON against the workload's allowlist and runs a deployment
 * what-if as DISCOVERY (the plan of record); the artifact holds the compiled template's exact text. The apply creates the stack
 * from those bytes only, as APPLY. A cleanup deletes the whole stack with `deleteResources`, which leaves the group in place.
 * Codes only: engine output (what-if payloads, stack errors) can quote template values.
 *
 * NOT REGISTERED. `EngineId`, the evidence `mutation` values and the contract's scope for Azure Bicep belong to the authorization
 * lane (src/apply/types.ts, src/apply/contract.ts); until they name BICEP this spec is exported on its own and is not in `SPECS`.
 *
 * Every az argument below was checked against the azure-cli 2.91.0 source (the resource and profile modules, azure-cli-core).
 * What ARM answers is UNVERIFIED (A1 to A4 in the design note): there is no ARM emulator, and no Azure call has been made. The
 * tests use a fake `az` and `bicep`. A comment "UNVERIFIED (n)" marks where an assumption is relied on.
 */

const AZ = "az";
const BICEP_EXE = "bicep";
const PREVIEW_ADAPTER_VERSION = "bicep-preview-1.0.0";
const APPLY_ADAPTER_VERSION = "bicep-apply-1.0.0";
const CLEANUP_ADAPTER_VERSION = "bicep-cleanup-1.0.0";
/** The project's entry file, compiled with no module restore. */
export const BICEP_ENTRY = "main.bicep";
/** The compiled template the what-if and the create read, written outside the work copy (which must equal the manifest). */
const TEMPLATE_NAME = "alz-template.json";

/** The workload's one resource type, and the deny settings every stack of this engine carries. */
export const ALLOWED_RESOURCE_TYPE = "Microsoft.Network/virtualNetworks";
export const DENY_SETTINGS_MODE = "denyWriteAndDelete";
const ACTION_ON_UNMANAGE = "deleteResources";
const UNIT_TAG_KEYS: readonly string[] = ["alz-build", "alz-managed-by", "alz-unit"];

/** A target of this engine: the provider's tenant and subscription, the stack name as `backend`, and the existing pilot resource group. */
export type BicepTarget = AzureTarget & { resourceGroup: string };

// --- the argument lists ---------------------------------------------------------------------------------

type Who = "DISCOVERY" | "APPLY" | null;
type Adapter = "preview" | "apply" | "cleanup";
type Slot = string | { name: string; ok: (value: string) => boolean };
type Shape = readonly Slot[];
const slot = (name: string, ok: (value: string) => boolean): Slot => ({ name, ok });

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A stack or resource group name: letters, digits, `.`, `_`, `-`, up to 90, not ending in `.`. No `@` and no `=`, which az would expand as a file. */
export const AZURE_NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,88}[A-Za-z0-9_-])?$/;
const TEMPLATE_PATH = /^\/[A-Za-z0-9._/-]{1,1024}\/alz-template\.json$/;

const SUB = slot("subscription", (v) => GUID.test(v));
const TENANT = slot("tenant", (v) => GUID.test(v));
const CLIENT = slot("client-id", (v) => SAFE_VALUE.test(v));
/** The only argument that may start with `@`: az reads the federated token from this file (`_expand_file_prefixed_files`), so the token is never in argv. */
const TOKEN_AT = slot("@token-file", (v) => v.startsWith("@") && TOKEN_FILE.test(v.slice(1)) && !v.slice(1).split("/").includes(".."));
const GROUP = slot("resource-group", (v) => AZURE_NAME.test(v));
const STACK = slot("stack", (v) => AZURE_NAME.test(v));
const TEMPLATE = slot("template-file", (v) => TEMPLATE_PATH.test(v) && !v.split("/").includes(".."));
const TAG_VALUE = /^(alz-managed-by|alz-unit|alz-build)=[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TAG = slot("tag", (v) => TAG_VALUE.test(v));

const AZ_VERSION: Shape = ["version", "--output", "json"];
const LOGIN: Shape = ["login", "--service-principal", "--username", CLIENT, "--tenant", TENANT, "--federated-token", TOKEN_AT, "--output", "none"];
const ACCOUNT: Shape = ["account", "show", "--subscription", SUB, "--output", "json"];
const GROUP_SHOW: Shape = ["group", "show", "--name", GROUP, "--subscription", SUB, "--output", "json"];
const WHAT_IF: Shape = [
  "deployment", "group", "what-if", "--resource-group", GROUP, "--template-file", TEMPLATE, "--result-format", "FullResourcePayloads",
  "--validation-level", "ProviderNoRbac", "--no-pretty-print", "--no-prompt", "true", "--subscription", SUB, "--output", "json",
];
const STACK_SHOW: Shape = ["stack", "group", "show", "--name", STACK, "--resource-group", GROUP, "--subscription", SUB, "--output", "json"];
const STACK_CREATE: Shape = [
  "stack", "group", "create", "--name", STACK, "--resource-group", GROUP, "--template-file", TEMPLATE,
  "--deny-settings-mode", DENY_SETTINGS_MODE, "--deny-settings-apply-to-child-scopes", "--action-on-unmanage", ACTION_ON_UNMANAGE,
  "--tags", TAG, TAG, TAG, "--yes", "--no-wait", "--subscription", SUB, "--output", "none",
];
const STACK_DELETE: Shape = [
  "stack", "group", "delete", "--name", STACK, "--resource-group", GROUP, "--action-on-unmanage", ACTION_ON_UNMANAGE, "--yes", "--subscription", SUB, "--output", "none",
];
const BICEP_VERSION: Shape = ["--version"];
const BICEP_BUILD: Shape = ["build", BICEP_ENTRY, "--stdout", "--no-restore"];

type Entry = { exe: typeof AZ | typeof BICEP_EXE; who: Who; shape: Shape; adapters: readonly Adapter[] };
const ALL: readonly Adapter[] = ["preview", "apply", "cleanup"];
/**
 * Everything the engine can run, and as whom. No `provider register`, no `group create` or `group delete`, no parameters, no
 * template URI or template spec, no excluded principal or action, no deny mode but one, no `deleteAll`, no cancel: an argument
 * list that is not one of these, for that identity and adapter, is refused before it reaches the runner.
 */
const ENTRIES: readonly Entry[] = [
  { exe: AZ, who: null, shape: AZ_VERSION, adapters: ALL },
  { exe: BICEP_EXE, who: null, shape: BICEP_VERSION, adapters: ALL },
  { exe: BICEP_EXE, who: null, shape: BICEP_BUILD, adapters: ["preview", "apply"] },
  ...(["DISCOVERY", "APPLY"] as const).flatMap((who): Entry[] => [
    { exe: AZ, who, shape: LOGIN, adapters: ALL },
    { exe: AZ, who, shape: ACCOUNT, adapters: ALL },
    { exe: AZ, who, shape: STACK_SHOW, adapters: ALL },
  ]),
  { exe: AZ, who: "DISCOVERY", shape: GROUP_SHOW, adapters: ["preview", "apply"] },
  // UNVERIFIED (A1): the plan of record, re-run at apply to find a plan its state has outgrown.
  { exe: AZ, who: "DISCOVERY", shape: WHAT_IF, adapters: ["preview", "apply"] },
  { exe: AZ, who: "APPLY", shape: STACK_CREATE, adapters: ["apply"] },
  { exe: AZ, who: "APPLY", shape: STACK_DELETE, adapters: ["cleanup"] },
];

const fits = (shape: Shape, args: readonly string[]): boolean =>
  shape.length === args.length && shape.every((part, index) => (typeof part === "string" ? part === args[index] : part.ok(args[index])));

/** Exact match against the lists above for this executable and identity, and (when an adapter is named) for that adapter's surface alone. */
export function isAllowedBicepArgv(exe: string, who: Who, args: readonly string[], adapter?: Adapter): boolean {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  // `@` outside the token slot would make az read a file into that argument.
  if (args.some((arg, index) => arg.includes("@") && !(index > 0 && args[index - 1] === "--federated-token"))) return false;
  const at = args.indexOf("--tags");
  if (at >= 0 && new Set(args.slice(at + 1, at + 1 + UNIT_TAG_KEYS.length).map((tag) => tag.split("=")[0])).size !== UNIT_TAG_KEYS.length) return false;
  return ENTRIES.some((entry) => entry.exe === exe && entry.who === who && (adapter === undefined || entry.adapters.includes(adapter)) && fits(entry.shape, args));
}

const digestOf = (adapter: Adapter): string => argvDigest(ENTRIES.filter((entry) => entry.adapters.includes(adapter)).map((entry) =>
  [entry.who ?? "NONE", entry.exe, ...entry.shape.map((part) => (typeof part === "string" ? part : "<" + part.name + ">"))]));

// --- running az and bicep -------------------------------------------------------------------------------

const MIB = 1024 * 1024;
/**
 * az as this engine runs it: the child receives exactly one injected variable, `AZURE_CONFIG_DIR` (the identity's private sign-in
 * directory in the run's scratch), and fixed non-secret settings. No `ARM_*`, `AZURE_CLIENT_*` or ambient credential, and no
 * dynamic extension install. Output stays out of diagnostics: what-if payloads quote template values.
 */
export const AZ_STACK_PROFILE: ProcessProfile = {
  ...PROFILES.az,
  injectable: ["AZURE_CONFIG_DIR"],
  fixedEnvironment: { AZURE_CORE_COLLECT_TELEMETRY: "no", AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" },
  timeoutMs: 15 * 60_000,
  maxOutputBytes: 8 * MIB,
  suppressExcerpts: true,
};
/** bicep with no identity and nothing injected; `--no-restore` and the runner's empty home mean no module is fetched. */
const BICEP_PROFILE: ProcessProfile = { ...PROFILES.bicep, injectable: [], maxOutputBytes: 4 * MIB, suppressExcerpts: true };

/** The identity variables this engine reads, in process, never handed to a child. Anything else configured for its identities is refused. */
const IDENTITY_VARIABLES: Readonly<Record<string, RegExp>> = {
  ARM_CLIENT_ID: SAFE_VALUE, ARM_TENANT_ID: GUID, ARM_SUBSCRIPTION_ID: GUID, ARM_USE_OIDC: /^true$/, ARM_OIDC_TOKEN_FILE: TOKEN_FILE,
};
type SignIn = { clientId: string; tenantId: string; tokenFile: string };

/** One identity's configuration, as the Azure Terraform identities carry it, bound to the contract's tenant and subscription. */
function signInOf(env: NodeJS.ProcessEnv, who: "DISCOVERY" | "APPLY", pinned: BicepTarget): SignIn {
  const vars = identityVariables(env, who);
  for (const name of vars.keys()) if (!Object.hasOwn(IDENTITY_VARIABLES, name)) stop("IDENTITY_VARIABLE_REFUSED");
  for (const [name, ok] of Object.entries(IDENTITY_VARIABLES)) if (!ok.test(vars.get(name) ?? "")) stop("IDENTITY_NOT_CONFIGURED");
  if (vars.get("ARM_TENANT_ID")!.toLowerCase() !== pinned.tenantId.toLowerCase() || vars.get("ARM_SUBSCRIPTION_ID")!.toLowerCase() !== pinned.subscriptionId.toLowerCase()) stop("IDENTITY_TARGET_MISMATCH");
  return { clientId: vars.get("ARM_CLIENT_ID")!, tenantId: vars.get("ARM_TENANT_ID")!, tokenFile: vars.get("ARM_OIDC_TOKEN_FILE")! };
}

type Session = {
  work: string;
  templatePath: string;
  run(who: Who, args: readonly string[], exe?: string): ToolResult;
  ok(who: Who, args: readonly string[], exe?: string): string;
  /** Signs both identities in, each to its own private az directory, and checks what az reports against the contract. */
  signIn(): void;
  /** The delete, as a stoppable process: az 2.91.0 offers no `--no-wait` for it. */
  runStoppable(args: readonly string[], control: StopControl): Promise<StoppableResult>;
  assertBound(): void;
  removeSecrets(): void;
};

const TOOL: Readonly<Record<string, ToolName>> = { version: "azure_version", account: "azure_account_show", deployment: "bicep_what_if" };

function openSession(input: Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest" | "pinned">, adapter: Adapter | undefined): Session {
  const pinned = input.pinned as BicepTarget;
  const work = join(input.scratchDir, "work");
  const templateDir = join(input.scratchDir, "template");
  const dirOf = (who: "DISCOVERY" | "APPLY"): string => join(input.scratchDir, "az-" + who.toLowerCase());
  /** The child's environment: the runner's own without any identity, plus the one private directory of the identity it runs as. */
  const envFor = (who: Who): NodeJS.ProcessEnv => ({ ...withoutIdentities(input.env), ...(who === null ? {} : { ["ALZ_" + who + "_AZURE_CONFIG_DIR"]: dirOf(who) }) });
  const options = (exe: string, who: Who) => ({
    profile: exe === BICEP_EXE ? BICEP_PROFILE : AZ_STACK_PROFILE, env: envFor(who), toolDirs: input.toolDirs, identity: who ?? "DISCOVERY", root: input.scratchDir, suppressDetail: true,
  });
  const guard = (exe: string, who: Who, args: readonly string[]): void => { if (!isAllowedBicepArgv(exe, who, args, adapter)) stop("ARGV_NOT_ALLOWED"); };
  const run = (who: Who, args: readonly string[], exe: string = AZ): ToolResult => {
    guard(exe, who, args);
    const tool: ToolName = exe === BICEP_EXE ? (args[0] === "build" ? "bicep_build" : "bicep_version") : (TOOL[args[0]] ?? "azure_deployment_stack");
    return runBoundedProcess(tool, exe, [...args], work, options(exe, who));
  };
  const ok = (who: Who, args: readonly string[], exe?: string): string => checkedOutput(run(who, args, exe));
  return {
    work, templatePath: join(templateDir, TEMPLATE_NAME), run, ok,
    signIn() {
      const clients = new Set<string>();
      for (const who of ["DISCOVERY", "APPLY"] as const) {
        const identity = signInOf(input.env, who, pinned);
        rmSync(dirOf(who), { recursive: true, force: true });
        mkdirSync(dirOf(who), { mode: 0o700 });
        const login = run(who, ["login", "--service-principal", "--username", identity.clientId, "--tenant", identity.tenantId, "--federated-token", "@" + identity.tokenFile, "--output", "none"]);
        assertUsable(login);
        if (!login.ok) stop("LOGIN_FAILED");
        const account = parse(ok(who, ["account", "show", "--subscription", pinned.subscriptionId, "--output", "json"]), "ACCOUNT_UNREADABLE");
        const user = isRecord(account) && isRecord(account.user) ? account.user : stop("ACCOUNT_UNREADABLE");
        if (!isRecord(account) || lower(account.id) !== pinned.subscriptionId.toLowerCase() || lower(account.tenantId) !== pinned.tenantId.toLowerCase() ||
          user.type !== "servicePrincipal" || lower(user.name) !== identity.clientId.toLowerCase()) stop("ACCOUNT_NOT_IN_CONTRACT");
        clients.add(identity.clientId.toLowerCase());
      }
      if (clients.size !== 2) stop("IDENTITY_COLLAPSED");
    },
    runStoppable(args, control) {
      guard(AZ, "APPLY", args);
      return runStoppableProcess("azure_deployment_stack", AZ, [...args], work, { ...options(AZ, "APPLY"), stopWhen: control.stopWhen, pollMs: control.pollMs, graceMs: control.graceMs });
    },
    assertBound() {
      const difference = projectDifference(work, input.manifest);
      if (difference) stop(difference);
    },
    removeSecrets() {
      for (const who of ["DISCOVERY", "APPLY"] as const) rmSync(dirOf(who), { recursive: true, force: true });
      rmSync(templateDir, { recursive: true, force: true });
    },
  };
}

const parse = (text: string, code: string): unknown => { try { return JSON.parse(text); } catch { return stop(code); } };
const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The pinned Bicep (config/tool-pins.json `bicep`), the same the Bicep preview adapter records as tested. */
export const pinnedBicepVersion = (): string => loadToolPins().bicep.version;

/** A writable copy of the snapshot that must equal the manifest, and both pinned versions. Nothing here calls Azure. */
function prepareWork(session: Session, snapshotPath: string, engineVersion: string): void {
  const copyProblem = copyTree(snapshotPath, session.work);
  if (copyProblem) stop(copyProblem);
  session.assertBound();
  const az = /"azure-cli"\s*:\s*"(\d+\.\d+\.\d+)"/.exec(session.ok(null, ["version", "--output", "json"]))?.[1];
  if (az === undefined) stop("VERSION_UNREADABLE");
  if (az !== engineVersion) stop("ENGINE_VERSION_MISMATCH");
  const bicep = /^Bicep CLI version (\d+\.\d+\.\d+)(?:\s|$)/.exec(session.ok(null, ["--version"], BICEP_EXE).trim())?.[1];
  if (bicep === undefined) stop("VERSION_UNREADABLE");
  if (bicep !== pinnedBicepVersion()) stop("BICEP_VERSION_MISMATCH");
}

// --- the template ----------------------------------------------------------------------------------------------

const MAX_TEMPLATE_BYTES = 1 * MIB;

/** Compiles the work copy's `main.bicep` with the pinned bicep and returns the ARM JSON text exactly as bicep printed it. */
function compile(session: Session): string {
  const text = session.ok(null, ["build", BICEP_ENTRY, "--stdout", "--no-restore"], BICEP_EXE);
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) stop("TEMPLATE_TOO_LARGE");
  return text;
}

/**
 * The refusals that keep the template to the minimal workload (UNVERIFIED (A4): Bicep's output shape): a resource-group
 * deployment template whose every resource is a virtual network. No module (a nested deployment), no existing or extension
 * resource, no inline child resource, and no resource group: the run never creates one. Reads text; runs nothing.
 */
export function checkTemplate(text: string): void {
  const template = parse(text, "TEMPLATE_UNREADABLE");
  if (!isRecord(template)) return stop("TEMPLATE_UNREADABLE");
  if (typeof template.$schema !== "string" || !/\/deploymentTemplate\.json#$/.test(template.$schema)) stop("TEMPLATE_SHAPE_NOT_ALLOWED");
  const resources = Array.isArray(template.resources) ? template.resources : isRecord(template.resources) ? Object.values(template.resources) : stop("TEMPLATE_SHAPE_NOT_ALLOWED");
  if (resources.length === 0) stop("NO_CHANGES_TO_APPLY");
  for (const resource of resources) {
    if (!isRecord(resource) || typeof resource.type !== "string") return stop("TEMPLATE_SHAPE_NOT_ALLOWED");
    if (resource.type.toLowerCase() !== ALLOWED_RESOURCE_TYPE.toLowerCase()) stop("RESOURCE_TYPE_NOT_ALLOWED");
    if (resource.existing !== undefined || resource.scope !== undefined || resource.resources !== undefined || resource.copy !== undefined) stop("TEMPLATE_SHAPE_NOT_ALLOWED");
  }
}

// --- what ARM reports ------------------------------------------------------------------------------------------

/** The stack as az prints it (its properties at the top level, as az's own `transform_stacks` reads them). UNVERIFIED (A3): the states. */
type StackView = {
  id: string; state: string; deploymentId: string; lastModified: string; managed: string[]; failed: number;
  denyOk: boolean; tags: Record<string, string>; fingerprint: string;
};
const FINAL_STATES = new Set(["succeeded", "failed", "canceled"]);
const ABSENT_FINGERPRINT = sha256("ABSENT");

/** `undefined` when the stack does not exist (UNVERIFIED (A2): told apart by the error text, which is matched and never carried). */
function readStack(session: Session, who: "DISCOVERY" | "APPLY", pinned: BicepTarget): StackView | undefined {
  const result = session.run(who, ["stack", "group", "show", "--name", pinned.backend, "--resource-group", pinned.resourceGroup, "--subscription", pinned.subscriptionId, "--output", "json"]);
  assertUsable(result);
  if (!result.ok) return result.exitCode !== null && /DeploymentStackNotFound|could not be found|not found/i.test(result.stderr) ? undefined : stop("STACK_UNREADABLE");
  const found = parse(result.stdout, "STACK_UNREADABLE");
  if (!isRecord(found)) return stop("STACK_UNREADABLE");
  const str = (value: unknown): string => (typeof value === "string" ? value : stop("STACK_UNREADABLE"));
  const list = (value: unknown): unknown[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : stop("STACK_UNREADABLE"));
  const deny = isRecord(found.denySettings) ? found.denySettings : {};
  const managed = list(found.resources)
    .map((resource) => (isRecord(resource) && typeof resource.id === "string" ? resource : stop("STACK_UNREADABLE")))
    .filter((resource) => resource.status === undefined || lower(resource.status) === "managed")
    .map((resource) => resource.id as string).sort(byText);
  const tags = isRecord(found.tags) ? Object.fromEntries(Object.entries(found.tags).map(([key, value]) => [key, str(value)])) : {};
  const view = {
    id: str(found.id), state: lower(found.provisioningState), deploymentId: typeof found.deploymentId === "string" ? found.deploymentId : "",
    lastModified: isRecord(found.systemData) && typeof found.systemData.lastModifiedAt === "string" ? found.systemData.lastModifiedAt : "",
    managed, failed: list(found.failedResources).length,
    denyOk: deny.mode === DENY_SETTINGS_MODE && deny.applyToChildScopes === true && list(deny.excludedPrincipals).length === 0 && list(deny.excludedActions).length === 0,
  };
  return { ...view, tags, fingerprint: sha256(canonicalJson({ ...view, managed: managed.map((id) => id.toLowerCase()), deny })) };
}

/** A stack the engine may seal against, update or clean up: settled, protected, and carrying exactly the unit's tag keys. */
function assertStackUsable(view: StackView): void {
  if (!FINAL_STATES.has(view.state)) stop("STACK_STATE_UNSUITABLE");
  if (!view.denyOk) stop("DENY_SETTINGS_OFF");
  if (Object.keys(view.tags).sort().join() !== UNIT_TAG_KEYS.join()) stop("STACK_TAGS_UNKNOWN");
}

/** The ARM id is a virtual network in the contract's subscription and resource group: the only thing this engine changes. */
function inContract(id: string, pinned: BicepTarget): { type: string } {
  const parsed = parseArmId(id);
  if (parsed === undefined || lower(parsed.subscription) !== pinned.subscriptionId.toLowerCase() || lower(parsed.resourceGroup) !== pinned.resourceGroup.toLowerCase()) return stop("WHATIF_NOT_IN_CONTRACT");
  const type = parsed.pairs.length === 1 ? parsed.pairs[0].namespace + "/" + parsed.pairs[0].typePath : "";
  if (type.toLowerCase() !== ALLOWED_RESOURCE_TYPE.toLowerCase()) stop("RESOURCE_TYPE_NOT_ALLOWED");
  return { type: ALLOWED_RESOURCE_TYPE };
}

const ACTIONS: Readonly<Record<string, string | null>> = { Create: "CREATE", Modify: "UPDATE", Deploy: "UPDATE", Delete: "DELETE", NoChange: null, Ignore: null };

/** Whether `tags` carries exactly the unit's values for the three unit keys (other tags are the operator's own and allowed). */
const carriesUnit = (tags: unknown, unit: Readonly<Record<string, string>>): boolean =>
  isRecord(tags) && UNIT_TAG_KEYS.every((key) => tags[key] === unit[key]);

/**
 * The change list: the what-if's changes (UNVERIFIED (A1): its shape), plus a DELETE for each resource the stack manages that the
 * template no longer declares (the stack's `deleteResources` would delete it; the deployment what-if cannot show that). Refuses a
 * type or a place outside the contract, an existing resource the stack would adopt, a created or changed resource without the
 * unit's tags, an unsupported change, and an empty list.
 */
function whatIf(session: Session, pinned: BicepTarget, managed: readonly string[], unit: Readonly<Record<string, string>>): PlanChange[] {
  const document = parse(session.ok("DISCOVERY", [
    "deployment", "group", "what-if", "--resource-group", pinned.resourceGroup, "--template-file", session.templatePath, "--result-format", "FullResourcePayloads",
    "--validation-level", "ProviderNoRbac", "--no-pretty-print", "--no-prompt", "true", "--subscription", pinned.subscriptionId, "--output", "json",
  ]), "WHATIF_UNREADABLE");
  if (!isRecord(document) || !Array.isArray(document.changes)) return stop("WHATIF_UNREADABLE");
  if (document.status !== "Succeeded" || (document.error !== undefined && document.error !== null)) stop("WHATIF_FAILED");
  const ours = new Set(managed.map((id) => id.toLowerCase()));
  const seen = new Set<string>();
  const changes: PlanChange[] = [];
  // The shared reader of the Bicep what-if's planned tags (src/teardown/readers.ts), for every Create.
  const planned = readBicepWhatIfTags(JSON.stringify(document));
  for (const change of document.changes) {
    if (!isRecord(change) || typeof change.resourceId !== "string" || typeof change.changeType !== "string") return stop("WHATIF_UNREADABLE");
    if (!Object.hasOwn(ACTIONS, change.changeType)) stop("WHATIF_UNSUPPORTED_CHANGE");
    const id = stripInvisible(change.resourceId);
    // Ignore lists what is in the group and not in the template: someone else's, or ours being dropped (added below).
    if (change.changeType === "Ignore") continue;
    const { type } = inContract(id, pinned);
    seen.add(id.toLowerCase());
    const action = ACTIONS[change.changeType];
    if (change.changeType !== "Create" && !ours.has(id.toLowerCase())) stop("RESOURCE_PREEXISTS");
    if (change.changeType === "Create") {
      const tags = planned.get(change.resourceId);
      if (tags?.kind !== "TAGGED" || !carriesUnit(tags.tags, unit)) stop("UNIT_TAG_MISSING");
    } else if (action === "UPDATE" && !(isRecord(change.after) && carriesUnit(change.after.tags, unit))) stop("UNIT_TAG_MISSING");
    if (action !== null) changes.push({ address: id, type, action });
  }
  for (const id of managed) {
    if (seen.has(id.toLowerCase())) continue;
    const { type } = inContract(id, pinned);
    changes.push({ address: id, type, action: "DELETE" });
  }
  if (changes.length === 0) stop("NO_CHANGES_TO_APPLY");
  return changes.sort((a, b) => byText(a.address.toLowerCase(), b.address.toLowerCase()));
}

function writeTemplate(session: Session, text: string): void {
  mkdirSync(join(session.templatePath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(session.templatePath, text, { mode: 0o600 });
}

// --- the sealed record -----------------------------------------------------------------------------------------

/** The artifact bytes: the compiled template's exact text and everything the approvers saw, by value or by hash. */
type SealedRecord = {
  schemaVersion: 1; kind: "AZURE_DEPLOYMENT_STACK"; tenantId: string; subscriptionId: string; resourceGroup: string; stackName: string;
  denySettingsMode: typeof DENY_SETTINGS_MODE; actionOnUnmanage: typeof ACTION_ON_UNMANAGE; tags: string[];
  template: string; templateSha256: string; changeListSha256: string; stackSha256: string;
};
const RECORD_KEYS = ["schemaVersion", "kind", "tenantId", "subscriptionId", "resourceGroup", "stackName", "denySettingsMode", "actionOnUnmanage", "tags", "template", "templateSha256", "changeListSha256", "stackSha256"];
const HEX = /^[0-9a-f]{64}$/;

function parseRecord(artifact: Buffer, pinned: BicepTarget): SealedRecord {
  const value = parse(artifact.toString("utf8"), "ARTIFACT_TAMPERED");
  const record = value as SealedRecord;
  if (!isRecord(value) || Object.keys(value).sort().join() !== [...RECORD_KEYS].sort().join() || record.schemaVersion !== 1 || record.kind !== "AZURE_DEPLOYMENT_STACK" ||
    record.tenantId !== pinned.tenantId || record.subscriptionId !== pinned.subscriptionId || record.resourceGroup !== pinned.resourceGroup || record.stackName !== pinned.backend ||
    record.denySettingsMode !== DENY_SETTINGS_MODE || record.actionOnUnmanage !== ACTION_ON_UNMANAGE ||
    !Array.isArray(record.tags) || record.tags.length !== UNIT_TAG_KEYS.length || !record.tags.every((tag) => typeof tag === "string" && TAG_VALUE.test(tag)) || new Set(record.tags.map((tag) => tag.split("=")[0])).size !== UNIT_TAG_KEYS.length ||
    typeof record.template !== "string" || ![record.templateSha256, record.changeListSha256, record.stackSha256].every((h) => typeof h === "string" && HEX.test(h)) ||
    sha256(record.template) !== record.templateSha256) {
    return stop("ARTIFACT_TAMPERED");
  }
  return record;
}

/** The unit's tags as az's `key=value` arguments, in key order; exactly the three unit keys. */
function tagArgsOf(unit: PilotUnit): string[] {
  const keys = Object.keys(unit.tags).sort();
  if (keys.join() !== UNIT_TAG_KEYS.join()) return stop("UNIT_TAGS_INVALID");
  return keys.map((key) => key + "=" + unit.tags[key]);
}
const unitOfTags = (tags: readonly string[]): Record<string, string> => Object.fromEntries(tags.map((tag) => [tag.split("=")[0], tag.slice(tag.indexOf("=") + 1)]));
const targetOf = (pinned: unknown): BicepTarget => {
  const target = pinned as BicepTarget;
  if (!isRecord(pinned) || !GUID.test(String(target.tenantId)) || !GUID.test(String(target.subscriptionId)) || !AZURE_NAME.test(String(target.backend)) || !AZURE_NAME.test(String(target.resourceGroup))) return stop("TARGET_INVALID");
  return target;
};

// --- sealing -----------------------------------------------------------------------------------------------------

/**
 * Compiles, checks the template, requires the existing pilot resource group, reads the stack, and runs the what-if as DISCOVERY.
 * Creates nothing: the deployment what-if persists no object, and nothing runs as APPLY.
 */
function plan(input: EngineContext & { snapshotPath: string; engineVersion: string; unit: PilotUnit }): { artifact: Buffer; changes: PlanChange[]; unit: SealedUnit } {
  const pinned = targetOf(input.pinned);
  const session = openSession(input, "preview");
  try {
    prepareWork(session, input.snapshotPath, input.engineVersion);
    const tags = tagArgsOf(input.unit);
    const template = compile(session);
    checkTemplate(template);
    session.signIn();
    // The group is the bootstrap's (#304): it must exist, and the engine never creates it (UNVERIFIED (A2): the not-found text).
    const group = session.run("DISCOVERY", ["group", "show", "--name", pinned.resourceGroup, "--subscription", pinned.subscriptionId, "--output", "json"]);
    assertUsable(group);
    if (!group.ok) stop(/ResourceGroupNotFound|could not be found/i.test(group.stderr) ? "RESOURCE_GROUP_NOT_FOUND" : "RESOURCE_GROUP_UNREADABLE");
    const stack = readStack(session, "DISCOVERY", pinned);
    if (stack !== undefined) assertStackUsable(stack);
    writeTemplate(session, template);
    const changes = whatIf(session, pinned, stack?.managed ?? [], input.unit.tags);
    const record: SealedRecord = {
      schemaVersion: 1, kind: "AZURE_DEPLOYMENT_STACK", tenantId: pinned.tenantId, subscriptionId: pinned.subscriptionId, resourceGroup: pinned.resourceGroup,
      stackName: pinned.backend, denySettingsMode: DENY_SETTINGS_MODE, actionOnUnmanage: ACTION_ON_UNMANAGE, tags, template, templateSha256: sha256(template),
      changeListSha256: sha256(canonicalJson(changes)), stackSha256: stack?.fingerprint ?? ABSENT_FINGERPRINT,
    };
    // A virtual network takes tags, so nothing created is untagged.
    return { artifact: Buffer.from(canonicalJson(record)), changes, unit: { unitId: input.unit.unitId, tags: { ...input.unit.tags }, untagged: [] } };
  } finally {
    session.removeSecrets();
    removeTree(session.work);
  }
}

/** The qualification run: both versions, both sign-ins, the group and the stack read as each identity. Creates nothing. */
function qualify(input: EngineContext & { snapshotPath: string; engineVersion: string }): void {
  const pinned = targetOf(input.pinned);
  const session = openSession(input, undefined);
  try {
    prepareWork(session, input.snapshotPath, input.engineVersion);
    checkTemplate(compile(session));
    session.signIn();
    checkedOutput(session.run("DISCOVERY", ["group", "show", "--name", pinned.resourceGroup, "--subscription", pinned.subscriptionId, "--output", "json"]));
    for (const who of ["DISCOVERY", "APPLY"] as const) readStack(session, who, pinned);
  } finally {
    session.removeSecrets();
    removeTree(session.work);
  }
}

// --- applying ------------------------------------------------------------------------------------------------------

const APPLY_DEADLINE_MS = 60 * 60_000;
const POLL_MS = 2_000;
const MAX_UNSTARTED_POLLS = 30;
const MAX_UNREADABLE_POLLS = 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const outcomeResult = (over: Partial<StoppableResult>): StoppableResult => ({ tool: "azure_deployment_stack", ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, stopped: false, ...over });

/** The stack as last read: a view, known absent, or unreadable. */
type Seen = StackView | "ABSENT" | undefined;
type Ran = { exit: number | null; seen: Seen; stopped: boolean };
const fingerprintOf = (seen: Seen): string | undefined => (seen === "ABSENT" ? ABSENT_FINGERPRINT : seen?.fingerprint);
const movedFrom = (before: Seen, seen: Seen): boolean =>
  seen !== undefined && seen !== "ABSENT" && (before === "ABSENT" || (before !== undefined && (seen.deploymentId !== before.deploymentId || seen.lastModified !== before.lastModified)));
const look = (session: Session, who: "DISCOVERY" | "APPLY", pinned: BicepTarget): Seen => { try { return readStack(session, who, pinned) ?? "ABSENT"; } catch { return undefined; } };

/** What the engine adds to an apply run: the stack's managed resources, read once as DISCOVERY after the run (the ownership record). */
export type BicepApplyRun = EngineApplyRun & { managedResources(): string[] | undefined };

function openApply(input: EngineRunInput): BicepApplyRun {
  const pinned = targetOf(input.pinned);
  const session = openSession(input, "apply");
  let before: Seen;
  let sealed: SealedRecord | undefined;
  let ran: Ran = { exit: null, seen: undefined, stopped: false };
  const stackNow = (): Seen => readStack(session, "APPLY", pinned) ?? "ABSENT";
  return {
    prepare(snapshotPath) {
      prepareWork(session, snapshotPath, input.engineVersion);
      session.signIn();
      before = stackNow();
    },
    rederive(artifact) {
      if (before === undefined) return stop("ENGINE_NOT_PREPARED");
      const record = parseRecord(artifact, pinned);
      // The project, compiled again by the pinned bicep, is exactly the sealed template: any change after the seal is refused.
      if (compile(session) !== record.template) stop("ARTIFACT_TAMPERED");
      checkTemplate(record.template);
      if (before !== "ABSENT") assertStackUsable(before);
      // The stack is as it was when the plan was sealed; a stack an earlier apply moved (this artifact's own, too) is refused here.
      if (fingerprintOf(before) !== record.stackSha256) stop("PLAN_STALE");
      writeTemplate(session, record.template);
      const changes = whatIf(session, pinned, before === "ABSENT" ? [] : before.managed, unitOfTags(record.tags));
      if (sha256(canonicalJson(changes)) !== record.changeListSha256) stop("PLAN_STALE");
      sealed = record;
      return changes;
    },
    async execute(artifact, control) {
      const record = parseRecord(artifact, pinned);
      if (control.stopWhen()) return outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the stack create started." });
      if (sealed === undefined) return stop("ENGINE_NOT_PREPARED");
      if (canonicalJson(record) !== canonicalJson(sealed)) stop("ARTIFACT_TAMPERED");
      // Read again after the approvals were consumed: still the stack the plan was made against.
      const now = stackNow();
      if (fingerprintOf(now) !== sealed.stackSha256) stop("PLAN_STALE");
      writeTemplate(session, record.template);
      if (sha256(readFileSync(session.templatePath, "utf8")) !== record.templateSha256) stop("ARTIFACT_TAMPERED");
      before = now;
      // From the create call on nothing throws: Azure may have accepted the stack.
      ran = { exit: null, seen: undefined, stopped: false };
      let signalled = false;
      const release = interceptStopSignals(() => { signalled = true; });
      try {
        ran.exit = session.run("APPLY", [
          "stack", "group", "create", "--name", pinned.backend, "--resource-group", pinned.resourceGroup, "--template-file", session.templatePath,
          "--deny-settings-mode", DENY_SETTINGS_MODE, "--deny-settings-apply-to-child-scopes", "--action-on-unmanage", ACTION_ON_UNMANAGE,
          "--tags", ...record.tags, "--yes", "--no-wait", "--subscription", pinned.subscriptionId, "--output", "none",
        ]).exitCode;
        const deadline = Date.now() + APPLY_DEADLINE_MS;
        let unreadable = 0;
        let unstarted = 0;
        for (;;) {
          const seen = look(session, "APPLY", pinned);
          ran.seen = seen ?? ran.seen;
          if (seen === undefined) {
            if (++unreadable >= MAX_UNREADABLE_POLLS) { ran.seen = undefined; break; }
          } else {
            unreadable = 0;
            if (!movedFrom(before, seen)) {
              if (ran.exit !== 0 || ++unstarted > MAX_UNSTARTED_POLLS) break;
            } else if (FINAL_STATES.has((seen as StackView).state)) break;
          }
          // UNVERIFIED (A3): no cancel is in the allowlist, so a stop ends the watch and the create runs on in Azure.
          if (signalled || control.stopWhen() || Date.now() > deadline) { ran.stopped = true; break; }
          await sleep(control.pollMs ?? POLL_MS);
        }
      } catch {
        // Whatever the stack shows now is what `settle` judges.
      } finally {
        release();
        session.removeSecrets();
      }
      return outcomeResult({ ok: ran.exit === 0, exitCode: ran.exit, stopped: ran.stopped });
    },
    settle(): ApplyEnd {
      if (sealed === undefined || before === undefined) return stop("ENGINE_NOT_PREPARED");
      const seen = ran.seen;
      if (ran.exit === 0 && movedFrom(before, seen) && seen !== undefined && seen !== "ABSENT" && seen.state === "succeeded" && seen.failed === 0 && seen.denyOk) return { outcome: "SUCCEEDED" };
      if (ran.stopped) return { outcome: "KILLED" };
      if (ran.exit !== 0 && seen !== undefined && !movedFrom(before, seen)) return { outcome: "FAILED_NO_CHANGE" };
      return { outcome: "PARTIAL_REQUIRES_REVIEW" };
    },
    recoveryFiles: () => [],
    removeSecrets: () => session.removeSecrets(),
    managedResources() {
      try {
        session.signIn();
        const view = readStack(session, "DISCOVERY", pinned);
        return view?.managed;
      } catch { return undefined; } finally { session.removeSecrets(); }
    },
  };
}

// --- the cleanup: the whole stack, never the group -------------------------------------------------------------------

const MAX_CLEANUP_ADDRESSES = 200;

/**
 * Deletes the run's stack with `deleteResources`: the managed resources are deleted and resource groups are detached
 * (`_prepare_stacks_action_on_unmanage`, az 2.91.0), so the pilot group is never deleted. Whole-stack only: the approved
 * addresses must be exactly the stack's managed resources, each a virtual network in the contract's group.
 */
function openCleanup(input: EngineRunInput): EngineCleanupRun {
  const pinned = targetOf(input.pinned);
  const session = openSession(input, "cleanup");
  let before: StackView | undefined;
  let planned = false;
  return {
    prepare(snapshotPath) {
      prepareWork(session, snapshotPath, input.engineVersion);
      session.signIn();
      const stack = readStack(session, "APPLY", pinned) ?? stop("CLEANUP_STACK_NOT_FOUND");
      assertStackUsable(stack);
      if (stack.managed.length === 0) stop("CLEANUP_NO_CHANGES");
      for (const id of stack.managed) inContract(id, pinned);
      before = stack;
    },
    planDestroy(addresses) {
      if (before === undefined) return stop("ENGINE_NOT_PREPARED");
      const wanted = addresses.map((address) => address.toLowerCase());
      const managed = before.managed.map((id) => id.toLowerCase());
      if (addresses.length === 0 || addresses.length > MAX_CLEANUP_ADDRESSES || new Set(wanted).size !== wanted.length) stop("CLEANUP_ADDRESSES_INVALID");
      if (wanted.length !== managed.length || !wanted.every((id) => managed.includes(id))) stop("CLEANUP_PARTIAL_UNSUPPORTED");
      planned = true;
      return before.managed.map((id) => ({ address: id, type: inContract(id, pinned).type, action: "DELETE" }));
    },
    async execute(control) {
      if (before === undefined || !planned) return stop("ENGINE_NOT_PREPARED");
      if (control.stopWhen()) return outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the stack delete started." });
      const now = readStack(session, "APPLY", pinned);
      if (now === undefined || now.fingerprint !== before.fingerprint) stop("PLAN_STALE");
      // The sign-ins stay until `settle` has read the stack once more; they go with removeSecrets.
      return session.runStoppable([
        "stack", "group", "delete", "--name", pinned.backend, "--resource-group", pinned.resourceGroup, "--action-on-unmanage", ACTION_ON_UNMANAGE,
        "--yes", "--subscription", pinned.subscriptionId, "--output", "none",
      ], control);
    },
    settle(applied) {
      if (before === undefined) return stop("ENGINE_NOT_PREPARED");
      const seen = look(session, "APPLY", pinned);
      session.removeSecrets();
      if (applied.exitCode === 0 && !applied.stopped && seen === "ABSENT") return { outcome: "SUCCEEDED" };
      if (applied.stopped) return { outcome: "KILLED" };
      if (applied.exitCode !== 0 && seen !== undefined && seen !== "ABSENT" && seen.fingerprint === before.fingerprint) return { outcome: "FAILED_NO_CHANGE" };
      return { outcome: "PARTIAL_REQUIRES_REVIEW" };
    },
    recoveryFiles: () => [],
    removeSecrets: () => session.removeSecrets(),
  };
}

// --- the spec ----------------------------------------------------------------------------------------------------------

const adapter = (kind: Adapter): AdapterDescriptor => ({
  engine: "BICEP", adapterVersion: kind === "preview" ? PREVIEW_ADAPTER_VERSION : kind === "apply" ? APPLY_ADAPTER_VERSION : CLEANUP_ADAPTER_VERSION, argvDigest: digestOf(kind),
});

/**
 * The spec's own type until the authorization lane admits the engine id: `EngineSpec` with the id and the two evidence `mutation`
 * values this engine will add (src/apply/types.ts), and an apply run that also reads the stack's managed resources.
 */
export type BicepEngineSpec = Omit<EngineSpec, "id" | "mutation" | "cleanupMutation" | "openApply"> & {
  id: "BICEP";
  mutation: "AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE";
  cleanupMutation: "AZURE_DEPLOYMENT_STACK_DELETE_OF_RUN_STACK";
  openApply(input: EngineRunInput): BicepApplyRun;
};

export const BICEP: BicepEngineSpec = {
  id: "BICEP",
  executables: [AZ, BICEP_EXE],
  mutation: "AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE",
  providers: ["AZURE"],
  target: {
    backendOk: (value) => AZURE_NAME.test(value),
    workspaceOk: (value) => value === "default",
    // The same stack name in each subscription is the usual case; the subscription already differs.
    backendMayRepeat: true,
    fields: { resourceGroup: (value) => typeof value === "string" && AZURE_NAME.test(value) },
  },
  notices: {
    sealHeading: "SEAL A DEPLOYMENT STACK PLAN (this compiles main.bicep and runs a what-if; nothing is created, changed or deleted)",
    sealReads: "  reads           the resource group, the stack and the what-if with the DISCOVERY identity",
    qualifyHeading: "QUALIFY THE BICEP ADAPTERS (needs the real az and bicep; against DEV it signs both identities in and reads the group and the stack, and creates nothing)",
    qualifyReads: "  runs            az account show, az group show and az stack group show as DISCOVERY and APPLY",
    attestation: (_provider, discovery, apply) => [
      "  what-if and reads were by     DISCOVERY  " + discovery,
      "  stack create and delete by    APPLY      " + apply,
      "This run only read. That DISCOVERY cannot write and APPLY reaches only the pilot resource group is shown by the role assignments and the Azure activity log, not by this run.",
      "Only if they show that, type (anything else writes nothing):",
    ],
    applyNote: "It creates or updates exactly one deployment stack from the sealed template, with deny settings on, as APPLY. It never creates or deletes a resource group.",
    cleanupNote: "It deletes the whole deployment stack with deleteResources, as APPLY: the stack's managed resources are deleted, and the pilot resource group is left in place.",
  },
  manifestMode: "PROJECT",
  identities: ["DISCOVERY", "APPLY"],
  attests: ["DISCOVERY", "APPLY"],
  previewAdapter: () => adapter("preview"),
  applyAdapter: adapter("apply"),
  cleanupAdapter: adapter("cleanup"),
  cleanupMutation: "AZURE_DEPLOYMENT_STACK_DELETE_OF_RUN_STACK",
  openCleanup,
  /** SHA-256 of the az program a run would execute, looked up in the approved tool directories only. */
  binarySha256(toolDirs, env) {
    const path = resolveExecutable(AZ, toolDirs ?? approvedToolDirs(env));
    try { return path ? sha256(readFileSync(path)) : undefined; } catch { return undefined; }
  },
  plan,
  qualify,
  openApply,
  outcomeMessages: {
    FAILED_NO_CHANGE: "The stack create was refused and the stack did not change. Engine output is withheld because it can quote template values. This sealed plan and its approvals are spent: seal a new plan and obtain new approvals to try again.",
    PARTIAL_REQUIRES_REVIEW: "The stack create failed after it started, or its result cannot be told: a lost response, an unreadable stack, a failed or canceled stack, failed resources, or deny settings that are not the sealed ones. Do not retry. A person must review the stack and its resources in the pilot resource group by hand before any new plan. This sealed plan and its approvals are spent.",
    KILLED: "The apply was told to stop while it ran (the kill switch appeared, the 60 minute time limit passed, or this command received SIGINT, SIGTERM, SIGHUP or SIGQUIT). The engine has no cancel: Azure may still finish the stack. Do not retry. A person must review the stack by hand before any new plan. This sealed plan and its approvals are spent.",
  },
  recoveryLostNote: "",
  recoveryFileNames: [],
};
