import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { copyTree, projectDifference } from "../../teardown/driver/adapters/project-copy.js";
import { argvDigest } from "../../teardown/driver/qualification.js";
import { removeTree } from "../../teardown/driver/cleanup.js";
import type { AdapterDescriptor } from "../../teardown/driver/types.js";
import { canonicalJson } from "../../teardown/manifest.js";
import { approvedToolDirs, resolveExecutable } from "../../tools/child-env.js";
import { ANY_IDENTITY_VARIABLE, type ExecutionIdentity } from "../../tools/identity.js";
import { interceptStopSignals, refusedVariables, runBoundedProcess, type StoppableResult } from "../../tools/process.js";
import { AWS_CFN_APPLY_PROFILE } from "../../tools/profiles.js";
import type { ToolResult } from "../../tools/types.js";
import { sha256 } from "../../util/sha256.js";
import { stripInvisible } from "../constants.js";
import { stop } from "../engine.js";
import type { ApplyEnd, EngineApplyRun, EngineContext, EngineRunInput, EngineSpec } from "../engine-spec.js";
import type { AwsTarget } from "../providers/aws.js";
import { isRecord } from "../providers/shared.js";
import type { PlanChange } from "../types.js";

/**
 * The CDK engine spec (docs/act-pilot-apply.md, "CDK"): a pre-synthesized CDK cloud assembly (cdk.out) with one stack
 * and no assets, applied through one CloudFormation change set and nothing else. The pilot never runs `cdk synth`, the
 * CDK CLI, npm, npx or any app code; it reads the assembly's files and calls the AWS CLI with the argument lists below.
 * Sealing creates the change set and does NOT execute it; the apply executes exactly that change set. Codes only: engine
 * output (descriptions, stack events, errors) can quote template and parameter values.
 *
 * UNVERIFIED: every AWS, CloudFormation and CDK fact in this file is from memory. The AWS documentation hosts were
 * unreachable when it was written, and no real AWS CLI or CloudFormation ran any of it (the tests use a fake `aws`).
 * Each assumption is marked below and listed in docs/act-pilot-apply.md. A wrong assumption fails closed unless noted;
 * each is checked against AWS's documentation and a real DEV run before live use. In short:
 *  - the AWS CLI v2 subcommands and flags used (create-change-set, `wait change-set-create-complete`, describe-change-set,
 *    execute-change-set, describe-stacks, describe-stack-events, cancel-update-stack, --no-cli-pager, `file://` template
 *    bodies), the web identity credentials the CLI reads from AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE, and `aws --version`;
 *  - the JSON they print (Id, StackId, Status, ExecutionStatus, Capabilities, Parameters, Changes[].ResourceChange.{Action,
 *    LogicalResourceId,ResourceType,Replacement}, Stacks[].{StackId,StackStatus,EnableTerminationProtection,LastUpdatedTime,
 *    CreationTime}, StackEvents[].{ResourceType,Timestamp}) and the stack and change set statuses named below. The brief
 *    called the executable state EXECUTE_AVAILABLE; this reads ExecutionStatus AVAILABLE;
 *  - that a stack with no earlier create is told apart by "does not exist" in the error text, that a CREATE change set
 *    leaves the stack in REVIEW_IN_PROGRESS, that a change set becomes OBSOLETE or UNAVAILABLE when the stack changed
 *    after it was made, that CreateChangeSet cannot set termination protection (a person does, after the first create),
 *    and that cancel-update-stack is valid only while the stack is UPDATE_IN_PROGRESS;
 *  - the 51,200 byte limit on an inline template body, the cloud assembly layout (manifest.json artifacts of type
 *    aws:cloudformation:stack, cdk:asset-manifest, cdk:tree and cdk:feature-flag-report, their `properties`
 *    templateFile, stackName, terminationProtection, file, and environment `aws://<account>/<region>`), and that the default
 *    synthesizer lists the stack's own template as the only file asset of a stack without assets.
 */

const EXECUTABLE = "aws";
const PREVIEW_ADAPTER_VERSION = "cdk-preview-1.0.0";
const APPLY_ADAPTER_VERSION = "cdk-apply-1.0.0";

// --- the argument lists ---------------------------------------------------------------------------------

type Who = ExecutionIdentity | null;
type Slot = string | { name: string; ok: (value: string) => boolean };
type Shape = readonly Slot[];

const slot = (name: string, ok: (value: string) => boolean): Slot => ({ name, ok });
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const REL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const climbs = (path: string): boolean => path.split("/").some((part) => part === "." || part === "..");
const CAPABILITIES = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"] as const;

const STACK = slot("stack", (v) => STACK_NAME.test(v));
const REGION_SLOT = slot("region", (v) => REGION.test(v));
const CHANGE_SET_NAME = slot("change-set-name", (v) => /^alz-[0-9a-f]{12}$/.test(v));
const CHANGE_SET_ARN = slot("change-set-arn", (v) => /^arn:aws:cloudformation:[a-z0-9-]+:[0-9]{12}:changeSet\/alz-[0-9a-f]{12}\/[0-9a-f-]{36}$/.test(v));
const CHANGE_SET_TYPE = slot("type", (v) => v === "CREATE" || v === "UPDATE");
const TEMPLATE = slot("template", (v) => v.startsWith("file://") && REL_PATH.test(v.slice(7)) && !climbs(v.slice(7)));
const CAPABILITY = slot("capability", (v) => (CAPABILITIES as readonly string[]).includes(v));
const JSON_OUTPUT: Shape = ["--region", REGION_SLOT, "--output", "json", "--no-cli-pager"];
const NO_OUTPUT: Shape = ["--region", REGION_SLOT, "--no-cli-pager"];

