import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { copyTree, projectDifference } from "../../teardown/driver/adapters/project-copy.js";
import { argvDigest } from "../../teardown/driver/qualification.js";
import { removeTree } from "../../teardown/driver/cleanup.js";
import type { AdapterDescriptor } from "../../teardown/driver/types.js";
import { canonicalJson } from "../../teardown/manifest.js";
import { approvedToolDirs, resolveExecutable } from "../../tools/child-env.js";
import type { ExecutionIdentity } from "../../tools/identity.js";
import { interceptStopSignals, refusedVariables, runBoundedProcess, type StoppableResult } from "../../tools/process.js";
import { AWS_CFN_APPLY_PROFILE } from "../../tools/profiles.js";
import type { ToolResult } from "../../tools/types.js";
import { sha256 } from "../../util/sha256.js";
import { stripInvisible } from "../constants.js";
import { assertUsable, checkedOutput, stop, withoutIdentities } from "../engine.js";
import type { ApplyEnd, EngineApplyRun, EngineCleanupRun, EngineContext, EngineRunInput, EngineSpec, StateDocument, StopControl } from "../engine-spec.js";
import type { AwsTarget } from "../providers/aws.js";
import { isRecord } from "../providers/shared.js";
import type { PlanChange, SealedUnit } from "../types.js";
import type { PilotUnit } from "../unit.js";

/**
 * The CDK engine spec (docs/act-pilot-apply.md, "CDK"): a pre-synthesized CDK cloud assembly (cdk.out) with one stack
 * and no assets, applied through one CloudFormation change set and nothing else. The pilot never runs `cdk synth`, the
 * CDK CLI, npm, npx or any app code; it reads the assembly's files and calls the AWS CLI with the argument lists below.
 * Sealing creates the change set and does NOT execute it; the apply executes exactly that change set. Codes only: engine
 * output (descriptions, stack events, errors) can quote template and parameter values.
 *
 * UNVERIFIED: every AWS, CloudFormation and CDK fact in this file is from memory. The AWS documentation hosts were
 * unreachable when it was written, and no real AWS CLI or CloudFormation ran any of it (the tests use a fake `aws`). The
 * one list of the assumptions is in docs/act-pilot-apply.md ("CDK"); a comment "UNVERIFIED (n)" below marks where
 * assumption n is relied on. Each is checked against AWS's documentation and a real DEV run before live use.
 */

const EXECUTABLE = "aws";
const PREVIEW_ADAPTER_VERSION = "cdk-preview-1.2.0";
const APPLY_ADAPTER_VERSION = "cdk-apply-1.2.0";
const CLEANUP_ADAPTER_VERSION = "cdk-cleanup-1.0.0";
/** The removal template a cleanup writes into the work copy (the sealed template minus exactly the approved logical ids), by this one name. */
const CLEANUP_TEMPLATE_FILE = "alz-cleanup-template.json";

// --- the argument lists ---------------------------------------------------------------------------------

type Who = ExecutionIdentity | null;
type Slot = string | { name: string; ok: (value: string) => boolean };
type Shape = readonly Slot[];

const slot = (name: string, ok: (value: string) => boolean): Slot => ({ name, ok });
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const REL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const climbs = (path: string): boolean => path.split("/").some((part) => part === "." || part === "..");
/** CAPABILITY_AUTO_EXPAND is not here: it is for macros and transforms, which the engine refuses (`readAssembly`). */
const CAPABILITIES = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] as const;

const STACK = slot("stack", (v) => STACK_NAME.test(v));
const REGION_SLOT = slot("region", (v) => REGION.test(v));
const CHANGE_SET_NAME = slot("change-set-name", (v) => /^alz-[0-9a-f]{12}$/.test(v));
const CHANGE_SET_ARN = slot("change-set-arn", (v) => /^arn:aws:cloudformation:[a-z0-9-]+:[0-9]{12}:changeSet\/alz-[0-9a-f]{12}\/[0-9a-f-]{36}$/.test(v));
const CHANGE_SET_TYPE = slot("type", (v) => v === "CREATE" || v === "UPDATE");
const TEMPLATE = slot("template", (v) => v.startsWith("file://") && REL_PATH.test(v.slice(7)) && !climbs(v.slice(7)) && v.slice(7) !== CLEANUP_TEMPLATE_FILE);
/** A cleanup's change set is always an UPDATE from the one removal template; sealing can never name that file, and a cleanup never names another. */
const CLEANUP_TEMPLATE = slot("cleanup-template", (v) => v === "file://" + CLEANUP_TEMPLATE_FILE);
const UPDATE_ONLY = slot("type", (v) => v === "UPDATE");
const CAPABILITY = slot("capability", (v) => (CAPABILITIES as readonly string[]).includes(v));
/**
 * One stack tag as the CLI's shorthand (UNVERIFIED (8)): the deletion unit's tags (src/apply/unit.ts), always exactly these
 * three keys, so the sweep after an apply can list what the stack created by the run's unit. A tag with any other key is refused.
 */
const UNIT_TAG_KEYS: readonly string[] = ["alz-managed-by", "alz-unit", "alz-build"];
const TAG = slot("tag", (v) => /^Key=(alz-managed-by|alz-unit|alz-build),Value=[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v));
const JSON_OUTPUT: Shape = ["--region", REGION_SLOT, "--output", "json", "--no-cli-pager"];
const NO_OUTPUT: Shape = ["--region", REGION_SLOT, "--no-cli-pager"];

const VERSION_SHAPE: Shape = ["--version"];
const DESCRIBE_STACKS: Shape = ["cloudformation", "describe-stacks", "--stack-name", STACK, ...JSON_OUTPUT];
const createShape = (capabilities: number, template: Slot = TEMPLATE, type: Slot = CHANGE_SET_TYPE): Shape => [
  "cloudformation", "create-change-set", "--stack-name", STACK, "--change-set-name", CHANGE_SET_NAME, "--change-set-type", type,
  "--template-body", template, ...(capabilities > 0 ? ["--capabilities", ...Array<Slot>(capabilities).fill(CAPABILITY)] : []),
  "--tags", ...Array<Slot>(UNIT_TAG_KEYS.length).fill(TAG), ...JSON_OUTPUT,
];
const WAIT: Shape = ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", CHANGE_SET_ARN, ...NO_OUTPUT];
const DESCRIBE_CHANGE_SET: Shape = ["cloudformation", "describe-change-set", "--change-set-name", CHANGE_SET_ARN, ...JSON_OUTPUT];
const GET_TEMPLATE: Shape = ["cloudformation", "get-template", "--change-set-name", CHANGE_SET_ARN, "--template-stage", "Original", ...JSON_OUTPUT];
const EXECUTE: Shape = ["cloudformation", "execute-change-set", "--change-set-name", CHANGE_SET_ARN, ...NO_OUTPUT];
const DESCRIBE_EVENTS: Shape = ["cloudformation", "describe-stack-events", "--stack-name", STACK, ...JSON_OUTPUT];
/** The stack's resources, logical id to physical id (UNVERIFIED (9)): the blueprint's source, read once after an apply as DISCOVERY. */
const DESCRIBE_RESOURCES: Shape = ["cloudformation", "describe-stack-resources", "--stack-name", STACK, ...JSON_OUTPUT];
const CANCEL: Shape = ["cloudformation", "cancel-update-stack", "--stack-name", STACK, ...NO_OUTPUT];

