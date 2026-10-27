import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BicepTarget } from "../../src/apply/engines/bicep.js";
import type { PilotUnit } from "../../src/apply/unit.js";
import type { ResolvedTarget } from "../../src/teardown/driver/types.js";
import { buildManifest, type ArtifactManifest } from "../../src/teardown/manifest.js";
import { captureProjectFiles } from "../../src/teardown/snapshot.js";
import { ARM_FEDERATED_TOKEN_CANARY, H, POLICY, sha } from "./apply-fixtures.js";

// Shared by test/apply-bicep. SYNTHETIC: the `az` and `bicep` executables are fakes. Everything built on them pins the engine's
// logic, NOT the behavior of the real Azure CLI, Bicep or Azure Resource Manager (there is no ARM emulator; every response shape
// here follows docs/act-pilot-bicep.md, assumptions A1 to A4). Explicit fake ids only.

export const AZ_VERSION = "2.91.0";
export const TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const SUBSCRIPTION_ID = "22222222-2222-4222-8222-222222222222";
export const RESOURCE_GROUP = "alz-pilot-dev";
export const STACK_NAME = "alz-pilot-stack";
export const VNET = "alz-pilot-vnet";
export const VNET_ID = "/subscriptions/" + SUBSCRIPTION_ID + "/resourceGroups/" + RESOURCE_GROUP + "/providers/Microsoft.Network/virtualNetworks/" + VNET;
export const TEMPLATE_CANARY = "CANARY_TEMPLATE_VALUE_b1";
export const STDERR_CANARY = "CANARY_STDERR_b2";
export const APPLY_TOKEN_CANARY = "eyJ.CANARY_APPLY_FEDERATED_TOKEN_b3";
export { ARM_FEDERATED_TOKEN_CANARY };
export const CLIENTS = { DISCOVERY: "aaaaaaaa-0000-4000-8000-00000000d15c", APPLY: "bbbbbbbb-0000-4000-8000-0000000a9971" } as const;