const VERSION_SHAPE: Shape = ["--version"];
const DESCRIBE_STACKS: Shape = ["cloudformation", "describe-stacks", "--stack-name", STACK, ...JSON_OUTPUT];
const createShape = (capabilities: number): Shape => [
  "cloudformation", "create-change-set", "--stack-name", STACK, "--change-set-name", CHANGE_SET_NAME, "--change-set-type", CHANGE_SET_TYPE,
  "--template-body", TEMPLATE, ...(capabilities > 0 ? ["--capabilities", ...Array<Slot>(capabilities).fill(CAPABILITY)] : []), ...JSON_OUTPUT,
];
const WAIT: Shape = ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", CHANGE_SET_ARN, ...NO_OUTPUT];
const DESCRIBE_CHANGE_SET: Shape = ["cloudformation", "describe-change-set", "--change-set-name", CHANGE_SET_ARN, ...JSON_OUTPUT];
const EXECUTE: Shape = ["cloudformation", "execute-change-set", "--change-set-name", CHANGE_SET_ARN, ...NO_OUTPUT];
const DESCRIBE_EVENTS: Shape = ["cloudformation", "describe-stack-events", "--stack-name", STACK, ...JSON_OUTPUT];
const CANCEL: Shape = ["cloudformation", "cancel-update-stack", "--stack-name", STACK, ...NO_OUTPUT];

type Entry = { who: Who; shape: Shape; adapters: readonly ("preview" | "apply")[] };
/**
 * Everything the engine can run, and as whom. There is no delete (a stack or a change set), no create-stack, update-stack
 * or deploy, no way to name a parameter, a tag, a role or a rollback setting, and nothing for CHANGESET to execute with:
 * an argument list that is not one of these, for that identity, is refused before it reaches the runner.
 */
const ENTRIES: readonly Entry[] = [
  { who: null, shape: VERSION_SHAPE, adapters: ["preview", "apply"] },
  { who: "DISCOVERY", shape: DESCRIBE_STACKS, adapters: ["preview"] },
  // Qualification reads the stack as each identity; a change set creator that cannot describe a stack fails it.
  { who: "CHANGESET", shape: DESCRIBE_STACKS, adapters: ["preview", "apply"] },
  ...[0, 1, 2, 3].map((n): Entry => ({ who: "CHANGESET", shape: createShape(n), adapters: ["preview"] })),
  { who: "CHANGESET", shape: WAIT, adapters: ["preview"] },
  { who: "CHANGESET", shape: DESCRIBE_CHANGE_SET, adapters: ["preview", "apply"] },
  { who: "APPLY", shape: DESCRIBE_STACKS, adapters: ["apply"] },
  { who: "APPLY", shape: EXECUTE, adapters: ["apply"] },
  { who: "APPLY", shape: DESCRIBE_EVENTS, adapters: ["apply"] },
  { who: "APPLY", shape: CANCEL, adapters: ["apply"] },
];

const fits = (shape: Shape, args: readonly string[]): boolean =>
  shape.length === args.length && shape.every((part, index) => (typeof part === "string" ? part === args[index] : part.ok(args[index])));

/** Exact match against the lists above for this identity. */
export function isAllowedCdkArgv(who: Who, args: readonly string[]): boolean {
  return Array.isArray(args) && args.every((arg) => typeof arg === "string") && ENTRIES.some((entry) => entry.who === who && fits(entry.shape, args));
}

const digestOf = (adapter: "preview" | "apply"): string => argvDigest(ENTRIES.filter((entry) => entry.adapters.includes(adapter)).map((entry) =>
  [entry.who ?? "NONE", EXECUTABLE, ...entry.shape.map((part) => (typeof part === "string" ? part : "<" + part.name + ">"))]));

const describeStacksArgv = (stack: string, region: string): string[] => ["cloudformation", "describe-stacks", "--stack-name", stack, "--region", region, "--output", "json", "--no-cli-pager"];
const createArgv = (c: { stack: string; name: string; type: string; template: string; capabilities: readonly string[]; region: string }): string[] => [
  "cloudformation", "create-change-set", "--stack-name", c.stack, "--change-set-name", c.name, "--change-set-type", c.type, "--template-body", "file://" + c.template,
  ...(c.capabilities.length > 0 ? ["--capabilities", ...c.capabilities] : []), "--region", c.region, "--output", "json", "--no-cli-pager",
];
const waitArgv = (arn: string, region: string): string[] => ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", arn, "--region", region, "--no-cli-pager"];
const describeChangeSetArgv = (arn: string, region: string): string[] => ["cloudformation", "describe-change-set", "--change-set-name", arn, "--region", region, "--output", "json", "--no-cli-pager"];
const executeArgv = (arn: string, region: string): string[] => ["cloudformation", "execute-change-set", "--change-set-name", arn, "--region", region, "--no-cli-pager"];
const eventsArgv = (stack: string, region: string): string[] => ["cloudformation", "describe-stack-events", "--stack-name", stack, "--region", region, "--output", "json", "--no-cli-pager"];
const cancelArgv = (stack: string, region: string): string[] => ["cloudformation", "cancel-update-stack", "--stack-name", stack, "--region", region, "--no-cli-pager"];