type Entry = { who: Who; shape: Shape; adapters: readonly Adapter[] };
/**
 * Everything the engine can run, and as whom. There is no delete (a stack or a change set), no create-stack, update-stack
 * or deploy, no way to name a parameter, a role or a rollback setting, no tag but the deletion unit's own, and nothing for
 * CHANGESET to execute with: an argument list that is not one of these, for that identity, is refused before it reaches the runner.
 * A cleanup (docs/observe-and-cleanup.md, "CloudFormation") is an UPDATE change set from the one removal template, created by
 * CHANGESET and executed by APPLY like an apply: the same identities and permissions, and still no delete-stack.
 */
const ENTRIES: readonly Entry[] = [
  { who: null, shape: VERSION_SHAPE, adapters: ["preview", "apply", "cleanup"] },
  { who: "DISCOVERY", shape: DESCRIBE_STACKS, adapters: ["preview"] },
  // Qualification reads the stack as each identity; a change set creator that cannot describe a stack fails it.
  { who: "CHANGESET", shape: DESCRIBE_STACKS, adapters: ["preview", "apply", "cleanup"] },
  ...[0, 1, 2].map((n): Entry => ({ who: "CHANGESET", shape: createShape(n), adapters: ["preview"] })),
  ...[0, 1, 2].map((n): Entry => ({ who: "CHANGESET", shape: createShape(n, CLEANUP_TEMPLATE, UPDATE_ONLY), adapters: ["cleanup"] })),
  { who: "CHANGESET", shape: WAIT, adapters: ["preview", "cleanup"] },
  { who: "CHANGESET", shape: DESCRIBE_CHANGE_SET, adapters: ["preview", "apply", "cleanup"] },
  // UNVERIFIED (3): the change set's own template, to prove it is the assembly's (or the removal template's).
  { who: "CHANGESET", shape: GET_TEMPLATE, adapters: ["preview", "apply", "cleanup"] },
  { who: "APPLY", shape: DESCRIBE_STACKS, adapters: ["apply", "cleanup"] },
  { who: "APPLY", shape: EXECUTE, adapters: ["apply", "cleanup"] },
  { who: "APPLY", shape: DESCRIBE_EVENTS, adapters: ["apply", "cleanup"] },
  { who: "APPLY", shape: CANCEL, adapters: ["apply", "cleanup"] },
  // The blueprint's source after an apply: read-only, as DISCOVERY, like the observation that follows it.
  { who: "DISCOVERY", shape: DESCRIBE_RESOURCES, adapters: ["apply"] },
];

const fits = (shape: Shape, args: readonly string[]): boolean =>
  shape.length === args.length && shape.every((part, index) => (typeof part === "string" ? part === args[index] : part.ok(args[index])));

type Adapter = "preview" | "apply" | "cleanup";

/** Exact match against the lists above for this identity, and (when an adapter is named) for that adapter's surface alone. */
export function isAllowedCdkArgv(who: Who, args: readonly string[], adapter?: Adapter): boolean {
  if (!Array.isArray(args) || !args.some((arg) => typeof arg === "string") || !args.every((arg) => typeof arg === "string")) return false;
  // The three tag slots must be the three distinct unit keys: a repeated key is not the unit (review 6411896219, N3).
  const at = args.indexOf("--tags");
  if (at >= 0 && new Set(args.slice(at + 1, at + 1 + UNIT_TAG_KEYS.length).map((tag) => tag.split(",")[0])).size !== UNIT_TAG_KEYS.length) return false;
  return ENTRIES.some((entry) => entry.who === who && (adapter === undefined || entry.adapters.includes(adapter)) && fits(entry.shape, args));
}

const digestOf = (adapter: Adapter): string => argvDigest(ENTRIES.filter((entry) => entry.adapters.includes(adapter)).map((entry) =>
  [entry.who ?? "NONE", EXECUTABLE, ...entry.shape.map((part) => (typeof part === "string" ? part : "<" + part.name + ">"))]));

const describeStacksArgv = (stack: string, region: string): string[] => ["cloudformation", "describe-stacks", "--stack-name", stack, "--region", region, "--output", "json", "--no-cli-pager"];
const createArgv = (c: { stack: string; name: string; type: string; template: string; capabilities: readonly string[]; tags: readonly string[]; region: string }): string[] => [
  "cloudformation", "create-change-set", "--stack-name", c.stack, "--change-set-name", c.name, "--change-set-type", c.type, "--template-body", "file://" + c.template,
  ...(c.capabilities.length > 0 ? ["--capabilities", ...c.capabilities] : []), "--tags", ...c.tags, "--region", c.region, "--output", "json", "--no-cli-pager",
];
const resourcesArgv = (stack: string, region: string): string[] => ["cloudformation", "describe-stack-resources", "--stack-name", stack, "--region", region, "--output", "json", "--no-cli-pager"];
/** The unit's tags as the CLI's shorthand, in key order; exactly the three unit keys, or a code (the shape above refuses anything else anyway). */
function tagArgsOf(unit: PilotUnit): string[] {
  const keys = Object.keys(unit.tags).sort();
  if (keys.join() !== [...UNIT_TAG_KEYS].sort().join()) return stop("UNIT_TAGS_INVALID");
  return keys.map((key) => "Key=" + key + ",Value=" + unit.tags[key]);
}
/** The hash of a change set's tags as CloudFormation reports them, key order aside; the seal binds it and the apply requires it. */
const tagsSha256Of = (tags: readonly { key: string; value: string }[]): string => sha256(canonicalJson([...tags].sort((a, b) => byText(a.key, b.key))));
const waitArgv = (arn: string, region: string): string[] => ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", arn, "--region", region, "--no-cli-pager"];
const describeChangeSetArgv = (arn: string, region: string): string[] => ["cloudformation", "describe-change-set", "--change-set-name", arn, "--region", region, "--output", "json", "--no-cli-pager"];
const getTemplateArgv = (arn: string, region: string): string[] => ["cloudformation", "get-template", "--change-set-name", arn, "--template-stage", "Original", "--region", region, "--output", "json", "--no-cli-pager"];
const executeArgv = (arn: string, region: string): string[] => ["cloudformation", "execute-change-set", "--change-set-name", arn, "--region", region, "--no-cli-pager"];
const eventsArgv = (stack: string, region: string): string[] => ["cloudformation", "describe-stack-events", "--stack-name", stack, "--region", region, "--output", "json", "--no-cli-pager"];
const cancelArgv = (stack: string, region: string): string[] => ["cloudformation", "cancel-update-stack", "--stack-name", stack, "--region", region, "--no-cli-pager"];

// --- running the AWS CLI -------------------------------------------------------------------------------

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

/** `adapter` limits the session to one surface (sealing runs the preview adapter's lists, an apply the apply adapter's); qualification runs both. */
type SessionInput = Pick<EngineContext, "scratchDir" | "env" | "toolDirs" | "manifest"> & { hide?: RegExp; adapter?: Adapter };

