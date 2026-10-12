import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeQualificationEvidence } from "../../src/apply/contract.js";
import { CDK } from "../../src/apply/engines/cdk.js";
import { AWS } from "../../src/apply/providers/aws.js";
import type { ApplyEnvironment } from "../../src/apply/types.js";
import type { ResolvedTarget } from "../../src/teardown/driver/types.js";
import { buildManifest } from "../../src/teardown/manifest.js";
import { captureProjectFiles } from "../../src/teardown/snapshot.js";
import {
  AWS_DEV_TARGET, AWS_REGION, H, POLICY, awsContractJson, awsTargetOf, sha, type Project,
} from "./apply-fixtures.js";

// Shared by test/apply-cdk. The `aws` executable is a fake: everything built on it pins the engine's logic, NOT the
// behavior of the real AWS CLI or CloudFormation (every response shape here is from memory, see src/apply/engines/cdk.ts).
// Explicit fake ids only (accounts 111111111111, 222222222222, 333333333333).

export const AWS_CLI_VERSION = "2.15.0";
export const STACK = "PilotStack";
export const TEMPLATE_CANARY = "CANARY_TEMPLATE_VALUE_t1";
export const PARAMETER_CANARY = "CANARY_PARAMETER_VALUE_t2";
export const OUTPUT_CANARY = "CANARY_STACK_OUTPUT_t3";
export const EVENT_CANARY = "CANARY_STACK_EVENT_t4";
export const STDERR_CANARY = "CANARY_STDERR_t5";
export const CDK_CANARIES = [TEMPLATE_CANARY, PARAMETER_CANARY, OUTPUT_CANARY, EVENT_CANARY, STDERR_CANARY];

export type AwsBehavior = {
  version?: string;
  /** A stack with this name already exists in every account, with `stackStatus` and termination protection `termination` (default on). */
  stackExists?: boolean; stackStatus?: string; termination?: boolean;
  /** describe-stacks always fails as if not allowed. */
  describeStacksFail?: boolean;
  waitFails?: boolean;
  /** The change set ARN is in this account instead of the role's. */
  arnAccount?: string;
  /** describe-change-set answers: a different change set id or stack id, a status, an execution status, an extra change. */
  swapChangeSetId?: string; swapStackId?: string; describedStackId?: string; changeSetStatus?: string; executionStatus?: string; extraChange?: boolean;
  executeFail?: boolean;
  /** execute-change-set exits 0 and nothing happens. */
  executeNoop?: boolean;
  /** execute-change-set exits 255 (a lost response): the execution does not begin, or (with `ranAnyway`) CloudFormation had already accepted it. */
  executeLost?: boolean; ranAnyway?: boolean;
  /** Someone else's update lands as execute-change-set is called: the stack moves, and (with executeFail) our execution is refused. */
  foreignUpdateOnExecute?: boolean;
  /** describe-change-set fails once execute-change-set was called. */
  changeSetReadFailsAfterExecute?: boolean;
  /** The stack is changed out of band as the named subcommand starts (a new LastUpdatedTime), or reports a service role. */
  bumpStackOn?: string; stackRoleArn?: string; stackUpdated?: string;
  /** get-template answers with a template that is not the one the change set was made from. */
  templateDiffers?: boolean;
  /** describe-change-set lists a change that is not a resource, a change with an unknown action, or is not a change set document at all. */
  badChange?: "unreadable" | "action"; describeGarbage?: boolean;
  /** describe-stacks prints more than the runner keeps. */
  bigOutput?: boolean;
  /** describe-change-set reports these capabilities whatever was passed. */
  echoCapabilities?: string[];
  /** Statuses describe-stacks answers with, one per poll after execute (the last repeats), and after a cancel. */
  pollStatuses?: string[]; afterCancel?: string[];
  /** describe-stack-events reports a resource event after the execution began. */
  eventsTouched?: boolean;
  /** Creates the kill file as the named subcommand starts, or at the n-th poll after execute (0-based). */
  touchKillOn?: string; touchKillAtPoll?: number;
  /** Plants this text in stderr of a failing step. */
  failStderr?: string;
  killPath?: string;
};