// --- running the AWS CLI -------------------------------------------------------------------------------

/** A step that needs no credentials is given none. */
const withoutIdentities = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !ANY_IDENTITY_VARIABLE.test(key)));
/** Sealing never has the applier in the runner's environment at all. */
const APPLIER = /^ALZ_APPLY_/;

type Session = {
  work: string;
  /** Runs one allowlisted list as `who` and returns the result as the runner reports it. A list that is not the identity's own is a code. */
  run(who: Who, args: readonly string[]): ToolResult;
  /** The same, and stdout; any refusal, truncation or non-zero exit stops with a code. */
  ok(who: Who, args: readonly string[]): string;
  refused(who: ExecutionIdentity): string[];
  assertBound(): void;
};

type SessionInput = Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest"> & { hide?: RegExp };

function openSession(input: SessionInput): Session {
  const work = join(input.scratchDir, "work");
  const visible = (): NodeJS.ProcessEnv => (input.hide === undefined ? input.env : Object.fromEntries(Object.entries(input.env).filter(([key]) => !input.hide!.test(key))));
  const options = (who: Who) => ({
    profile: AWS_CFN_APPLY_PROFILE, env: who === null ? withoutIdentities(input.env) : visible(), toolDirs: input.toolDirs,
    identity: who ?? "DISCOVERY", root: input.scratchDir, suppressDetail: true,
  });
  const run = (who: Who, args: readonly string[]): ToolResult => {
    if (!isAllowedCdkArgv(who, args)) stop("ARGV_NOT_ALLOWED");
    return runBoundedProcess("aws_cloudformation", EXECUTABLE, [...args], work, options(who));
  };
  const unusable = (result: ToolResult): void => {
    // A credential the runner refused (a newline, an unapproved host) would otherwise mean a run with no identity.
    if (result.refusedEnvironment?.length) stop("ENVIRONMENT_REFUSED");
    if (result.truncated) stop("OUTPUT_TRUNCATED");
  };
  return {
    work, run,
    ok(who, args) {
      const result = run(who, args);
      unusable(result);
      if (!result.ok) stop(result.exitCode === null ? "NOT_RUN" : "EXIT_" + result.exitCode);
      return result.stdout;
    },
    refused: (who) => refusedVariables(options(who)),
    assertBound() {
      const difference = projectDifference(work, input.manifest);
      if (difference) stop(difference);
    },
  };
}

const parse = (text: string, code: string): unknown => { try { return JSON.parse(text); } catch { return stop(code); } };
const str = (value: unknown, code: string): string => typeof value === "string" && value !== "" ? value : stop(code);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A writable copy of the snapshot that must equal the manifest, and the pinned CLI version. Nothing here calls AWS except `--version`. */
function prepareWork(session: Session, snapshotPath: string, engineVersion: string): void {
  const copyProblem = copyTree(snapshotPath, session.work);
  if (copyProblem) stop(copyProblem);
  session.assertBound();
  const reported = /^aws-cli\/([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(session.ok(null, ["--version"]).trim())?.[1];
  if (reported === undefined) stop("VERSION_UNREADABLE");
  if (reported !== engineVersion) stop("ENGINE_VERSION_MISMATCH");
}

// --- the cloud assembly -----------------------------------------------------------------------------------

/** The most CloudFormation takes as an inline template body. Larger templates are uploaded as assets, which the pilot does not publish. */
const MAX_TEMPLATE_BYTES = 51_200;
const MAX_JSON_BYTES = 1_048_576;
/** Artifact types an assembly of one stack and no assets holds. Anything else (a nested assembly, a second kind of stack) is refused. */
const PLAIN_ARTIFACTS: readonly string[] = ["cdk:asset-manifest", "cdk:tree", "cdk:feature-flag-report"];

type Assembly = { stackName: string; templateFile: string; templateSha256: string };

function readFileIn(work: string, relative: unknown, max: number, code: string): Buffer {
  if (typeof relative !== "string" || !REL_PATH.test(relative) || climbs(relative)) return stop(code);
  let found: { size: number; bytes?: Buffer } | undefined;
  try {
    const path = join(work, relative);
    const info = lstatSync(path);
    found = info.isFile() ? { size: info.size, bytes: info.size <= max ? readFileSync(path) : undefined } : undefined;
  } catch { found = undefined; }
  if (found === undefined) return stop(code);
  return found.bytes ?? stop(code === "TEMPLATE_UNREADABLE" ? "TEMPLATE_TOO_LARGE" : code);
}

function walkTemplate(value: unknown): void {
  if (Array.isArray(value)) value.forEach(walkTemplate);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "Fn::ImportValue") stop("ASSEMBLY_CROSS_STACK_IMPORT");
      walkTemplate(child);
    }
  }
}

/**
 * The refusals that keep the pilot's input to what it can apply exactly: one stack, no asset to publish (the stack's own
 * template is the one file asset it lists, and it is sent inline), no nested stack or cross-stack import, the contract's
 * stack name, account and region (an assembly synthesized for any account and region names none), and termination
 * protection declared on. Reads the work copy's files; never runs anything.
 */