export const TARGET: BicepTarget = { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP };
export const RESOLVED: ResolvedTarget = { account: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default" };
export const UNIT: PilotUnit = {
  unitId: "alz-unit-0123456789abcdef", buildId: "alz-pilot-dev-0123456789ab",
  tags: { "alz-managed-by": "alz", "alz-unit": "alz-unit-0123456789abcdef", "alz-build": "alz-pilot-dev-0123456789ab" },
};

export type AzBehavior = {
  version?: string; bicepVersion?: string;
  /** bicep prints this instead of compiling main.bicep (a compiler that no longer gives the sealed bytes). */
  bicepOutput?: string;
  loginFail?: boolean;
  /** az account show reports another tenant, or another client id for this identity. */
  accountTenant?: string; accountClient?: Partial<Record<"DISCOVERY" | "APPLY", string>>;
  groupMissing?: boolean;
  /** what-if: a failed status, an unsupported change, an extra change elsewhere, these names already existing (not managed). */
  whatIfStatus?: string; whatIfUnsupported?: boolean; whatIfForeignChange?: boolean; preexisting?: string[];
  /** The stack as read: these deny settings, these failed resources, these tags. */
  denyMode?: string; excludedPrincipals?: string[]; failedResources?: number; stackTags?: Record<string, string>;
  /** States the stack reports after a create, one per look (the last repeats). */
  pollStates?: string[];
  createFail?: boolean; deleteFail?: boolean;
  /** The delete fails the way an az transport error does: exit 1 with no ARM error code, and the stack left as it was. */
  deleteLost?: boolean;
  /** The create (or delete) reaches ARM, then az hangs for this long (a timeout kills it) or prints this many bytes (the output cap). */
  createSleepMs?: number; createOutputBytes?: number; deleteSleepMs?: number; deleteOutputBytes?: number;
  /** The create reaches ARM but az exits 1 (a lost response); the stack shows only after this many reads. */
  createLostAppearAfter?: number;
  /** Creates the kill file at the n-th look after the create (0-based). */
  touchKillAtPoll?: number; killPath?: string;
  /** The stack is changed out of band at the next look. */
  bumpStack?: boolean;
  failStderr?: string;
};

const FAKE_AZ = `#!${process.execPath}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const stateFile = path.join(dir, "state.json");
const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const args = process.argv.slice(2);
const configDir = process.env.AZURE_CONFIG_DIR || "";
const who = /az-discovery$/.test(configDir) ? "DISCOVERY" : /az-apply$/.test(configDir) ? "APPLY" : "NONE";
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, who, env: process.env }) + "\\n");
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const fail = (message, code = 1) => { process.stderr.write(message + (b.failStderr ? " " + b.failStderr : "")); process.exit(code); };
const out = (value) => process.stdout.write(JSON.stringify(value));
const cmd = args.slice(0, 3).join(" ");
const rg = "/subscriptions/" + ${JSON.stringify(SUBSCRIPTION_ID)} + "/resourceGroups/" + ${JSON.stringify(RESOURCE_GROUP)};
const vnetId = (name) => rg + "/providers/Microsoft.Network/virtualNetworks/" + name;
const resourcesOf = (text) => { const t = JSON.parse(text); return (Array.isArray(t.resources) ? t.resources : Object.values(t.resources || {})); };
if (args[0] === "version") { out({ "azure-cli": b.version, "azure-cli-core": b.version, extensions: {} }); process.exit(0); }
if (args[0] === "login") {
  if (b.loginFail) fail("AADSTS70021: No matching federated identity record found.");
  const token = arg("--federated-token");
  if (!token || token[0] !== "@" || !fs.existsSync(token.slice(1))) fail("bad token argument");
  fs.writeFileSync(path.join(configDir, "login.json"), JSON.stringify({ username: arg("--username"), tenant: arg("--tenant") }));
  process.exit(0);
}
if (!fs.existsSync(path.join(configDir, "login.json"))) fail("Please run 'az login' to setup account.");
const login = JSON.parse(fs.readFileSync(path.join(configDir, "login.json"), "utf8"));
if (cmd === "account show --subscription") {
  out({ id: arg("--subscription"), tenantId: b.accountTenant || login.tenant, user: { name: (b.accountClient || {})[who] || login.username, type: "servicePrincipal" } });
  process.exit(0);
}
if (args[0] === "group" && args[1] === "show") {
  if (b.groupMissing) fail("(ResourceGroupNotFound) Resource group '" + arg("--name") + "' could not be found.", 3);
  out({ id: rg, name: arg("--name"), location: "eastus2", properties: { provisioningState: "Succeeded" } });
  process.exit(0);
}
const stackView = () => ({
  id: rg + "/providers/Microsoft.Resources/deploymentStacks/" + s.stack.name, name: s.stack.name, provisioningState: s.stack.state, deploymentId: s.stack.deploymentId,
  systemData: { lastModifiedAt: s.stack.lastModified }, tags: b.stackTags || s.stack.tags,
  denySettings: { mode: b.denyMode || s.stack.denyMode, applyToChildScopes: s.stack.childScopes, excludedPrincipals: b.excludedPrincipals || [], excludedActions: [] },
  actionOnUnmanage: { resources: "delete", resourceGroups: "detach", managementGroups: "detach" },
  resources: s.stack.resources.map((id) => ({ id, status: "managed", denyStatus: "denyWriteAndDelete" })),
  failedResources: Array.from({ length: b.failedResources || 0 }, (_, i) => ({ id: rg + "/failed/" + i })),
  outputs: { secret: ${JSON.stringify(TEMPLATE_CANARY)} },
});
const hang = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (cmd === "stack group show" && s.late) {
  if (s.lateReads++ >= s.late.after) { s.stack = s.late.stack; s.late = null; s.creating = true; s.polls = 0; }
  save();
}
if (cmd === "stack group show") {
  if (!s.stack) fail("(DeploymentStackNotFound) The deployment stack '" + arg("--name") + "' could not be found.", 3);
  if (s.creating) {
    const sequence = b.pollStates || ["deploying", "succeeded"];
    const index = s.polls++;
    s.stack.state = sequence[Math.min(index, sequence.length - 1)];
    if (s.stack.state === "succeeded") { s.stack.resources = s.pending; s.stack.template = s.pendingTemplate; s.creating = false; }
    if (b.touchKillAtPoll === index) fs.writeFileSync(b.killPath, "stop");
  }
  if (b.bumpStack && !s.bumped) { s.bumped = true; s.stack.lastModified = "2026-10-27T15:59:00Z"; }
  save();
  out(stackView());
  process.exit(0);
}
if (cmd === "deployment group what-if") {
  const text = fs.readFileSync(arg("--template-file"), "utf8");
  const managed = s.stack ? s.stack.resources : [];
  const changes = [];
  const declared = new Set();
  for (const resource of resourcesOf(text)) {
    const id = vnetId(resource.name);
    declared.add(id);
    const exists = managed.includes(id) || (b.preexisting || []).includes(resource.name);
    const same = managed.includes(id) && s.stack.template === text;
    changes.push({ resourceId: id, changeType: b.whatIfUnsupported ? "Unsupported" : !exists ? "Create" : same ? "NoChange" : "Modify",
      after: { type: resource.type, name: resource.name, tags: resource.tags, properties: { secret: ${JSON.stringify(TEMPLATE_CANARY)} } } });
  }
  for (const id of managed) if (!declared.has(id)) changes.push({ resourceId: id, changeType: "Ignore" });
  if (b.whatIfForeignChange) changes.push({ resourceId: "/subscriptions/" + ${JSON.stringify(SUBSCRIPTION_ID)} + "/resourceGroups/other-rg/providers/Microsoft.Network/virtualNetworks/x", changeType: "Create", after: { tags: {} } });
  out({ status: b.whatIfStatus || "Succeeded", error: null, changes });
  process.exit(0);
}
if (cmd === "stack group create") {
  if (b.createFail) fail("(DeploymentStackValidationFailed) refused " + ${JSON.stringify(TEMPLATE_CANARY)});
  const text = fs.readFileSync(arg("--template-file"), "utf8");
  const at = args.indexOf("--tags");
  const tags = {}; for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) { const [k, ...v] = args[i].split("="); tags[k] = v.join("="); }
  const existing = s.stack;
  const created = { name: arg("--name"), state: "deploying", deploymentId: crypto.randomUUID(), lastModified: "2026-10-27T16:00:0" + (s.creates = (s.creates || 0) + 1) + "Z",
    tags, denyMode: arg("--deny-settings-mode"), childScopes: args.includes("--deny-settings-apply-to-child-scopes"),
    resources: existing ? existing.resources : [], template: existing ? existing.template : undefined };
  s.pending = resourcesOf(text).map((r) => vnetId(r.name)); s.pendingTemplate = text;
  if (b.createLostAppearAfter !== undefined) { s.late = { stack: created, after: b.createLostAppearAfter }; s.lateReads = 0; save(); fail("Connection was closed before we received a valid response", 1); }
  s.stack = created; s.creating = true; s.polls = 0;
  save();
  if (b.createOutputBytes) process.stdout.write("x".repeat(b.createOutputBytes));
  if (b.createSleepMs) hang(b.createSleepMs);
  process.exit(0);
}
if (cmd === "stack group delete") {
  if (b.deleteFail) fail("(DeploymentStackDeleteFailed) refused");
  if (b.deleteLost) fail("Connection was closed before we received a valid response", 1);
  if (!s.stack) fail("DeploymentStack not found", 3);
  if (b.deleteOutputBytes) { process.stdout.write("x".repeat(b.deleteOutputBytes)); process.exit(1); }
  s.stack = null; s.deleted = true; save();
  if (b.deleteSleepMs) hang(b.deleteSleepMs);
  process.exit(0);
}
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ unexpected: true, args }) + "\\n");
process.exit(2);
`;

const FAKE_BICEP = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const b = JSON.parse(fs.readFileSync(path.join(__dirname, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ bicep: true, args, env: process.env }) + "\\n");
if (args[0] === "--version") { process.stdout.write("Bicep CLI version " + b.bicepVersion + " (cec7951cf6)\\n"); process.exit(0); }
if (args[0] === "build" && args[2] === "--stdout") {
  // The fake compiler is the identity: a test project's main.bicep holds the ARM JSON a real build would print.
  process.stdout.write(b.bicepOutput !== undefined ? b.bicepOutput : fs.readFileSync(path.join(process.cwd(), args[1]), "utf8"));
  process.exit(0);
}
process.exit(2);
`;

export const FAKE_AZ_SHA256 = sha(FAKE_AZ);

export function installFakes(toolDir: string): void {
  mkdirSync(toolDir, { recursive: true });
  for (const [name, body] of [["az", FAKE_AZ], ["bicep", FAKE_BICEP]] as const) {
    writeFileSync(join(toolDir, name), body, { mode: 0o755 });
    chmodSync(join(toolDir, name), 0o755);
  }
}

export function behave(toolDir: string, bicepVersion: string, behavior: AzBehavior = {}): void {
  writeFileSync(join(toolDir, "behavior.json"), JSON.stringify({ version: AZ_VERSION, bicepVersion, ...behavior }));
  writeFileSync(join(toolDir, "state.json"), JSON.stringify({ stack: null }));
  rmSync(join(toolDir, "calls.jsonl"), { force: true });
  if (behavior.killPath) rmSync(behavior.killPath, { force: true });
}

/** Changes the fake's behavior from now on without resetting what it holds. */
export function patch(toolDir: string, change: AzBehavior): void {
  const path = join(toolDir, "behavior.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...change }));
}

export type AzCall = { args: string[]; who?: string; bicep?: true; env: Record<string, string>; unexpected?: true };
export const callsOf = (toolDir: string): AzCall[] => existsSync(join(toolDir, "calls.jsonl"))
  ? readFileSync(join(toolDir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AzCall)
  : [];
export const stateOf = (toolDir: string): { stack: null | { resources: string[]; tags: Record<string, string>; denyMode: string; childScopes: boolean }; deleted?: boolean } =>
  JSON.parse(readFileSync(join(toolDir, "state.json"), "utf8"));

/** The two identities, configured as the Azure Terraform identities are, each with its own token file; plus the operator's own ambient credential. */
export function identityEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: "/home/operator", AZURE_CLIENT_SECRET: "operator-ambient-azure-secret", ARM_CLIENT_ID: "operator-client" };
  for (const who of ["DISCOVERY", "APPLY"] as const) {
    const token = join(root, who.toLowerCase() + "-token");
    // DISCOVERY's token is the one the fake ARM token endpoint accepts (the independent reader exchanges it); both are canaries for argv.
    writeFileSync(token, who === "DISCOVERY" ? ARM_FEDERATED_TOKEN_CANARY : APPLY_TOKEN_CANARY, { mode: 0o600 });
    env["ALZ_" + who + "_ARM_CLIENT_ID"] = CLIENTS[who];
    env["ALZ_" + who + "_ARM_TENANT_ID"] = TENANT_ID;
    env["ALZ_" + who + "_ARM_SUBSCRIPTION_ID"] = SUBSCRIPTION_ID;
    env["ALZ_" + who + "_ARM_USE_OIDC"] = "true";
    env["ALZ_" + who + "_ARM_OIDC_TOKEN_FILE"] = token;
  }
  return env;
}

/** The ARM JSON a Bicep build of one tagged virtual network prints (UNVERIFIED (A4): the shape is hand-written). */
export function vnetTemplate(options: { tags?: Record<string, string>; resources?: unknown[]; schema?: string; addressPrefix?: string } = {}): string {
  return JSON.stringify({
    $schema: options.schema ?? "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    metadata: { _generator: { name: "bicep", version: "0.47.16.0", templateHash: "0" }, note: TEMPLATE_CANARY },
    parameters: { location: { type: "string", defaultValue: "[resourceGroup().location]" } },
    resources: options.resources ?? [{
      type: "Microsoft.Network/virtualNetworks", apiVersion: "2024-05-01", name: VNET, location: "[parameters('location')]",
      tags: options.tags ?? UNIT.tags, properties: { addressSpace: { addressPrefixes: [options.addressPrefix ?? "10.250.0.0/24"] } },
    }],
  }, null, 2) + "\n";
}

/** A project: `main.bicep` (for the fake compiler, the ARM JSON itself) and its manifest. */
export function writeBicepProject(root: string, template: string = vnetTemplate()): { projectRoot: string; manifest: ArtifactManifest } {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "main.bicep"), template);
  const manifest = buildManifest({
    engine: "BICEP", mode: "PROJECT", target: RESOLVED, unitHash: H("1"), files: captureProjectFiles(root), policyVersion: POLICY,
    engineVersion: AZ_VERSION, providers: [], lockFileSha256: undefined, dependencies: [], inputs: [],
  });
  return { projectRoot: root, manifest };
}