const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const stateFile = path.join(dir, "state.json");
const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const args = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: process.env, ...extra }) + "\\n");
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const fail = (message, code = 254) => { process.stderr.write(message); process.exit(code); };
const role = process.env.AWS_ROLE_ARN || "";
const account = role.split(":")[4] || "000000000000";
const region = arg("--region");
const a = (s.a[account] = s.a[account] || { stack: null, changeSet: null, executing: false, attempted: false, polls: 0, canceled: false, cancelPolls: 0, type: null });
const stackArn = (name) => "arn:aws:cloudformation:" + region + ":" + account + ":stack/" + name + "/" + crypto.randomUUID();
if (b.stackExists && !a.seeded) {
  a.seeded = true;
  a.stack = { id: stackArn(${JSON.stringify(STACK)}), status: b.stackStatus || "UPDATE_COMPLETE", protection: b.termination !== false, created: "2026-01-01T00:00:00.000Z", updated: "2026-10-11T11:00:00.000Z" };
}
if (args[0] === "--version") { log({}); process.stdout.write("aws-cli/" + b.version + " Python/3.11.6 Linux/6.1.0 exe/x86_64.ubuntu.22\\n"); process.exit(0); }
if (args[0] !== "cloudformation") { log({ unexpected: true }); process.exit(2); }
const cmd = args[1];
if (b.touchKillOn === cmd) fs.writeFileSync(b.killPath, "stop");
if (b.bumpStackOn === cmd && a.stack) { a.stack.updated = "2026-10-11T11:45:00.000Z"; save(); }