function openSession(input: SessionInput): Session {
  const work = join(input.scratchDir, "work");
  const visible = (): NodeJS.ProcessEnv => (input.hide === undefined ? input.env : Object.fromEntries(Object.entries(input.env).filter(([key]) => !input.hide!.test(key))));
  const options = (who: Who) => ({
    profile: AWS_CFN_APPLY_PROFILE, env: who === null ? withoutIdentities(input.env) : visible(), toolDirs: input.toolDirs,
    identity: who ?? "DISCOVERY", root: input.scratchDir, suppressDetail: true,
  });
  const run = (who: Who, args: readonly string[]): ToolResult => {
    if (!isAllowedCdkArgv(who, args, input.adapter)) stop("ARGV_NOT_ALLOWED");
    return runBoundedProcess("aws_cloudformation", EXECUTABLE, [...args], work, options(who));
  };
  return {
    work, run,
    ok: (who, args) => checkedOutput(run(who, args)),
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

/** The most CloudFormation takes as an inline template body (UNVERIFIED (7)). Larger templates are uploaded as assets, which the pilot does not publish. */
const MAX_TEMPLATE_BYTES = 51_200;
const MAX_JSON_BYTES = 1_048_576;
/** Artifact types an assembly of one stack and no assets holds (UNVERIFIED (7)). Anything else (a nested assembly, a second kind of stack) is refused. */
const PLAIN_ARTIFACTS: readonly string[] = ["cdk:asset-manifest", "cdk:tree", "cdk:feature-flag-report"];

type Assembly = {
  stackName: string; templateFile: string; templateSha256: string;
  /** The template as CloudFormation should hold it (parsed, key order aside); a change set's own template is compared to this. */
  canonicalSha256: string;
  /** The template has an IAM resource, the only reason to pass an IAM capability. */
  needsIam: boolean;
};

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

/**
 * Whether any JSON object repeats a key. `JSON.parse` keeps the last, and CloudFormation parses the text itself, so a
 * repeated key could show this check one template and CloudFormation another. Run on text that already parsed.
 */
function hasDuplicateKey(text: string): boolean {
  const frames: (Set<string> | null)[] = [];
  let wantKey = false;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s"{}[\],:]+/g)) {
    const frame = frames[frames.length - 1];
    if (token === "{") { frames.push(new Set()); wantKey = true; }
    else if (token === "[") { frames.push(null); wantKey = false; }
    else if (token === "}" || token === "]") { frames.pop(); wantKey = false; }
    else if (token === ",") wantKey = frame instanceof Set;
    else if (token === ":") wantKey = false;
    else if (wantKey && frame instanceof Set) {
      const key = JSON.parse(token) as string;
      if (frame.has(key)) return true;
      frame.add(key);
      wantKey = false;
    }
  }
  return false;
}

/** A transform or macro expands the template where the hashes cannot see it (UNVERIFIED (3): the key names). */
function walkTemplate(value: unknown): void {
  if (Array.isArray(value)) value.forEach(walkTemplate);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "Fn::ImportValue") stop("ASSEMBLY_CROSS_STACK_IMPORT");
      if (key === "Fn::Transform") stop("ASSEMBLY_TRANSFORM");
      walkTemplate(child);
    }
  }
}

/**
 * The refusals that keep the pilot's input to what it can apply exactly: one stack, no asset to publish (the stack's own
 * template is the one file asset it lists, and it is sent inline), no nested stack or cross-stack import, the contract's
 * stack name, account and region (an assembly synthesized for any account and region names none), and termination
 * protection declared on. It also refuses what changes the template where the hashes cannot see it: a transform or
 * macro, a custom resource (code that runs in the account), and a key repeated in the template. Reads the work copy's
 * files; never runs anything.
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
  const text = bytes.toString("utf8");
  const parsed = parse(text, "TEMPLATE_UNREADABLE");
  const template = isRecord(parsed) ? parsed : stop("TEMPLATE_UNREADABLE");
  if (hasDuplicateKey(text)) stop("TEMPLATE_DUPLICATE_KEY");
  if (template.Transform !== undefined) stop("ASSEMBLY_TRANSFORM");
  const types = Object.values(isRecord(template.Resources) ? template.Resources : {}).map((resource) => (isRecord(resource) ? String(resource.Type) : ""));
  if (types.some(isStackType)) stop("ASSEMBLY_NESTED_STACK");
  if (types.some(isCustomResourceType)) stop("ASSEMBLY_CUSTOM_RESOURCE");
  walkTemplate(template);
  return { stackName, templateFile, templateSha256: sha256(bytes), canonicalSha256: sha256(canonicalJson(template)), needsIam: types.some((type) => type.startsWith("AWS::IAM::")) };
}

// --- what CloudFormation reports ---------------------------------------------------------------------------

/**
 * The stack as CloudFormation describes it. `fingerprint` hashes everything a change set inherits from the stack and the
 * approvers cannot see: its id, status, last change, service role, notification topics and rollback configuration. The
 * seal records it and the apply requires it unchanged, twice (UNVERIFIED (3): the field names).
 */
type StackView = { id: string; status: string; protection: boolean; touched: string; fingerprint: string; tags: { key: string; value: string }[] };