function readAssembly(work: string, pinned: AwsTarget): Assembly {
  const manifest = parse(readFileIn(work, "manifest.json", MAX_JSON_BYTES, "ASSEMBLY_UNREADABLE").toString("utf8"), "ASSEMBLY_UNREADABLE");
  const artifacts = isRecord(manifest) && isRecord(manifest.artifacts) ? manifest.artifacts : stop("ASSEMBLY_UNREADABLE");
  const entries = Object.entries(artifacts).map(([id, artifact]) => (isRecord(artifact) ? { id, type: artifact.type, artifact } : stop("ASSEMBLY_UNREADABLE")));
  const stacks = entries.filter((entry) => entry.type === "aws:cloudformation:stack");
  if (stacks.length !== 1) stop("ASSEMBLY_STACK_COUNT");
  if (entries.some((entry) => entry.type !== "aws:cloudformation:stack" && !PLAIN_ARTIFACTS.includes(String(entry.type)))) stop("ASSEMBLY_ARTIFACT_UNSUPPORTED");
  const { id, artifact } = stacks[0];
  const properties = isRecord(artifact.properties) ? artifact.properties : stop("ASSEMBLY_UNREADABLE");
  const stackName = properties.stackName === undefined ? id : str(properties.stackName, "ASSEMBLY_UNREADABLE");
  const templateFile = str(properties.templateFile, "ASSEMBLY_UNREADABLE");
  if (!STACK_NAME.test(stackName)) stop("ASSEMBLY_UNREADABLE");

  const dependencies = artifact.dependencies === undefined ? [] : Array.isArray(artifact.dependencies) ? artifact.dependencies : stop("ASSEMBLY_UNREADABLE");
  if (dependencies.some((dependency) => !entries.some((entry) => entry.id === dependency && PLAIN_ARTIFACTS.includes(String(entry.type))))) stop("ASSEMBLY_DEPENDENCY");
  for (const entry of entries.filter((e) => e.type === "cdk:asset-manifest")) {
    const assets = parse(readFileIn(work, isRecord(entry.artifact.properties) ? entry.artifact.properties.file : undefined, MAX_JSON_BYTES, "ASSEMBLY_UNREADABLE").toString("utf8"), "ASSEMBLY_UNREADABLE");
    const files = isRecord(assets) && isRecord(assets.files) ? Object.values(assets.files) : [];
    const docker = isRecord(assets) && isRecord(assets.dockerImages) ? Object.keys(assets.dockerImages) : [];
    if (docker.length > 0 || files.some((file) => !isRecord(file) || !isRecord(file.source) || file.source.path !== templateFile ||
      (file.source.packaging !== undefined && file.source.packaging !== "file") || file.source.executable !== undefined)) stop("ASSEMBLY_NEEDS_ASSETS");
  }

  const place = typeof artifact.environment === "string" ? /^aws:\/\/(unknown-account|[0-9]{12})\/(unknown-region|[a-z0-9-]+)$/.exec(artifact.environment) : null;
  if (!place) stop("ASSEMBLY_ENV_INVALID");
  if ((place![1] !== "unknown-account" && place![1] !== pinned.accountId) || (place![2] !== "unknown-region" && place![2] !== pinned.region)) stop("ASSEMBLY_ENV_NOT_IN_CONTRACT");
  if (stackName !== pinned.backend) stop("STACK_NOT_IN_CONTRACT");
  if (properties.terminationProtection !== true) stop("TERMINATION_PROTECTION_OFF");

  const bytes = readFileIn(work, templateFile, MAX_TEMPLATE_BYTES, "TEMPLATE_UNREADABLE");
  const parsed = parse(bytes.toString("utf8"), "TEMPLATE_UNREADABLE");
  const template = isRecord(parsed) ? parsed : stop("TEMPLATE_UNREADABLE");
  if (Object.values(isRecord(template.Resources) ? template.Resources : {}).some((resource) => isRecord(resource) && resource.Type === "AWS::CloudFormation::Stack")) stop("ASSEMBLY_NESTED_STACK");
  walkTemplate(template);
  return { stackName, templateFile, templateSha256: sha256(bytes) };
}

// --- what CloudFormation reports ---------------------------------------------------------------------------

type StackView = { id: string; status: string; protection: boolean; touched: string };

/** `undefined` when the stack does not exist. The text of an error is matched, never carried. */
function readStack(session: Session, who: Who, stack: string, region: string): StackView | undefined {
  const result = session.run(who, describeStacksArgv(stack, region));
  if (result.refusedEnvironment?.length) stop("ENVIRONMENT_REFUSED");
  if (result.truncated) stop("OUTPUT_TRUNCATED");
  if (!result.ok) return result.exitCode !== null && /\bdoes not exist\b/.test(result.stderr) ? undefined : stop("STACK_UNREADABLE");
  const document = parse(result.stdout, "STACK_UNREADABLE");
  const found = isRecord(document) && Array.isArray(document.Stacks) && isRecord(document.Stacks[0]) ? document.Stacks[0] : stop("STACK_UNREADABLE");
  return {
    id: str(found.StackId, "STACK_UNREADABLE"), status: str(found.StackStatus, "STACK_UNREADABLE"), protection: found.EnableTerminationProtection === true,
    touched: str(found.LastUpdatedTime ?? found.CreationTime, "STACK_UNREADABLE"),
  };
}