if (cmd === "describe-stacks") {
  log({});
  if (b.bigOutput) process.stdout.write("x".repeat(9 * 1024 * 1024));
  if (b.describeStacksFail) fail("An error occurred (AccessDenied) when calling the DescribeStacks operation: " + (b.failStderr || "not authorized"));
  if (!a.stack) fail("An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id " + arg("--stack-name") + " does not exist");
  if (a.executing) {
    const sequence = a.canceled ? (b.afterCancel || ["UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE"])
      : (b.pollStatuses || (a.type === "CREATE" ? ["CREATE_IN_PROGRESS", "CREATE_COMPLETE"] : ["UPDATE_IN_PROGRESS", "UPDATE_COMPLETE"]));
    const index = a.canceled ? a.cancelPolls++ : a.polls++;
    a.stack.status = sequence[Math.min(index, sequence.length - 1)];
    if (b.touchKillAtPoll !== undefined && !a.canceled && index === b.touchKillAtPoll) fs.writeFileSync(b.killPath, "stop");
    save();
  }
  process.stdout.write(JSON.stringify({ Stacks: [{
    StackId: b.describedStackId || a.stack.id, StackName: arg("--stack-name"), StackStatus: a.stack.status, EnableTerminationProtection: a.stack.protection,
    CreationTime: a.stack.created, LastUpdatedTime: b.stackUpdated || a.stack.updated, ...(b.stackRoleArn ? { RoleARN: b.stackRoleArn } : {}), Outputs: [{ OutputKey: "Secret", OutputValue: ${JSON.stringify(OUTPUT_CANARY)} }],
  }] }));
}
else if (cmd === "create-change-set") {
  log({});
  const template = fs.readFileSync(path.resolve(process.cwd(), arg("--template-body").slice(7)), "utf8");
  const at = args.indexOf("--capabilities");
  const capabilities = []; if (at >= 0) for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) capabilities.push(args[i]);
  if (/"AWS::IAM::/.test(template) && !capabilities.some((c) => c === "CAPABILITY_IAM" || c === "CAPABILITY_NAMED_IAM")) {
    fail("An error occurred (InsufficientCapabilitiesException) when calling the CreateChangeSet operation: requires capabilities " + (b.failStderr || ""));
  }
  const type = arg("--change-set-type"), name = arg("--stack-name");
  if (type === "CREATE") {
    if (a.stack && a.stack.status !== "REVIEW_IN_PROGRESS") fail("An error occurred (AlreadyExistsException) when calling the CreateChangeSet operation: exists");
    if (!a.stack) a.stack = { id: stackArn(name), status: "REVIEW_IN_PROGRESS", protection: false, created: "2026-10-11T11:30:00.000Z", updated: undefined };
  } else if (!a.stack) fail("An error occurred (ValidationError) when calling the CreateChangeSet operation: Stack does not exist");
  const csName = arg("--change-set-name");
  a.changeSet = { id: "arn:aws:cloudformation:" + region + ":" + (b.arnAccount || account) + ":changeSet/" + csName + "/" + crypto.randomUUID(), name: csName, stackId: a.stack.id, stackName: name, capabilities, template: JSON.parse(template) };
  a.type = type; a.executing = false; a.attempted = false;
  save();
  process.stdout.write(JSON.stringify({ Id: a.changeSet.id, StackId: a.stack.id }));
}
else if (cmd === "wait") { log({}); if (b.waitFails) fail("Waiter ChangeSetCreateComplete failed", 255); }
else if (cmd === "describe-change-set") {
  log({});
  if (!a.changeSet || arg("--change-set-name") !== a.changeSet.id) fail("An error occurred (ChangeSetNotFound) when calling the DescribeChangeSet operation");
  if (b.changeSetReadFailsAfterExecute && a.attempted) fail("An error occurred (Throttling) when calling the DescribeChangeSet operation", 255);
  if (b.describeGarbage) { process.stdout.write("[]"); process.exit(0); }
  const changes = [
    { Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: "PilotBucket", ResourceType: "AWS::S3::Bucket" } },
    { Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "PilotTopic", ResourceType: "AWS::SNS::Topic", Replacement: "True" } },
    ...(b.extraChange ? [{ Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: "ExtraQueue", ResourceType: "AWS::SQS::Queue" } }] : []),
    ...(b.badChange === "unreadable" ? [{ Type: "Hook" }] : []),
    ...(b.badChange === "action" ? [{ Type: "Resource", ResourceChange: { Action: "Teleport", LogicalResourceId: "Odd", ResourceType: "AWS::SQS::Queue" } }] : []),
  ];
  // What the change set reports about its execution follows the stack the fake last described.
  const execution = !a.executing ? "AVAILABLE" : /ROLLBACK|FAILED/.test(a.stack.status) ? "EXECUTE_FAILED" : /_COMPLETE$/.test(a.stack.status) ? "EXECUTE_COMPLETE" : "EXECUTE_IN_PROGRESS";
  process.stdout.write(JSON.stringify({
    ChangeSetName: a.changeSet.name, ChangeSetId: b.swapChangeSetId || a.changeSet.id, StackId: b.swapStackId || a.changeSet.stackId, StackName: a.changeSet.stackName,
    Status: b.changeSetStatus || "CREATE_COMPLETE", ExecutionStatus: b.executionStatus || execution,
    Capabilities: b.echoCapabilities || a.changeSet.capabilities, Parameters: [{ ParameterKey: "DbPassword", ParameterValue: "****", ResolvedValue: ${JSON.stringify(PARAMETER_CANARY)} }], Changes: changes,
  }));
}
else if (cmd === "execute-change-set") {
  log({});
  a.attempted = true; save();
  if (b.foreignUpdateOnExecute) { a.stack.updated = "2026-10-11T12:05:00.000Z"; a.stack.status = "UPDATE_COMPLETE"; save(); }
  if (b.executeFail) fail("An error occurred (InvalidChangeSetStatusException) when calling the ExecuteChangeSet operation: " + (b.failStderr || "cannot be executed"));
  if (!a.changeSet || arg("--change-set-name") !== a.changeSet.id) fail("An error occurred (ChangeSetNotFound) when calling the ExecuteChangeSet operation");
  if (b.executeNoop) process.exit(0);
  if (b.executeLost && !b.ranAnyway) fail("Connection was closed before we received a valid response", 255);
  a.executing = true; a.polls = 0; a.canceled = false; a.cancelPolls = 0; a.stack.updated = "2026-10-11T12:00:30.000Z";
  save();
  if (b.executeLost) fail("Connection was closed before we received a valid response", 255);
}
else if (cmd === "get-template") {
  log({});
  if (!a.changeSet || arg("--change-set-name") !== a.changeSet.id) fail("An error occurred (ChangeSetNotFound) when calling the GetTemplate operation");
  process.stdout.write(JSON.stringify({ TemplateBody: b.templateDiffers ? { ...a.changeSet.template, Description: "changed" } : a.changeSet.template, StagesAvailable: ["Original", "Processed"] }));
}
else if (cmd === "describe-stack-events") {
  log({});
  const events = [{ EventId: "e0", ResourceType: "AWS::CloudFormation::Stack", Timestamp: "2026-10-11T11:00:00.000Z", ResourceStatus: "UPDATE_COMPLETE" }];
  if (b.eventsTouched) events.unshift({ EventId: "e1", ResourceType: "AWS::S3::Bucket", LogicalResourceId: "PilotBucket", Timestamp: "2026-10-11T12:01:00.000Z", ResourceStatus: "UPDATE_COMPLETE", ResourceStatusReason: ${JSON.stringify(EVENT_CANARY)} });
  process.stdout.write(JSON.stringify({ StackEvents: events }));
}
else if (cmd === "cancel-update-stack") {
  log({});
  if (!a.stack || a.stack.status !== "UPDATE_IN_PROGRESS") fail("An error occurred (ValidationError) when calling the CancelUpdateStack operation: cannot be canceled");
  a.canceled = true; save();
}
else { log({ unexpected: true }); process.exit(2); }
`;

export const FAKE_AWS_SHA256 = sha(FAKE);

export function installFakeAws(toolDir: string): void {
  writeFileSync(join(toolDir, "aws"), FAKE, { mode: 0o755 });
  chmodSync(join(toolDir, "aws"), 0o755);
}

export function behaveAws(toolDir: string, killPath: string, behavior: AwsBehavior = {}): void {
  writeFileSync(join(toolDir, "behavior.json"), JSON.stringify({ version: AWS_CLI_VERSION, killPath, ...behavior }));
  writeFileSync(join(toolDir, "state.json"), JSON.stringify({ a: {} }));
  rmSync(join(toolDir, "calls.jsonl"), { force: true });
  rmSync(killPath, { force: true });
}

/** Changes the fake's behavior from now on without resetting what it holds: a change after sealing and before applying. */
export function patchAws(toolDir: string, patch: AwsBehavior): void {
  const path = join(toolDir, "behavior.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
}

export type AwsCall = { args: string[]; cwd: string; env: Record<string, string>; unexpected?: true };
export const awsCallsOf = (toolDir: string): AwsCall[] => existsSync(join(toolDir, "calls.jsonl"))
  ? readFileSync(join(toolDir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AwsCall)
  : [];
/** The CloudFormation subcommand of each call (or the flag, for `--version`). */
export const subcommandsOf = (calls: AwsCall[]): string[] => calls.map((call) => (call.args[0] === "cloudformation" ? call.args[1] : call.args[0]));

// --- identities ---------------------------------------------------------------------------------

export const CDK_IDENTITIES = ["DISCOVERY", "CHANGESET", "APPLY"] as const;
export const cdkRoleArn = (identity: string, environment: ApplyEnvironment): string =>
  "arn:aws:iam::" + awsTargetOf(environment).account + ":role/alz-" + identity.toLowerCase() + "-" + environment.toLowerCase();
/** The three CDK identities for one environment (each its own role and token file, no static key), plus the operator's own ambient keys (never to reach a child). */
export const cdkIdentityEnv = (environment: ApplyEnvironment): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { HOME: "/home/operator", AWS_ACCESS_KEY_ID: "AKIAFAKEOPERATORKEY00", AWS_SECRET_ACCESS_KEY: "operator-ambient-aws-secret" };
  for (const identity of CDK_IDENTITIES) {
    env["ALZ_" + identity + "_AWS_ROLE_ARN"] = cdkRoleArn(identity, environment);
    env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = "/run/fixture/" + identity.toLowerCase() + "-" + environment.toLowerCase() + "-token";
    env["ALZ_" + identity + "_AWS_REGION"] = AWS_REGION;
  }
  return env;
};

// --- the contract ---------------------------------------------------------------------------------

/** A CDK contract: the AWS provider, the same stack name in every account, and the capabilities each environment may use. */
export const cdkContractJson = (killPath: string, capabilities: string[] = [], over: Record<string, unknown> = {}) => {
  const base = awsContractJson(killPath);
  return {
    ...base, engine: "CDK",
    targets: Object.fromEntries((["DEV", "QA", "PROD"] as const).map((e) => [e, {
      accountId: awsTargetOf(e).account, region: AWS_REGION, backend: STACK, workspace: "default", capabilities,
    }])),
    ...over,
  };
};
export const cdkTargetOf = (environment: ApplyEnvironment): ResolvedTarget => ({ account: awsTargetOf(environment).account, backend: STACK, workspace: "default" });

// --- the cloud assembly ---------------------------------------------------------------------------

export type AssemblyOptions = {
  environment?: string; stackName?: string; terminationProtection?: boolean; templateFile?: string;
  /** Adds a second stack, a file asset other than the template, a docker image asset, an unsupported artifact, or a dependency on another stack. */
  secondStack?: boolean; fileAsset?: boolean; dockerAsset?: boolean; nestedAssembly?: boolean;
  /** Template contents. */
  iam?: boolean; nestedStack?: boolean; importValue?: boolean; padding?: number;
  /** Extra top-level template keys and resources (a Transform, a custom resource, a macro). */
  templateExtra?: Record<string, unknown>; resources?: Record<string, unknown>;
  /** Edits the files before they are written, and replaces files with these exact bytes. */
  mutate?: (files: Record<string, any>) => void; raw?: Record<string, string>;
};

/** Writes a pre-synthesized cloud assembly (cdk.out) the way a synthesis would leave it, and the manifest that binds it. */
export function writeAssembly(root: string, target: ResolvedTarget, options: AssemblyOptions = {}): Project {
  mkdirSync(root, { recursive: true });
  const stackName = options.stackName ?? STACK;
  const templateFile = options.templateFile ?? stackName + ".template.json";
  const template = {
    Description: "Pilot stack fixture " + TEMPLATE_CANARY,
    Parameters: { DbPassword: { Type: "String", NoEcho: true, Default: PARAMETER_CANARY } },
    Resources: {
      PilotBucket: { Type: "AWS::S3::Bucket" },
      PilotTopic: { Type: "AWS::SNS::Topic" },
      ...(options.iam ? { PilotRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: {} } } } : {}),
      ...options.resources,
      ...(options.nestedStack ? { Nested: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://example.invalid/nested.json" } } } : {}),
    },
    ...(options.importValue ? { Outputs: { Imported: { Value: { "Fn::ImportValue": "other-stack-export" } } } } : {}),
    ...(options.padding ? { Metadata: { Padding: "x".repeat(options.padding) } } : {}),
    ...options.templateExtra,
  };
  const files: Record<string, unknown> = { [templateFile]: template };
  const artifacts: Record<string, unknown> = {
    [stackName]: {
      type: "aws:cloudformation:stack", environment: options.environment ?? "aws://unknown-account/unknown-region",
      properties: { templateFile, stackName, terminationProtection: options.terminationProtection ?? true },
      dependencies: [stackName + ".assets"],
    },
    [stackName + ".assets"]: { type: "cdk:asset-manifest", properties: { file: stackName + ".assets.json" } },
    Tree: { type: "cdk:tree", properties: { file: "tree.json" } },
  };
  files[stackName + ".assets.json"] = {
    version: "36.0.0",
    files: {
      template0: { source: { path: templateFile, packaging: "file" }, destinations: { current: { bucketName: "bootstrap-bucket", objectKey: "template0.json" } } },
      ...(options.fileAsset ? { asset1: { source: { path: "asset.lambda", packaging: "zip" }, destinations: {} } } : {}),
    },
    ...(options.dockerAsset ? { dockerImages: { image1: { source: { directory: "asset.image" }, destinations: {} } } } : {}),
  };
  if (options.secondStack) {
    artifacts.OtherStack = { type: "aws:cloudformation:stack", environment: "aws://unknown-account/unknown-region", properties: { templateFile: "OtherStack.template.json", stackName: "OtherStack", terminationProtection: true } };
    files["OtherStack.template.json"] = { Resources: {} };
  }
  if (options.nestedAssembly) artifacts.Nested = { type: "cdk:cloud-assembly", properties: { directoryName: "assembly-nested" } };
  files["tree.json"] = { version: "tree-0.1", tree: { id: "App" } };
  files["manifest.json"] = { version: "36.0.0", artifacts };
  files["cdk.out"] = { version: "36.0.0" };
  options.mutate?.(files);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), options.raw?.[name] ?? JSON.stringify(content));
  const resolved: Project["resolved"] = { engineVersion: AWS_CLI_VERSION, providers: [], lockFileSha256: undefined, dependencies: [], inputs: [] };
  const manifest = buildManifest({
    engine: "CDK", mode: "PROJECT", target, unitHash: H("1"), files: captureProjectFiles(root), policyVersion: POLICY, ...resolved,
  });
  return { projectRoot: root, manifest, resolved };
}

// --- qualification ---------------------------------------------------------------------------------

/**
 * TEST FIXTURE. FORGES qualification evidence for the CDK engine, as `testFixtureForgeQualificationEvidence` does for
 * Terraform: it attests `realEngine` and `backendIdentitySeparated` without any real AWS CLI run or cloud-log check. It
 * lives under test/, which nothing in src/ imports. `only` leaves the other adapter unqualified.
 */
export async function forgeCdkQualification(vaultDir: string, only?: "apply" | "preview", over: Record<string, unknown> = {}): Promise<void> {
  for (const [kind, adapter] of [["apply", CDK.applyAdapter], ["preview", CDK.previewAdapter()]] as const) {
    if (only !== undefined && only !== kind) continue;
    const written = await writeQualificationEvidence({
      schemaVersion: 1, engine: "CDK", realEngine: true, backendIdentitySeparated: true,
      accountId: AWS_DEV_TARGET.account, region: AWS_REGION, backend: STACK, workspace: "default",
      stateWriteClientId: cdkRoleArn("CHANGESET", "DEV"), applyClientId: cdkRoleArn("APPLY", "DEV"),
      terraformSha256: FAKE_AWS_SHA256, adapterVersion: adapter.adapterVersion, argvDigest: adapter.argvDigest,
      engineVersion: AWS_CLI_VERSION, qualifiedAt: "2026-10-11T00:00:00.000Z", ...over,
    }, AWS, vaultDir);
    if (!written.ok) throw new Error("fixture qualification evidence rejected: " + written.message);
  }
}