/** `undefined` when the stack does not exist. The text of an error is matched, never carried. */
function readStack(session: Session, who: Who, stack: string, region: string): StackView | undefined {
  const result = session.run(who, describeStacksArgv(stack, region));
  assertUsable(result);
  // UNVERIFIED (4): that a missing stack is told apart by this text.
  if (!result.ok) return result.exitCode !== null && /\bdoes not exist\b/.test(result.stderr) ? undefined : stop("STACK_UNREADABLE");
  const document = parse(result.stdout, "STACK_UNREADABLE");
  const found = isRecord(document) && Array.isArray(document.Stacks) && isRecord(document.Stacks[0]) ? document.Stacks[0] : stop("STACK_UNREADABLE");
  const view = {
    id: str(found.StackId, "STACK_UNREADABLE"), status: str(found.StackStatus, "STACK_UNREADABLE"), protection: found.EnableTerminationProtection === true,
    touched: str(found.LastUpdatedTime ?? found.CreationTime, "STACK_UNREADABLE"),
  };
  const inherited = { roleArn: found.RoleARN ?? null, notificationArns: found.NotificationARNs ?? null, rollback: found.RollbackConfiguration ?? null };
  // The stack's own tags (UNVERIFIED (10): `Tags[].Key/Value`), which a cleanup passes back unchanged so the deletion unit stays on the stack. Not part of the fingerprint: the seal binds them through the change set.
  const tags = (found.Tags === undefined ? [] : Array.isArray(found.Tags) ? found.Tags : stop("STACK_UNREADABLE"))
    .map((tag) => (isRecord(tag) && typeof tag.Key === "string" && typeof tag.Value === "string" ? { key: tag.Key, value: tag.Value } : stop("STACK_UNREADABLE")))
    .sort((a, b) => byText(a.key, b.key));
  return { ...view, fingerprint: sha256(canonicalJson({ ...view, inherited })), tags };
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
  /** The stack tags the change set carries (UNVERIFIED (8): `Tags[].Key/Value`), and their hash. */
  tags: { key: string; value: string }[]; tagsSha256: string;
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
  if (!isRecord(document)) return stop("CHANGE_SET_UNREADABLE");
  // UNVERIFIED (5): the AWS CLI follows NextToken itself; a token left in the output means a page was not read, and a change list the approvers did not see whole is never sealed or run.
  if (document.NextToken !== undefined) return stop("CHANGE_SET_TRUNCATED");
  if (!Array.isArray(document.Changes)) return stop("CHANGE_SET_UNREADABLE");
  const capabilities = document.Capabilities === undefined ? [] : Array.isArray(document.Capabilities) && document.Capabilities.every((c) => typeof c === "string") ? [...document.Capabilities as string[]].sort() : stop("CHANGE_SET_UNREADABLE");
  const parameters = (document.Parameters === undefined ? [] : Array.isArray(document.Parameters) ? document.Parameters : stop("CHANGE_SET_UNREADABLE"))
    .map((parameter) => (isRecord(parameter) ? { key: str(parameter.ParameterKey, "CHANGE_SET_UNREADABLE"), value: parameter.ParameterValue ?? null, resolved: parameter.ResolvedValue ?? null } : stop("CHANGE_SET_UNREADABLE")))
    .sort((a, b) => byText(a.key, b.key));
  const changes = document.Changes.map(changeOf).sort((a, b) => byText(a.address + "\0" + a.type, b.address + "\0" + b.type));
  const tags = (document.Tags === undefined ? [] : Array.isArray(document.Tags) ? document.Tags : stop("CHANGE_SET_UNREADABLE"))
    .map((tag) => (isRecord(tag) ? { key: str(tag.Key, "CHANGE_SET_UNREADABLE"), value: str(tag.Value, "CHANGE_SET_UNREADABLE") } : stop("CHANGE_SET_UNREADABLE")))
    .sort((a, b) => byText(a.key, b.key));
  return {
    id: str(document.ChangeSetId, "CHANGE_SET_UNREADABLE"), stackId: str(document.StackId, "CHANGE_SET_UNREADABLE"), stackName: str(document.StackName, "CHANGE_SET_UNREADABLE"),
    status: str(document.Status, "CHANGE_SET_UNREADABLE"), execution: str(document.ExecutionStatus, "CHANGE_SET_UNREADABLE"), capabilities,
    parametersSha256: sha256(canonicalJson(parameters)), changes, changesSha256: sha256(canonicalJson(changes)), tags, tagsSha256: tagsSha256Of(tags),
  };
}

// --- the sealed record -------------------------------------------------------------------------------------

/**
 * The artifact bytes: what the apply runs. It names the change set to execute and binds everything the approvers saw: the
 * stack, the change set, the template (by hash), the parameters (by hash), the capabilities and the change list (by hash),
 * and the state of the stack the change set was made against (by hash, `StackView.fingerprint`).
 */
type SealedRecord = {
  schemaVersion: 1; kind: "CDK_CHANGE_SET"; account: string; region: string; stackName: string; stackId: string;
  changeSetId: string; changeSetName: string; changeSetType: "CREATE" | "UPDATE"; templateFile: string; templateSha256: string;
  parametersSha256: string; capabilities: string[]; changeListSha256: string; stackSha256: string;
  /** The deletion unit's stack tags the change set carries, by hash; the unit itself is in the sealed plan the approvers sign. */
  tagsSha256: string;
};
const RECORD_KEYS = [
  "schemaVersion", "kind", "account", "region", "stackName", "stackId", "changeSetId", "changeSetName", "changeSetType", "templateFile", "templateSha256",
  "parametersSha256", "capabilities", "changeListSha256", "stackSha256", "tagsSha256",
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
    !/^alz-[0-9a-f]{12}$/.test(record.changeSetName) || record.changeSetId.split("/")[1] !== record.changeSetName || !["CREATE", "UPDATE"].includes(record.changeSetType) || !REL_PATH.test(record.templateFile) || climbs(record.templateFile) ||
    ![record.templateSha256, record.parametersSha256, record.changeListSha256, record.stackSha256, record.tagsSha256].every((h) => HEX.test(h)) ||
    !Array.isArray(record.capabilities) || !record.capabilities.every((c) => (CAPABILITIES as readonly string[]).includes(c))) {
    return stop("ARTIFACT_TAMPERED");
  }
  return record;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/** The hash of the template a change set holds (UNVERIFIED (3): `get-template` prints `TemplateBody`, an object for JSON), to compare with the assembly's. */
function changeSetTemplateSha256(session: Session, arn: string, region: string): string {
  const document = parse(session.ok("CHANGESET", getTemplateArgv(arn, region)), "CHANGE_SET_UNREADABLE");
  const body = isRecord(document) ? document.TemplateBody : undefined;
  const template = typeof body === "string" ? parse(body, "CHANGE_SET_UNREADABLE") : body;
  return isRecord(template) ? sha256(canonicalJson(template)) : stop("CHANGE_SET_UNREADABLE");
}

/**
 * The change list of the sealed record, derived again from the change set CloudFormation holds now. An id, stack or hash
 * that is not the sealed one is ARTIFACT_TAMPERED; a change set that can no longer be executed (the stack changed after it
 * was made, or it was used) is PLAN_STALE (UNVERIFIED (4): that CloudFormation says so; the stack check in `rederive` does not depend on it).
 * Nothing is created, executed or deleted.
 */
function describeSealed(session: Session, artifact: Buffer, pinned: AwsTarget): { record: SealedRecord; changes: PlanChange[] } {
  const record = parseRecord(artifact, pinned);
  const view = readChangeSet(session, record.changeSetId, record.region);
  if (view.id !== record.changeSetId || view.stackId !== record.stackId || view.stackName !== record.stackName) stop("ARTIFACT_TAMPERED");
  if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("PLAN_STALE");
  if (!sameList(view.capabilities, record.capabilities) || view.parametersSha256 !== record.parametersSha256 || view.changesSha256 !== record.changeListSha256 || view.tagsSha256 !== record.tagsSha256) stop("ARTIFACT_TAMPERED");
  return { record, changes: view.changes };
}

// --- sealing ---------------------------------------------------------------------------------------------------

/**
 * Creates the change set (CREATE for a stack that does not exist or was never executed, UPDATE for one that is in a
 * stable state with termination protection on), waits for it, describes it, proves that it holds the assembly's template,
 * records the stack it was made against, and returns the record and the change list. Executes nothing and deletes
 * nothing: a change set that is not sealed stays for a person to clear.
 */