const IN_PROGRESS = new Set([
  "CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "ROLLBACK_IN_PROGRESS", "REVIEW_IN_PROGRESS", "IMPORT_IN_PROGRESS", "IMPORT_ROLLBACK_IN_PROGRESS",
]);
/** Statuses a stack can be updated from. */
const UPDATABLE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]);
const ROLLED_BACK = new Set(["ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);

type ChangeView = {
  id: string; stackId: string; stackName: string; status: string; execution: string; capabilities: string[];
  parametersSha256: string; changes: PlanChange[]; changesSha256: string;
};

const ACTIONS: Readonly<Record<string, string>> = { Add: "CREATE", Modify: "UPDATE", Remove: "DELETE", Import: "IMPORT", Dynamic: "DYNAMIC" };

/** One line of the change list: logical id, resource type, action and, for a change that replaces, whether it does or may. Never a property or a value. */
function changeOf(entry: unknown): PlanChange {
  const change = isRecord(entry) && entry.Type === "Resource" && isRecord(entry.ResourceChange) ? entry.ResourceChange : stop("CHANGE_UNREADABLE");
  const action = typeof change.Action === "string" && Object.hasOwn(ACTIONS, change.Action) ? ACTIONS[change.Action] : stop("CHANGE_ACTION_UNKNOWN");
  const replacement = action === "UPDATE" ? change.Replacement : undefined;
  return {
    address: stripInvisible(str(change.LogicalResourceId, "CHANGE_UNREADABLE")), type: stripInvisible(str(change.ResourceType, "CHANGE_UNREADABLE")),
    action: replacement === "True" ? "REPLACE" : replacement === "Conditional" ? "REPLACE_CONDITIONAL" : action,
    ...(action === "IMPORT" ? { importing: true as const } : {}),
  };
}

/** The change set as CloudFormation describes it now, as the identity given (CHANGESET). The parameter hash covers keys and values; the values themselves are never kept. */
function readChangeSet(session: Session, arn: string, region: string): ChangeView {
  const document = parse(session.ok("CHANGESET", describeChangeSetArgv(arn, region)), "CHANGE_SET_UNREADABLE");
  if (!isRecord(document) || !Array.isArray(document.Changes)) return stop("CHANGE_SET_UNREADABLE");
  const capabilities = document.Capabilities === undefined ? [] : Array.isArray(document.Capabilities) && document.Capabilities.every((c) => typeof c === "string") ? [...document.Capabilities as string[]].sort() : stop("CHANGE_SET_UNREADABLE");
  const parameters = (document.Parameters === undefined ? [] : Array.isArray(document.Parameters) ? document.Parameters : stop("CHANGE_SET_UNREADABLE"))
    .map((parameter) => (isRecord(parameter) ? { key: str(parameter.ParameterKey, "CHANGE_SET_UNREADABLE"), value: parameter.ParameterValue ?? null, resolved: parameter.ResolvedValue ?? null } : stop("CHANGE_SET_UNREADABLE")))
    .sort((a, b) => byText(a.key, b.key));
  const changes = document.Changes.map(changeOf).sort((a, b) => byText(a.address + "\0" + a.type, b.address + "\0" + b.type));
  return {
    id: str(document.ChangeSetId, "CHANGE_SET_UNREADABLE"), stackId: str(document.StackId, "CHANGE_SET_UNREADABLE"), stackName: str(document.StackName, "CHANGE_SET_UNREADABLE"),
    status: str(document.Status, "CHANGE_SET_UNREADABLE"), execution: str(document.ExecutionStatus, "CHANGE_SET_UNREADABLE"), capabilities,
    parametersSha256: sha256(canonicalJson(parameters)), changes, changesSha256: sha256(canonicalJson(changes)),
  };
}

// --- the sealed record -------------------------------------------------------------------------------------

/**
 * The artifact bytes: what the apply runs. It names the change set to execute and binds everything the approvers saw: the
 * stack, the change set, the template (by hash), the parameters (by hash), the capabilities and the change list (by hash).
 */
type SealedRecord = {
  schemaVersion: 1; kind: "CDK_CHANGE_SET"; account: string; region: string; stackName: string; stackId: string;
  changeSetId: string; changeSetName: string; changeSetType: "CREATE" | "UPDATE"; templateFile: string; templateSha256: string;
  parametersSha256: string; capabilities: string[]; changeListSha256: string;
};
const RECORD_KEYS = [
  "schemaVersion", "kind", "account", "region", "stackName", "stackId", "changeSetId", "changeSetName", "changeSetType", "templateFile", "templateSha256",
  "parametersSha256", "capabilities", "changeListSha256",
];
const HEX = /^[0-9a-f]{64}$/;

function parseRecord(artifact: Buffer, pinned: AwsTarget): SealedRecord {
  const value = parse(artifact.toString("utf8"), "ARTIFACT_TAMPERED");
  const region = pinned.region;
  const arn = (kind: string, name: RegExp) => new RegExp("^arn:aws:cloudformation:" + region + ":" + pinned.accountId + ":" + kind + "/" + name.source + "/[0-9a-f-]{36}$");
  const record = value as SealedRecord;
  if (!isRecord(value) || Object.keys(value).sort().join() !== [...RECORD_KEYS].sort().join() || record.schemaVersion !== 1 || record.kind !== "CDK_CHANGE_SET" ||
    record.account !== pinned.accountId || record.region !== region || record.stackName !== pinned.backend ||
    !arn("stack", new RegExp(pinned.backend)).test(record.stackId) || !arn("changeSet", /alz-[0-9a-f]{12}/).test(record.changeSetId) ||
    !/^alz-[0-9a-f]{12}$/.test(record.changeSetName) || !["CREATE", "UPDATE"].includes(record.changeSetType) || !REL_PATH.test(record.templateFile) || climbs(record.templateFile) ||
    ![record.templateSha256, record.parametersSha256, record.changeListSha256].every((h) => HEX.test(h)) ||
    !Array.isArray(record.capabilities) || !record.capabilities.every((c) => (CAPABILITIES as readonly string[]).includes(c))) {
    return stop("ARTIFACT_TAMPERED");
  }
  return record;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * The change list of the sealed record, derived again from the change set CloudFormation holds now. An id, stack or hash
 * that is not the sealed one is ARTIFACT_TAMPERED; a change set that can no longer be executed (the stack changed after it
 * was made, or it was used) is PLAN_STALE. Nothing is created, executed or deleted.
 */
function describeSealed(session: Session, artifact: Buffer, pinned: AwsTarget): { record: SealedRecord; changes: PlanChange[] } {
  const record = parseRecord(artifact, pinned);
  const view = readChangeSet(session, record.changeSetId, record.region);
  if (view.id !== record.changeSetId || view.stackId !== record.stackId || view.stackName !== record.stackName) stop("ARTIFACT_TAMPERED");
  if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("PLAN_STALE");
  if (!sameList(view.capabilities, record.capabilities) || view.parametersSha256 !== record.parametersSha256 || view.changesSha256 !== record.changeListSha256) stop("ARTIFACT_TAMPERED");
  return { record, changes: view.changes };
}

// --- sealing ---------------------------------------------------------------------------------------------------

/**
 * Creates the change set (CREATE for a stack that does not exist or was never executed, UPDATE for one that is in a
 * stable state with termination protection on), waits for it, describes it, and returns the record and the change list.
 * Executes nothing and deletes nothing: a change set that is not sealed stays for a person to clear.
 */
function plan(input: EngineContext & { snapshotPath: string; engineVersion: string }): { artifact: Buffer; changes: PlanChange[] } {
  const pinned = input.pinned as AwsTarget;
  const session = openSession({ ...input, hide: APPLIER });
  try {
    prepareWork(session, input.snapshotPath, input.engineVersion);
    // The runner would drop a variable it refuses and run with the rest; a change set is never created that way.
    if (session.refused("DISCOVERY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
    const assembly = readAssembly(session.work, pinned);
    const { region } = pinned;
    const stack = readStack(session, "DISCOVERY", assembly.stackName, region);
    let type: "CREATE" | "UPDATE" = "CREATE";
    if (stack !== undefined && stack.status !== "REVIEW_IN_PROGRESS") {
      if (!UPDATABLE.has(stack.status)) stop("STACK_STATE_UNSUITABLE");
      if (!stack.protection) stop("TERMINATION_PROTECTION_OFF");
      type = "UPDATE";
    }
    const capabilities = [...(pinned.capabilities ?? [])].sort();
    const name = "alz-" + randomBytes(6).toString("hex");
    const created = parse(session.ok("CHANGESET", createArgv({ stack: assembly.stackName, name, type, template: assembly.templateFile, capabilities, region })), "CHANGE_SET_UNREADABLE");
    const changeSetId = isRecord(created) ? str(created.Id, "CHANGE_SET_UNREADABLE") : stop("CHANGE_SET_UNREADABLE");
    const stackId = isRecord(created) ? str(created.StackId, "CHANGE_SET_UNREADABLE") : stop("CHANGE_SET_UNREADABLE");
    // The account and region of what was created are the contract's: the CHANGESET role really acted in the target.
    const base = "^arn:aws:cloudformation:" + region + ":" + pinned.accountId + ":";
    if (!new RegExp(base + "changeSet/" + name + "/[0-9a-f-]{36}$").test(changeSetId) || !new RegExp(base + "stack/" + assembly.stackName + "/[0-9a-f-]{36}$").test(stackId)) stop("CHANGESET_NOT_IN_CONTRACT");
    session.ok("CHANGESET", waitArgv(changeSetId, region));
    const view = readChangeSet(session, changeSetId, region);
    if (view.id !== changeSetId || view.stackId !== stackId || view.stackName !== assembly.stackName) stop("CHANGE_SET_MISMATCH");
    if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("CHANGE_SET_NOT_CREATED");
    if (view.capabilities.some((capability) => !capabilities.includes(capability))) stop("CAPABILITY_NOT_IN_CONTRACT");
    const record: SealedRecord = {
      schemaVersion: 1, kind: "CDK_CHANGE_SET", account: pinned.accountId, region, stackName: assembly.stackName, stackId, changeSetId, changeSetName: name, changeSetType: type,
      templateFile: assembly.templateFile, templateSha256: assembly.templateSha256, parametersSha256: view.parametersSha256, capabilities: view.capabilities, changeListSha256: view.changesSha256,
    };
    return { artifact: Buffer.from(canonicalJson(record)), changes: view.changes };
  } finally {
    removeTree(session.work);
  }
}

/** The qualification run: the version check, the assembly, and a describe-stacks as each identity. No change set, nothing created. */
function qualify(input: EngineContext & { snapshotPath: string; engineVersion: string }): void {
  const pinned = input.pinned as AwsTarget;
  const session = openSession(input);
  try {
    prepareWork(session, input.snapshotPath, input.engineVersion);
    readAssembly(session.work, pinned);
    for (const who of ["DISCOVERY", "CHANGESET", "APPLY"] as const) readStack(session, who, pinned.backend, pinned.region);
    if (session.refused("CHANGESET").length > 0 || session.refused("APPLY").length > 0) stop("ENVIRONMENT_REFUSED");
  } finally {
    removeTree(session.work);
  }
}

function rederiveChanges(input: EngineContext & { artifact: Buffer }): PlanChange[] {
  const session = openSession({ ...input, hide: APPLIER });
  mkdirSync(session.work, { recursive: true, mode: 0o700 });
  return describeSealed(session, input.artifact, input.pinned as AwsTarget).changes;
}

// --- applying ----------------------------------------------------------------------------------------------------

/** A stack can take a long time to update; a time limit is a stop like the kill switch. */
const APPLY_DEADLINE_MS = 60 * 60_000;
const POLL_MS = 2_000;
/** How long after a stop the engine waits for the stack to settle, unless the driver says otherwise. CloudFormation rolls back; it does not stop at once. */
const SETTLE_AFTER_STOP_MS = 10 * 60_000;
/** Polls with the stack still as it was before an execution that was accepted: after this many, the state is unknown. */
const MAX_UNSTARTED_POLLS = 30;
const MAX_UNREADABLE_POLLS = 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const outcomeResult = (over: Partial<StoppableResult>): StoppableResult => ({ tool: "aws_cloudformation", ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, stopped: false, ...over });

function openApply(input: EngineRunInput): EngineApplyRun {
  const pinned = input.pinned as AwsTarget;
  const { region } = pinned;
  const session = openSession(input);
  let before: StackView | undefined;
  let sealed: SealedRecord | undefined;
  const ran: { executeExit: number | null; view?: StackView; stopped: boolean } = { executeExit: null, stopped: false };
  const changed = (view: StackView | undefined): boolean => view !== undefined && before !== undefined && (view.status !== before.status || view.touched !== before.touched);

  /** Whether a resource changed after the execution began: any event for something other than the stack itself. Unreadable is yes. */
  function resourcesTouched(): boolean {
    try {
      const events = parse(session.ok("APPLY", eventsArgv(pinned.backend, region)), "EVENTS_UNREADABLE");
      const since = Date.parse(before?.touched ?? "");
      if (!isRecord(events) || !Array.isArray(events.StackEvents) || Number.isNaN(since)) return true;
      return events.StackEvents.some((event) => !isRecord(event) || (event.ResourceType !== "AWS::CloudFormation::Stack" && !(Date.parse(String(event.Timestamp)) <= since)));
    } catch { return true; }
  }

  return {
    // The assembly as sealed, the pinned CLI, the identities the runner would hand whole, and the stack as it is now.
    prepare(snapshotPath) {
      prepareWork(session, snapshotPath, input.engineVersion);
      if (session.refused("APPLY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
      before = readStack(session, "APPLY", pinned.backend, region) ?? stop("STACK_UNREADABLE");
    },
    rederive(artifact) {
      const found = describeSealed(session, artifact, pinned);
      const assembly = readAssembly(session.work, pinned);
      if (assembly.templateFile !== found.record.templateFile || assembly.templateSha256 !== found.record.templateSha256) stop("ARTIFACT_TAMPERED");
      if (before === undefined) stop("ENGINE_NOT_PREPARED");
      if (before!.id !== found.record.stackId) stop("ARTIFACT_TAMPERED");
      if (found.record.changeSetType === "CREATE" ? before!.status !== "REVIEW_IN_PROGRESS" : !UPDATABLE.has(before!.status)) stop("PLAN_STALE");
      sealed = found.record;
      return found.changes;
    },
    async execute(artifact, control) {
      const record = parseRecord(artifact, pinned);
      // The last look before the execution exists, as the runner takes for a process it spawns.
      if (control.stopWhen()) return outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the execution started." });
      let signalled = false;
      const release = interceptStopSignals(() => { signalled = true; });
      try {
        const started = session.run("APPLY", executeArgv(record.changeSetId, region));
        if (started.refusedEnvironment?.length) stop("ENVIRONMENT_REFUSED");
        ran.executeExit = started.exitCode;
        const pollMs = control.pollMs ?? POLL_MS;
        const deadline = Date.now() + APPLY_DEADLINE_MS;
        const settleMs = control.graceMs ?? SETTLE_AFTER_STOP_MS;
        let stoppedAt: number | undefined;
        let canceled = false;
        let unreadable = 0;
        let unstarted = 0;
        for (;;) {
          let view: StackView | undefined;
          try { view = readStack(session, "APPLY", pinned.backend, region); } catch { view = undefined; }
          if (view === undefined) {
            if (++unreadable >= MAX_UNREADABLE_POLLS) break;
          } else {
            unreadable = 0;
            ran.view = view;
            if (!changed(view)) {
              // The execution was refused and nothing moved, or it has not shown yet.
              if (ran.executeExit !== 0 || ++unstarted > MAX_UNSTARTED_POLLS) break;
            } else if (!IN_PROGRESS.has(view.status)) break;
          }
          if (stoppedAt === undefined && (signalled || control.stopWhen() || Date.now() > deadline)) {
            stoppedAt = Date.now();
            ran.stopped = true;
            // Only an update in progress can be canceled (a create cannot); CloudFormation then rolls back, and this waits for it.
            if (!canceled && view?.status === "UPDATE_IN_PROGRESS") {
              canceled = true;
              session.run("APPLY", cancelArgv(pinned.backend, region));
            }
          }
          if (stoppedAt !== undefined && Date.now() - stoppedAt > settleMs) break;
          await sleep(pollMs);
        }
        return outcomeResult({ ok: ran.executeExit === 0, exitCode: ran.executeExit, stopped: ran.stopped });
      } finally {
        release();
      }
    },
    settle() {
      const view = ran.view;
      if (sealed === undefined) return stop("ENGINE_NOT_PREPARED");
      if (changed(view) && view!.status === (sealed.changeSetType === "CREATE" ? "CREATE_COMPLETE" : "UPDATE_COMPLETE")) return { outcome: "SUCCEEDED" } satisfies ApplyEnd;
      if (ran.stopped) return { outcome: "KILLED" };
      if (view === undefined || (!changed(view) && ran.executeExit === 0)) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
      if (!changed(view)) return { outcome: "FAILED_NO_CHANGE" };
      if (ROLLED_BACK.has(view.status)) return { outcome: resourcesTouched() ? "PARTIAL_REQUIRES_REVIEW" : "FAILED_NO_CHANGE" };
      return { outcome: "PARTIAL_REQUIRES_REVIEW" };
    },
    recoveryFiles: () => [],
    removeSecrets: () => undefined,
  };
}

const adapter = (kind: "preview" | "apply"): AdapterDescriptor => ({
  engine: "CDK", adapterVersion: kind === "preview" ? PREVIEW_ADAPTER_VERSION : APPLY_ADAPTER_VERSION, argvDigest: digestOf(kind),
});

export const CDK: EngineSpec = {
  id: "CDK",
  mutation: "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET",
  providers: ["AWS"],
  target: {
    backendOk: (value) => STACK_NAME.test(value),
    workspaceOk: (value) => value === "default",
    // The same stack name in each account is the usual case; the account already differs.
    backendMayRepeat: true,
    fields: {
      capabilities: (value) => Array.isArray(value) && value.length <= CAPABILITIES.length && new Set(value).size === value.length &&
        value.every((item) => (CAPABILITIES as readonly string[]).includes(item as string)),
    },
  },
  notices: {
    sealHeading: "SEAL A CHANGE SET (this creates a CloudFormation change set for the stack and does not execute it; no resource changes and nothing is deleted)",
    sealReads: "  reads           the stack with the DISCOVERY identity, then creates and describes the change set with the CHANGESET identity",
    qualifyHeading: "QUALIFY THE CDK ADAPTERS (needs the real AWS CLI; against DEV it runs the version check and describe-stacks as each identity, and creates and executes nothing)",
    qualifyReads: "  runs            describe-stacks as DISCOVERY, CHANGESET and APPLY",
    attestation: (_provider, changeSet, apply) => [
      "  change set creation was by   CHANGESET  " + changeSet,
      "  stack execution is by        APPLY      " + apply,
      "Only if the logs show that, and the APPLY client never created a change set and the CHANGESET client never executed one, type (anything else writes nothing):",
    ],
    applyNote: "It executes exactly the sealed change set, never a new one, with the APPLY identity. It never deletes a stack or a change set.",
  },
  manifestMode: "PROJECT",
  identities: ["DISCOVERY", "CHANGESET", "APPLY"],
  attests: ["CHANGESET", "APPLY"],
  previewAdapter: () => adapter("preview"),
  applyAdapter: adapter("apply"),
  /** SHA-256 of the aws binary a run would execute: the runner's own lookup (approved tool directories only), as for Terraform. */
  binarySha256(toolDirs, env) {
    const path = resolveExecutable(EXECUTABLE, toolDirs ?? approvedToolDirs(env));
    try { return path ? sha256(readFileSync(path)) : undefined; } catch { return undefined; }
  },
  plan,
  qualify,
  rederiveChanges,
  openApply,
  outcomeMessages: {
    FAILED_NO_CHANGE: "The change set was not executed, or the stack was rolled back with no resource touched, and the stack is as it was. Engine output is withheld because it can quote " +
      "template and parameter values. This sealed change set and its approvals are spent: seal a new change set and obtain new approvals to try again.",
    PARTIAL_REQUIRES_REVIEW: "The stack update or create failed after it started, or ended in a state this command does not know (UPDATE_ROLLBACK_FAILED, ROLLBACK_FAILED, a rollback " +
      "that touched resources, or an unreadable stack). Do not retry. A person must review the stack, its events and its resources by hand before any new change set. " +
      "This sealed change set and its approvals are spent, and the engine's output is withheld because it can quote template and parameter values.",
    KILLED: "The apply was told to stop while it ran (the kill switch appeared, the time limit passed, or this command received SIGINT, SIGTERM, SIGHUP or SIGQUIT). An update in " +
      "progress was sent one cancel-update-stack, and CloudFormation rolls it back; a create cannot be canceled and runs on. The stack may be partly changed or still changing. " +
      "Do not retry. A person must review the stack and its resources by hand before any new change set. This sealed change set and its approvals are spent.",
  },
  recoveryLostNote: "",
  recoveryFileNames: [],
};