function plan(input: EngineContext & { snapshotPath: string; engineVersion: string; unit: PilotUnit }): { artifact: Buffer; changes: PlanChange[]; unit: SealedUnit } {
  const pinned = input.pinned as AwsTarget;
  const session = openSession({ ...input, hide: APPLIER, adapter: "preview" });
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
    // Only a template with an IAM resource is given the contract's IAM capabilities; a template without one is given none.
    const capabilities = assembly.needsIam ? [...(pinned.capabilities ?? [])].sort() : [];
    // The deletion unit as stack tags (UNVERIFIED (8): CloudFormation stamps them on every resource of the stack that takes tags), so the
    // observation and the leftover check can sweep by the run's unit. The template itself is never edited.
    const tags = tagArgsOf(input.unit);
    const name = "alz-" + randomBytes(6).toString("hex");
    const created = parse(session.ok("CHANGESET", createArgv({ stack: assembly.stackName, name, type, template: assembly.templateFile, capabilities, tags, region })), "CHANGE_SET_UNREADABLE");
    const changeSetId = isRecord(created) ? str(created.Id, "CHANGE_SET_UNREADABLE") : stop("CHANGE_SET_UNREADABLE");
    const stackId = isRecord(created) ? str(created.StackId, "CHANGE_SET_UNREADABLE") : stop("CHANGE_SET_UNREADABLE");
    // The account and region of what was created are the contract's: the CHANGESET role really acted in the target.
    const base = "^arn:aws:cloudformation:" + region + ":" + pinned.accountId + ":";
    if (!new RegExp(base + "changeSet/" + name + "/[0-9a-f-]{36}$").test(changeSetId) || !new RegExp(base + "stack/" + assembly.stackName + "/[0-9a-f-]{36}$").test(stackId)) stop("CHANGESET_NOT_IN_CONTRACT");
    const waited = session.run("CHANGESET", waitArgv(changeSetId, region));
    if (waited.exitCode !== 0) {
      // UNVERIFIED (5): a change set with nothing to change, and one that could not be built, both end FAILED; the reason text tells them apart.
      const failed = session.run("CHANGESET", describeChangeSetArgv(changeSetId, region));
      const reason = failed.exitCode === 0 ? parse(failed.stdout, "CHANGE_SET_UNREADABLE") : undefined;
      if (isRecord(reason) && reason.Status === "FAILED") {
        stop(/didn't contain changes|No updates are to be performed/i.test(String(reason.StatusReason ?? "")) ? "NO_CHANGES_TO_APPLY" : "CHANGE_SET_CREATION_FAILED");
      }
      checkedOutput(waited);
    }
    const view = readChangeSet(session, changeSetId, region);
    if (view.id !== changeSetId || view.stackId !== stackId || view.stackName !== assembly.stackName) stop("CHANGE_SET_MISMATCH");
    if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("CHANGE_SET_NOT_CREATED");
    if (view.changes.length === 0) stop("NO_CHANGES_TO_APPLY");
    // CloudFormation reports no capability that was not passed.
    if (view.capabilities.some((capability) => !capabilities.includes(capability))) stop("CAPABILITY_NOT_IN_CONTRACT");
    if (changeSetTemplateSha256(session, changeSetId, region) !== assembly.canonicalSha256) stop("CHANGE_SET_TEMPLATE_MISMATCH");
    // CloudFormation reports exactly the unit's tags: no tag dropped, none added, none with another value.
    if (view.tags.map((tag) => "Key=" + tag.key + ",Value=" + tag.value).join("\n") !== [...tags].sort().join("\n")) stop("CHANGE_SET_TAGS_MISMATCH");
    // The stack the change set was made against, as the apply must find it again (UNVERIFIED (4): that creating a change set does not change it).
    const against = readStack(session, "DISCOVERY", assembly.stackName, region);
    if (against === undefined || against.id !== stackId) stop("CHANGE_SET_MISMATCH");
    const record: SealedRecord = {
      schemaVersion: 1, kind: "CDK_CHANGE_SET", account: pinned.accountId, region, stackName: assembly.stackName, stackId, changeSetId, changeSetName: name, changeSetType: type,
      templateFile: assembly.templateFile, templateSha256: assembly.templateSha256, parametersSha256: view.parametersSha256, capabilities: view.capabilities, changeListSha256: view.changesSha256,
      stackSha256: against!.fingerprint, tagsSha256: view.tagsSha256,
    };
    // The unit the stack tags carry. `untagged` is empty because stack tags reach every resource type that takes tags (UNVERIFIED (8));
    // which types take none is CloudFormation's knowledge, not this engine's, and such a resource stays traceable through the stack's own resource list.
    return { artifact: Buffer.from(canonicalJson(record)), changes: view.changes, unit: { unitId: input.unit.unitId, tags: { ...input.unit.tags }, untagged: [] } };
  } finally {
    removeTree(session.work);
  }
}

/**
 * The qualification run: the version check, the assembly, and a describe-stacks as each identity. No change set, nothing
 * created. It exercises no create, execute or cancel call, so it cannot show that CHANGESET cannot execute or that APPLY
 * cannot create: that separation rests on the cloud's IAM and the person's attestation alone (docs/act-pilot-apply.md).
 */
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

// --- applying ----------------------------------------------------------------------------------------------------

/** A stack can take a long time to update; a time limit is a stop like the kill switch, and like it cancels an update (which CloudFormation rolls back). */
const APPLY_DEADLINE_MS = 60 * 60_000;
const POLL_MS = 2_000;
/** How long after a stop the engine waits for the stack to settle, unless the driver says otherwise. CloudFormation rolls back; it does not stop at once. */
const SETTLE_AFTER_STOP_MS = 10 * 60_000;
/** Polls with the stack still as it was before an execution that was accepted: after this many, the state is unknown. */
const MAX_UNSTARTED_POLLS = 30;
const MAX_UNREADABLE_POLLS = 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const outcomeResult = (over: Partial<StoppableResult>): StoppableResult => ({ tool: "aws_cloudformation", ok: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, stopped: false, ...over });

/** What one execution left: the execute call's exit, the last stack view read, and whether a stop was requested. */
type Ran = { executeExit: number | null; view?: StackView; stopped: boolean };
const movedFrom = (before: StackView | undefined, view: StackView | undefined): boolean => view !== undefined && before !== undefined && (view.status !== before.status || view.touched !== before.touched);

/**
 * Executes one change set as APPLY and watches the stack until it settles, a stop arrives or the time limit passes. Shared by the
 * apply and the cleanup: from the execute call on nothing throws, because CloudFormation may have accepted the execution.
 */
async function executeAndWatch(session: Session, pinned: AwsTarget, changeSetId: string, before: StackView, control: StopControl): Promise<Ran> {
  const { region } = pinned;
  const ran: Ran = { executeExit: null, stopped: false };
  let signalled = false;
  const release = interceptStopSignals(() => { signalled = true; });
  try {
    ran.executeExit = session.run("APPLY", executeArgv(changeSetId, region)).exitCode;
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
        if (!movedFrom(before, view)) {
          // Nothing moved. A refused execute is judged from one look; an accepted one may not have shown yet.
          if (ran.executeExit !== 0 || ++unstarted > MAX_UNSTARTED_POLLS) break;
        } else if (!IN_PROGRESS.has(view.status)) break;
      }
      if (stoppedAt === undefined && (signalled || control.stopWhen() || Date.now() > deadline)) {
        stoppedAt = Date.now();
        ran.stopped = true;
        // Only an update this command started can be canceled (a create cannot, and a stack moving under someone else's
        // update is not ours to roll back); CloudFormation then rolls back, and this waits for it.
        if (!canceled && ran.executeExit === 0 && view?.status === "UPDATE_IN_PROGRESS") {
          canceled = true;
          session.run("APPLY", cancelArgv(pinned.backend, region));
        }
      }
      if (stoppedAt !== undefined && Date.now() - stoppedAt > settleMs) break;
      await sleep(pollMs);
    }
  } catch {
    // Whatever the stack and the change set show now is what the judge has.
  } finally {
    release();
  }
  return ran;
}

/**
 * The outcome, judged from the execute call, the stack and the change set together, never from the stack alone. Success needs all of:
 * our execute exited 0, the stack moved to the completed status, and the change set says it was executed. Not moving is a no-change
 * only when our execute failed and the change set is still unexecuted.
 */
function judgeExecution(ran: Ran, before: StackView, completed: string, execution: string | undefined, resourcesTouched: () => boolean): ApplyEnd {
  const view = ran.view;
  if (ran.executeExit === 0 && movedFrom(before, view) && view!.status === completed && execution === "EXECUTE_COMPLETE") return { outcome: "SUCCEEDED" };
  if (ran.stopped) return { outcome: "KILLED" };
  if (view === undefined) return { outcome: "PARTIAL_REQUIRES_REVIEW" };
  if (!movedFrom(before, view)) return { outcome: ran.executeExit !== 0 && execution === "AVAILABLE" ? "FAILED_NO_CHANGE" : "PARTIAL_REQUIRES_REVIEW" };
  if (ran.executeExit === 0 && ROLLED_BACK.has(view.status)) return { outcome: resourcesTouched() ? "PARTIAL_REQUIRES_REVIEW" : "FAILED_NO_CHANGE" };
  return { outcome: "PARTIAL_REQUIRES_REVIEW" };
}

/** Whether a resource changed after an execution began: any event for something other than the stack itself, since `before`. Unreadable is yes. */
function resourcesTouchedSince(session: Session, pinned: AwsTarget, before: StackView | undefined): boolean {
  let events: unknown;
  try { events = JSON.parse(session.ok("APPLY", eventsArgv(pinned.backend, pinned.region))); } catch { return true; }
  const since = Date.parse(before?.touched ?? "");
  if (!isRecord(events) || !Array.isArray(events.StackEvents) || Number.isNaN(since)) return true;
  return events.StackEvents.some((event) => !isRecord(event) || (event.ResourceType !== "AWS::CloudFormation::Stack" && !(Date.parse(String(event.Timestamp)) <= since)));
}

function openApply(input: EngineRunInput): EngineApplyRun {
  const pinned = input.pinned as AwsTarget;
  const { region } = pinned;
  const session = openSession({ ...input, adapter: "apply" });
  /** The stack as read just before the execution; the outcome is judged against it. */
  let before: StackView | undefined;
  let sealed: SealedRecord | undefined;
  let ran: Ran = { executeExit: null, stopped: false };
  const stackNow = (): StackView => readStack(session, "APPLY", pinned.backend, region) ?? stop("STACK_UNREADABLE");

  /** What the sealed change set says about its execution now (UNVERIFIED (4): AVAILABLE before, EXECUTE_COMPLETE after); undefined when it cannot be read. */
  function executionNow(): string | undefined {
    try { return readChangeSet(session, sealed!.changeSetId, region).execution; } catch { return undefined; }
  }

  return {
    // The assembly as sealed, the pinned CLI, the identities the runner would hand whole, and the stack as it is now.
    prepare(snapshotPath) {
      prepareWork(session, snapshotPath, input.engineVersion);
      if (session.refused("APPLY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
      before = stackNow();
    },
    rederive(artifact) {
      const found = describeSealed(session, artifact, pinned);
      const assembly = readAssembly(session.work, pinned);
      if (assembly.templateFile !== found.record.templateFile || assembly.templateSha256 !== found.record.templateSha256) stop("ARTIFACT_TAMPERED");
      // The change set holds the assembly's template, whatever the hashes of its change list say.
      if (changeSetTemplateSha256(session, found.record.changeSetId, region) !== assembly.canonicalSha256) stop("ARTIFACT_TAMPERED");
      if (before === undefined) stop("ENGINE_NOT_PREPARED");
      if (before!.id !== found.record.stackId) stop("ARTIFACT_TAMPERED");
      // The stack is as it was when the change set was made: not changed since, and not given another role, topic or rollback setting.
      if (before!.fingerprint !== found.record.stackSha256) stop("PLAN_STALE");
      sealed = found.record;
      return found.changes;
    },
    // Everything before the execute call may throw: nothing has run, and the driver gives the artifact back. From the call on
    // nothing throws, because CloudFormation may have accepted the execution: whatever goes wrong is a result for `settle`.
    async execute(artifact, control) {
      const record = parseRecord(artifact, pinned);
      // The last look before the execution exists, as the runner takes for a process it spawns.
      if (control.stopWhen()) return outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the execution started." });
      if (sealed === undefined) stop("ENGINE_NOT_PREPARED");
      if (canonicalJson(record) !== canonicalJson(sealed)) stop("ARTIFACT_TAMPERED");
      // The stack is read again now, after the approvals were consumed, and must still be the one the change set was made against.
      const now = stackNow();
      if (now.fingerprint !== sealed!.stackSha256) stop("PLAN_STALE");
      if (session.refused("APPLY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
      before = now;
      ran = await executeAndWatch(session, pinned, record.changeSetId, before, control);
      return outcomeResult({ ok: ran.executeExit === 0, exitCode: ran.executeExit, stopped: ran.stopped });
    },
    settle() {
      if (sealed === undefined || before === undefined) return stop("ENGINE_NOT_PREPARED");
      return judgeExecution(ran, before, sealed.changeSetType === "CREATE" ? "CREATE_COMPLETE" : "UPDATE_COMPLETE", executionNow(), () => resourcesTouchedSince(session, pinned, before));
    },
    recoveryFiles: () => [],
    removeSecrets: () => undefined,
    // What the stack holds after the run, logical id to physical id, read once as DISCOVERY (UNVERIFIED (9)). The driver maps it to
    // identifiers (src/observe/blueprint.ts) and drops it; a read that fails leaves no blueprint, and a later cleanup is refused for want of one.
    stateDocument(): StateDocument | undefined {
      try { return { source: "CLOUDFORMATION_STACK_RESOURCES", document: session.ok("DISCOVERY", resourcesArgv(pinned.backend, region)) }; } catch { return undefined; }
    },
  };
}

// --- the cleanup: a removal change set ----------------------------------------------------------------------------

const LOGICAL_ID = /^[A-Za-z0-9]{1,255}$/;
const MAX_CLEANUP_ADDRESSES = 200;
/** A deletion policy under which removing the resource from the template keeps the resource (UNVERIFIED (11)): the removal would not delete it. */
const KEEPS_RESOURCE = new Set(["Retain", "RetainExceptOnCreate", "Snapshot"]);
/**
 * A resource that holds or runs others and is never in a pilot's removal (nor in its assembly: `readAssembly` refuses it at the seal
 * and again when the cleanup prepares): a nested stack or a stack set holds resources no list here accounts for; a custom resource
 * or a macro runs code of its own on removal. The proposal keeps every one as CONTAINS_OTHERS; the removal template refuses them
 * once more so no forged list can reach CloudFormation with one.
 */
const isStackType = (type: string): boolean => type === "AWS::CloudFormation::Stack" || type === "AWS::CloudFormation::StackSet";
const isCustomResourceType = (type: string): boolean => type.startsWith("Custom::") || type === "AWS::CloudFormation::CustomResource" || type === "AWS::CloudFormation::Macro";

/** Every logical id a template value refers to: `Ref`, `Fn::GetAtt` (as a list or `"X.Attr"`), `DependsOn`, and `${X}` or `${X.Attr}` inside `Fn::Sub`. */
function referencesIn(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((item) => referencesIn(item, into)); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "Ref" && typeof child === "string") into.add(child);
    else if (key === "Fn::GetAtt") {
      if (Array.isArray(child) && typeof child[0] === "string") into.add(child[0]);
      else if (typeof child === "string") into.add(child.split(".")[0]!);
    } else if (key === "DependsOn") {
      for (const name of Array.isArray(child) ? child : [child]) if (typeof name === "string") into.add(name);
    } else if (key === "Fn::Sub") {
      const text = typeof child === "string" ? child : Array.isArray(child) && typeof child[0] === "string" ? child[0] : "";
      for (const [, name] of text.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) into.add(name!);
      if (Array.isArray(child)) referencesIn(child[1], into);
    } else referencesIn(child, into);
  }
}

/**
 * The removal template: the sealed template minus exactly the approved logical ids, and the refusals that keep a removal to
 * what a cleanup may do. Every approved id must be a resource of the template (`CLEANUP_ADDRESS_NOT_IN_TEMPLATE`); a resource
 * whose deletion policy keeps it is not removed this way (`CLEANUP_RETAIN_POLICY`: the removal would leave it, unapproved and
 * untracked); a remaining resource or output that still refers to a removed one stops the removal before CloudFormation would
 * (`CLEANUP_DEPENDENT_REFERENCED`: the dependent is not on the approved list); and a removal that would leave the stack with no
 * resource is refused (`CLEANUP_WOULD_EMPTY_STACK`): CloudFormation does not hold an empty stack (UNVERIFIED (11)), the stack
 * is never deleted by a cleanup, and retiring it with its last resources is the owner's separate decision.
 */
export function removalTemplateOf(template: Record<string, unknown>, addresses: readonly string[]): Record<string, unknown> {
  const resources = isRecord(template.Resources) ? template.Resources : stop("TEMPLATE_UNREADABLE");
  for (const address of addresses) {
    const resource = resources[address];
    if (!isRecord(resource)) return stop("CLEANUP_ADDRESS_NOT_IN_TEMPLATE");
    if (isStackType(String(resource.Type))) stop("ASSEMBLY_NESTED_STACK");
    if (isCustomResourceType(String(resource.Type))) stop("ASSEMBLY_CUSTOM_RESOURCE");
    if (typeof resource.DeletionPolicy === "string" && KEEPS_RESOURCE.has(resource.DeletionPolicy)) stop("CLEANUP_RETAIN_POLICY");
  }
  const removed = new Set(addresses);
  const remaining = Object.fromEntries(Object.entries(resources).filter(([logical]) => !removed.has(logical)));
  if (Object.keys(remaining).length === 0) stop("CLEANUP_WOULD_EMPTY_STACK");
  const referenced = new Set<string>();
  referencesIn(remaining, referenced);
  referencesIn(template.Outputs, referenced);
  if ([...referenced].some((name) => removed.has(name))) stop("CLEANUP_DEPENDENT_REFERENCED");
  return { ...template, Resources: remaining };
}

/**
 * The cleanup (docs/observe-and-cleanup.md, "CloudFormation"): the approved logical ids are removed from the sealed template, the
 * result is made a change set (CHANGESET) whose change list must be exactly a removal of those ids, and that change set is executed
 * (APPLY) and watched like an apply. The stack is never deleted, its tags are passed back unchanged, and nothing else is run.
 */
function openCleanup(input: EngineRunInput): EngineCleanupRun {
  const pinned = input.pinned as AwsTarget;
  const { region } = pinned;
  const session = openSession({ ...input, adapter: "cleanup" });
  const templatePath = join(session.work, CLEANUP_TEMPLATE_FILE);
  let assembly: Assembly | undefined;
  let before: StackView | undefined;
  let changeSetId: string | undefined;
  let changeSetFingerprint: string | undefined;
  let ran: Ran = { executeExit: null, stopped: false };
  const removeSecrets = (): void => { rmSync(templatePath, { force: true }); };
  const stackNow = (who: Who): StackView => readStack(session, who, pinned.backend, region) ?? stop("STACK_UNREADABLE");
  return {
    prepare(snapshotPath) {
      prepareWork(session, snapshotPath, input.engineVersion);
      if (session.refused("APPLY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
      assembly = readAssembly(session.work, pinned);
      const stack = stackNow("CHANGESET");
      if (!UPDATABLE.has(stack.status)) stop("STACK_STATE_UNSUITABLE");
      if (!stack.protection) stop("TERMINATION_PROTECTION_OFF");
      // The stack's tags are the deletion unit's own three, passed back unchanged; any other set is not a stack this pilot made.
      if (stack.tags.map((tag) => tag.key).sort().join() !== [...UNIT_TAG_KEYS].sort().join()) stop("CLEANUP_STACK_TAGS_UNKNOWN");
      before = stack;
    },
    planDestroy(addresses) {
      if (assembly === undefined || before === undefined) return stop("ENGINE_NOT_PREPARED");
      if (addresses.length === 0 || addresses.length > MAX_CLEANUP_ADDRESSES || addresses.some((address) => !LOGICAL_ID.test(address)) || new Set(addresses).size !== addresses.length) stop("CLEANUP_ADDRESSES_INVALID");
      const template = parse(readFileIn(session.work, assembly.templateFile, MAX_TEMPLATE_BYTES, "TEMPLATE_UNREADABLE").toString("utf8"), "TEMPLATE_UNREADABLE");
      const removal = removalTemplateOf(isRecord(template) ? template : stop("TEMPLATE_UNREADABLE"), addresses);
      const body = JSON.stringify(removal);
      if (Buffer.byteLength(body) > MAX_TEMPLATE_BYTES) stop("TEMPLATE_TOO_LARGE");
      // The work copy still equals the manifest before the one derived file is added to it; nothing else is ever written there.
      session.assertBound();
      writeFileSync(templatePath, body, { mode: 0o600, flag: "wx" });
      const types = Object.values(removal.Resources as Record<string, unknown>).map((resource) => (isRecord(resource) ? String(resource.Type) : ""));
      const capabilities = types.some((type) => type.startsWith("AWS::IAM::")) ? [...(pinned.capabilities ?? [])].sort() : [];
      const tags = before.tags.map((tag) => "Key=" + tag.key + ",Value=" + tag.value);
      const name = "alz-" + randomBytes(6).toString("hex");
      const created = parse(session.ok("CHANGESET", createArgv({ stack: assembly.stackName, name, type: "UPDATE", template: CLEANUP_TEMPLATE_FILE, capabilities, tags, region })), "CHANGE_SET_UNREADABLE");
      const id = isRecord(created) ? str(created.Id, "CHANGE_SET_UNREADABLE") : stop("CHANGE_SET_UNREADABLE");
      const base = "^arn:aws:cloudformation:" + region + ":" + pinned.accountId + ":";
      if (!new RegExp(base + "changeSet/" + name + "/[0-9a-f-]{36}$").test(id) || (isRecord(created) ? str(created.StackId, "CHANGE_SET_UNREADABLE") : "") !== before.id) stop("CHANGESET_NOT_IN_CONTRACT");
      const waited = session.run("CHANGESET", waitArgv(id, region));
      if (waited.exitCode !== 0) {
        const failed = session.run("CHANGESET", describeChangeSetArgv(id, region));
        const reason = failed.exitCode === 0 ? parse(failed.stdout, "CHANGE_SET_UNREADABLE") : undefined;
        if (isRecord(reason) && reason.Status === "FAILED") stop(/didn't contain changes|No updates are to be performed/i.test(String(reason.StatusReason ?? "")) ? "CLEANUP_NO_CHANGES" : "CHANGE_SET_CREATION_FAILED");
        checkedOutput(waited);
      }
      const view = readChangeSet(session, id, region);
      if (view.id !== id || view.stackId !== before.id || view.stackName !== assembly.stackName) stop("CHANGE_SET_MISMATCH");
      if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("CHANGE_SET_NOT_CREATED");
      if (view.capabilities.some((capability) => !capabilities.includes(capability))) stop("CAPABILITY_NOT_IN_CONTRACT");
      if (view.tags.map((tag) => "Key=" + tag.key + ",Value=" + tag.value).join("\n") !== [...tags].sort().join("\n")) stop("CHANGE_SET_TAGS_MISMATCH");
      // The change set holds exactly the removal template, whatever its change list says.
      if (changeSetTemplateSha256(session, id, region) !== sha256(canonicalJson(removal))) stop("CHANGE_SET_TEMPLATE_MISMATCH");
      changeSetId = id;
      changeSetFingerprint = view.changesSha256;
      // The stack as the change set was made against it; the execution requires it unchanged.
      const against = stackNow("CHANGESET");
      if (against.id !== before.id) stop("CHANGE_SET_MISMATCH");
      before = against;
      return view.changes;
    },
    async execute(control) {
      if (changeSetId === undefined || before === undefined || changeSetFingerprint === undefined) return stop("ENGINE_NOT_PREPARED");
      if (control.stopWhen()) return outcomeResult({ stopped: true, notStarted: true, stderr: "Stopped before the execution started." });
      // The change set is described again now, after the approvals were consumed, and must still be the one planned and still executable.
      const view = readChangeSet(session, changeSetId, region);
      if (view.id !== changeSetId || view.changesSha256 !== changeSetFingerprint) stop("ARTIFACT_TAMPERED");
      if (view.status !== "CREATE_COMPLETE" || view.execution !== "AVAILABLE") stop("PLAN_STALE");
      const now = stackNow("APPLY");
      if (now.fingerprint !== before.fingerprint) stop("PLAN_STALE");
      if (session.refused("APPLY").length > 0 || session.refused("CHANGESET").length > 0) stop("ENVIRONMENT_REFUSED");
      before = now;
      ran = await executeAndWatch(session, pinned, changeSetId, before, control);
      removeSecrets();
      return outcomeResult({ ok: ran.executeExit === 0, exitCode: ran.executeExit, stopped: ran.stopped });
    },
    settle() {
      if (changeSetId === undefined || before === undefined) return stop("ENGINE_NOT_PREPARED");
      let execution: string | undefined;
      try { execution = readChangeSet(session, changeSetId, region).execution; } catch { execution = undefined; }
      return judgeExecution(ran, before, "UPDATE_COMPLETE", execution, () => resourcesTouchedSince(session, pinned, before));
    },
    recoveryFiles: () => [],
    removeSecrets,
  };
}

const adapter = (kind: Adapter): AdapterDescriptor => ({
  engine: "CDK", adapterVersion: kind === "preview" ? PREVIEW_ADAPTER_VERSION : kind === "apply" ? APPLY_ADAPTER_VERSION : CLEANUP_ADAPTER_VERSION, argvDigest: digestOf(kind),
});

export const CDK: EngineSpec = {
  id: "CDK",
  executables: [EXECUTABLE],
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
      "This run only described stacks. That CHANGESET cannot execute and APPLY cannot create a change set is shown by the roles' IAM policies and the cloud's logs, not by this run.",
      "Only if they show that, and the APPLY client never created a change set and the CHANGESET client never executed one, type (anything else writes nothing):",
    ],
    applyNote: "It executes exactly the sealed change set, never a new one, with the APPLY identity. It never deletes a stack or a change set.",
    cleanupNote: "It removes exactly the approved logical ids from the sealed template through one UPDATE change set, created by CHANGESET and executed by APPLY. The stack itself is never deleted; retiring it is the owner's separate decision.",
  },
  manifestMode: "PROJECT",
  identities: ["DISCOVERY", "CHANGESET", "APPLY"],
  attests: ["CHANGESET", "APPLY"],
  previewAdapter: () => adapter("preview"),
  applyAdapter: adapter("apply"),
  cleanupAdapter: adapter("cleanup"),
  cleanupMutation: "CLOUDFORMATION_EXECUTE_OF_REMOVAL_CHANGE_SET",
  openCleanup,
  /** SHA-256 of the aws binary a run would execute: the runner's own lookup (approved tool directories only), as for Terraform. */
  binarySha256(toolDirs, env) {
    const path = resolveExecutable(EXECUTABLE, toolDirs ?? approvedToolDirs(env));
    try { return path ? sha256(readFileSync(path)) : undefined; } catch { return undefined; }
  },
  plan,
  qualify,
  openApply,
  outcomeMessages: {
    FAILED_NO_CHANGE: "The execution was refused: the stack did not move and CloudFormation reports the sealed change set still unexecuted, or the stack was rolled back with no " +
      "resource touched. Engine output is withheld because it can quote template and parameter values. This sealed change set and its approvals are spent: seal a new change set " +
      "and obtain new approvals to try again.",
    PARTIAL_REQUIRES_REVIEW: "The stack update or create failed after it started, or it cannot be told from one that did: a lost response, an unreadable stack or change set, a stack that " +
      "moved for another reason, a rollback that touched resources, or a state this command does not know (UPDATE_ROLLBACK_FAILED, ROLLBACK_FAILED). Do not retry. A person must " +
      "review the stack, its events and its resources by hand before any new change set. This sealed change set and its approvals are spent, and the engine's output is withheld " +
      "because it can quote template and parameter values.",
    KILLED: "The apply was told to stop while it ran (the kill switch appeared, the 60 minute time limit passed, or this command received SIGINT, SIGTERM, SIGHUP or SIGQUIT). An update " +
      "this command started was sent one cancel-update-stack, and CloudFormation rolls it back; a create cannot be canceled and runs on. The stack may be partly changed or still " +
      "changing. Do not retry. A person must review the stack and its resources by hand before any new change set. This sealed change set and its approvals are spent.",
  },
  recoveryLostNote: "",
  recoveryFileNames: [],
};
