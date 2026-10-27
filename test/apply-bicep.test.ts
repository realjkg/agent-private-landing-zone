import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codeOf } from "../src/apply/engine.js";
import { engineSpec } from "../src/apply/engine-spec.js";
import { AZ_STACK_PROFILE, BICEP, DENY_SETTINGS_MODE, checkTemplate, isAllowedBicepArgv, pinnedBicepVersion } from "../src/apply/engines/bicep.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { loadToolPins } from "../src/deps/pins.js";
import { createDiscoveryArmReader } from "../src/observe/azure-rest.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { fakeArmHttp } from "./helpers/apply-fixtures.js";
import {
  APPLY_TOKEN_CANARY, ARM_FEDERATED_TOKEN_CANARY, AZ_VERSION, CLIENTS, RESOLVED, RESOURCE_GROUP, STACK_NAME, STDERR_CANARY, SUBSCRIPTION_ID, TARGET, TEMPLATE_CANARY, UNIT, VNET, VNET_ID,
  behave, callsOf, identityEnv, installFakes, patch, stateOf, vnetTemplate, writeBicepProject, type AzBehavior,
} from "./helpers/bicep-fixtures.js";

// SYNTHETIC. The path 4 engine (docs/act-pilot-bicep.md) driven step by step with a fake `az` and `bicep`. The engine is not
// registered until the authorization lane admits the BICEP engine id, so these tests call its steps directly; the driver, ledger,
// approvals and evidence around them are the shared modules, tested for the other engines. Nothing here is provider qualification.

const root = mkdtempSync(join(tmpdir(), "alz-bicep-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
const toolDir = join(root, "bin");
installFakes(toolDir);
const KILL = join(root, "kill-switch");
const PIN = pinnedBicepVersion();
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + counter++); mkdirSync(dir, { recursive: true }); return dir; };
const calls = () => callsOf(toolDir);
const azCalls = () => calls().filter((call) => !call.bicep);
const sub = (call: { args: string[] }) => call.args.slice(0, 3).join(" ");
const refusedWith = (code: string) => (error: unknown) => { assert.equal(codeOf(error), code); return true; };
const control = (over: Partial<{ stopWhen: () => boolean; pollMs: number }> = {}) => ({ stopWhen: () => existsSync(KILL), pollMs: 1, graceMs: 50, ...over });

type World = { project: ReturnType<typeof writeBicepProject>; env: NodeJS.ProcessEnv };
function world(behavior: AzBehavior = {}, template?: string, env?: NodeJS.ProcessEnv): World {
  behave(toolDir, PIN, { killPath: KILL, ...behavior });
  rmSync(KILL, { force: true });
  return { project: writeBicepProject(fresh("project"), template), env: env ?? identityEnv(fresh("tokens")) };
}
const input = (w: World, scratchDir = fresh("scratch")) => ({
  scratchDir, env: w.env, toolDirs: [toolDir], manifest: w.project.manifest, pinned: TARGET, spec: AZURE, target: RESOLVED, engineVersion: AZ_VERSION,
});
function withSnapshot<T>(w: World, use: (path: string) => T): T {
  const snapshot = createImmutableSnapshot(w.project.projectRoot, w.project.manifest, fresh("snapshot"));
  try { return use(snapshot.path); } finally { snapshot.remove(); }
}
const seal = (w: World) => withSnapshot(w, (snapshotPath) => BICEP.plan({ ...input(w), snapshotPath, unit: UNIT }));

async function apply(w: World, artifact: Buffer, stop = control()) {
  const scratch = fresh("apply");
  const snapshot = createImmutableSnapshot(w.project.projectRoot, w.project.manifest, fresh("snapshot"));
  const run = BICEP.openApply(input(w, scratch));
  try {
    run.prepare(snapshot.path);
    const changes = run.rederive(artifact);
    const result = await run.execute(artifact, stop);
    const end = result.notStarted ? undefined : await run.settle(result);
    return { run, changes, result, end, scratch };
  } finally {
    run.removeSecrets();
    snapshot.remove();
  }
}

// --- the argument allowlist ----------------------------------------------------------------------------------------

test("the allowlist admits exactly the engine's own az and bicep lists, each for its identity and adapter, and nothing that widens the deployment", () => {
  const create = ["stack", "group", "create", "--name", STACK_NAME, "--resource-group", RESOURCE_GROUP, "--template-file", "/scratch/template/alz-template.json",
    "--deny-settings-mode", DENY_SETTINGS_MODE, "--deny-settings-apply-to-child-scopes", "--action-on-unmanage", "deleteResources",
    "--tags", "alz-build=alz-pilot-dev-0123456789ab", "alz-managed-by=alz", "alz-unit=alz-unit-0123456789abcdef", "--yes", "--no-wait", "--subscription", SUBSCRIPTION_ID, "--output", "none"];
  assert.equal(isAllowedBicepArgv("az", "APPLY", create, "apply"), true);
  assert.equal(isAllowedBicepArgv("az", "DISCOVERY", create, "apply"), false, "only APPLY creates a stack");
  assert.equal(isAllowedBicepArgv("az", "APPLY", create, "preview"), false, "sealing never creates");
  const swap = (from: string, to: string) => create.map((arg) => (arg === from ? to : arg));
  for (const [from, to] of [[DENY_SETTINGS_MODE, "none"], [DENY_SETTINGS_MODE, "denyDelete"], ["deleteResources", "deleteAll"], ["deleteResources", "detachAll"], ["alz-managed-by=alz", "alz-unit=alz-unit-0123456789abcdef"]]) {
    assert.equal(isAllowedBicepArgv("az", "APPLY", swap(from, to), "apply"), false, from + " -> " + to);
  }
  assert.equal(isAllowedBicepArgv("az", "APPLY", [...create.slice(0, -2), "--parameters", "@params.json", "--output", "none"], "apply"), false, "no parameters");
  assert.equal(isAllowedBicepArgv("az", "APPLY", create.filter((arg) => arg !== "--deny-settings-apply-to-child-scopes"), "apply"), false);
  assert.equal(isAllowedBicepArgv("az", "APPLY", swap(RESOURCE_GROUP, "@/etc/passwd"), "apply"), false, "an @ outside the token slot would make az read a file");
  const del = ["stack", "group", "delete", "--name", STACK_NAME, "--resource-group", RESOURCE_GROUP, "--action-on-unmanage", "deleteResources", "--yes", "--subscription", SUBSCRIPTION_ID, "--output", "none"];
  assert.equal(isAllowedBicepArgv("az", "APPLY", del, "cleanup"), true);
  assert.equal(isAllowedBicepArgv("az", "APPLY", del, "apply"), false, "an apply never deletes");
  assert.equal(isAllowedBicepArgv("az", "APPLY", del.map((arg) => (arg === "deleteResources" ? "deleteAll" : arg)), "cleanup"), false, "the group is never deleted with the stack");
  for (const args of [["group", "create", "--name", RESOURCE_GROUP, "--location", "eastus2"], ["group", "delete", "--name", RESOURCE_GROUP, "--yes"], ["provider", "register", "--namespace", "Microsoft.Network"],
    ["deployment", "group", "create", "--resource-group", RESOURCE_GROUP, "--template-file", "/scratch/template/alz-template.json"], ["stack-whatif", "group", "create"]]) {
    for (const who of ["DISCOVERY", "APPLY", null] as const) assert.equal(isAllowedBicepArgv("az", who, args), false, args.join(" "));
  }
  const login = (token: string) => ["login", "--service-principal", "--username", CLIENTS.APPLY, "--tenant", TARGET.tenantId, "--federated-token", token, "--output", "none"];
  assert.equal(isAllowedBicepArgv("az", "APPLY", login("@/run/token")), true);
  assert.equal(isAllowedBicepArgv("az", "APPLY", login("eyJ.raw-token")), false, "a token is never an argument; only its file");
  assert.equal(isAllowedBicepArgv("az", "APPLY", login("@/run/../etc/token")), false);
  assert.equal(isAllowedBicepArgv("bicep", null, ["build", "main.bicep", "--stdout", "--no-restore"]), true);
  assert.equal(isAllowedBicepArgv("bicep", null, ["build", "main.bicep", "--stdout"]), false, "a build always skips module restore");
  assert.equal(isAllowedBicepArgv("bicep", "APPLY", ["build", "main.bicep", "--stdout", "--no-restore"]), false, "the compiler gets no identity");
  assert.equal(AZ_STACK_PROFILE.injectable.join(), "AZURE_CONFIG_DIR", "az receives only its private sign-in directory");
});

test("the spec: two identities, three adapters with their own argument digests, never registered until the engine id is admitted", () => {
  assert.equal(BICEP.id, "BICEP");
  assert.deepEqual([...BICEP.identities], ["DISCOVERY", "APPLY"]);
  assert.deepEqual([...BICEP.attests], ["DISCOVERY", "APPLY"]);
  assert.deepEqual([...BICEP.providers], ["AZURE"]);
  const digests = [BICEP.previewAdapter(), BICEP.applyAdapter, BICEP.cleanupAdapter!].map((adapter) => adapter.argvDigest);
  assert.equal(new Set(digests).size, 3);
  assert.ok([BICEP.previewAdapter(), BICEP.applyAdapter, BICEP.cleanupAdapter!].every((adapter) => adapter.engine === "BICEP"));
  assert.equal(engineSpec("BICEP"), undefined, "a contract naming BICEP is still not a contract (ACT stays DISABLED for this path)");
  assert.equal(BICEP.target!.fields.resourceGroup(RESOURCE_GROUP), true);
  assert.equal(BICEP.target!.fields.resourceGroup("bad/group"), false);
  assert.equal(PIN, loadToolPins().bicep.version);
});

// --- sealing --------------------------------------------------------------------------------------------------------

test("seal: compiles with the pinned bicep, runs the what-if as DISCOVERY, creates nothing, and binds the exact template", () => {
  const w = world();
  const sealed = seal(w);
  assert.deepEqual(sealed.changes, [{ address: VNET_ID, type: "Microsoft.Network/virtualNetworks", action: "CREATE" }]);
  assert.deepEqual(sealed.unit, { unitId: UNIT.unitId, tags: UNIT.tags, untagged: [] });
  const record = JSON.parse(sealed.artifact.toString("utf8"));
  assert.equal(record.kind, "AZURE_DEPLOYMENT_STACK");
  assert.equal(record.template, vnetTemplate(), "the artifact holds the compiled bytes");
  assert.equal(record.denySettingsMode, DENY_SETTINGS_MODE);
  assert.equal(record.actionOnUnmanage, "deleteResources");
  assert.deepEqual([record.resourceGroup, record.stackName], [RESOURCE_GROUP, STACK_NAME]);
  const az = azCalls();
  assert.ok(!az.some((call) => call.args[0] === "stack" && call.args[2] !== "show"), "no stack is created or deleted while sealing");
  assert.equal(az.find((call) => sub(call) === "deployment group what-if")?.who, "DISCOVERY");
  assert.ok(az.filter((call) => call.args[0] !== "version" && call.args[0] !== "login").every((call) => call.args.includes("--subscription")));
  assert.ok(!az.some((call) => call.unexpected));
  assert.equal(stateOf(toolDir).stack, null);
});

test("seal: no credential reaches an argument list or a child's environment; each az child holds only its identity's private directory, and the compiler none", () => {
  const w = world();
  seal(w);
  for (const call of calls()) {
    const text = JSON.stringify(call);
    for (const secret of [ARM_FEDERATED_TOKEN_CANARY, APPLY_TOKEN_CANARY, "operator-ambient-azure-secret", "operator-client"]) assert.ok(!text.includes(secret), secret + " reached " + call.args.join(" "));
    assert.ok(!Object.keys(call.env).some((key) => /^(ARM_|AZURE_CLIENT|ALZ_)/.test(key)), "no ARM_, AZURE_CLIENT_ or ALZ_ variable in a child: " + call.args.join(" "));
    if (call.bicep) assert.equal(call.env.AZURE_CONFIG_DIR, undefined);
    else if (call.args[0] !== "version") assert.match(call.env.AZURE_CONFIG_DIR, call.who === "APPLY" ? /az-apply$/ : /az-discovery$/);
  }
  const logins = azCalls().filter((call) => call.args[0] === "login");
  assert.deepEqual(logins.map((call) => call.who), ["DISCOVERY", "APPLY"]);
  assert.ok(logins.every((call) => call.args[call.args.indexOf("--federated-token") + 1].startsWith("@/")), "az reads the token from its file");
});

test("seal refuses anything outside the minimal workload, the contract or the pins, before any stack exists", () => {
  const refusals: Array<[string, AzBehavior, string | undefined, NodeJS.ProcessEnv | undefined]> = [
    ["RESOURCE_TYPE_NOT_ALLOWED", {}, vnetTemplate({ resources: [{ type: "Microsoft.Storage/storageAccounts", name: "x", tags: UNIT.tags }] }), undefined],
    ["RESOURCE_TYPE_NOT_ALLOWED", {}, vnetTemplate({ resources: [{ type: "Microsoft.Resources/resourceGroups", name: "rg2", tags: UNIT.tags }] }), undefined],
    ["RESOURCE_TYPE_NOT_ALLOWED", {}, vnetTemplate({ resources: [{ type: "Microsoft.Resources/deployments", name: "module", properties: { template: {} } }] }), undefined],
    ["TEMPLATE_SHAPE_NOT_ALLOWED", {}, vnetTemplate({ schema: "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#" }), undefined],
    ["TEMPLATE_SHAPE_NOT_ALLOWED", {}, vnetTemplate({ resources: [{ type: "Microsoft.Network/virtualNetworks", name: VNET, existing: true }] }), undefined],
    ["UNIT_TAG_MISSING", {}, vnetTemplate({ tags: { "alz-managed-by": "alz" } }), undefined],
    ["RESOURCE_PREEXISTS", { preexisting: [VNET] }, undefined, undefined],
    ["RESOURCE_GROUP_NOT_FOUND", { groupMissing: true }, undefined, undefined],
    ["WHATIF_NOT_IN_CONTRACT", { whatIfForeignChange: true }, undefined, undefined],
    ["WHATIF_UNSUPPORTED_CHANGE", { whatIfUnsupported: true }, undefined, undefined],
    ["WHATIF_FAILED", { whatIfStatus: "Failed" }, undefined, undefined],
    ["BICEP_VERSION_MISMATCH", { bicepVersion: "0.48.1" }, undefined, undefined],
    ["ENGINE_VERSION_MISMATCH", { version: "2.90.0" }, undefined, undefined],
    ["LOGIN_FAILED", { loginFail: true }, undefined, undefined],
    ["ACCOUNT_NOT_IN_CONTRACT", { accountClient: { APPLY: CLIENTS.DISCOVERY } }, undefined, undefined],
    ["ACCOUNT_NOT_IN_CONTRACT", { accountTenant: "99999999-9999-4999-8999-999999999999" }, undefined, undefined],
  ];
  for (const [code, behavior, template, env] of refusals) {
    const w = world(behavior, template, env);
    assert.throws(() => seal(w), refusedWith(code), code + " " + JSON.stringify(behavior));
    assert.ok(!azCalls().some((call) => call.args[0] === "stack" && call.args[2] !== "show"), code);
    assert.equal(stateOf(toolDir).stack, null);
  }
  const base = identityEnv(fresh("tokens"));
  assert.throws(() => seal(world({}, undefined, { ...base, ALZ_APPLY_ARM_CLIENT_ID: CLIENTS.DISCOVERY })), refusedWith("IDENTITY_COLLAPSED"));
  assert.throws(() => seal(world({}, undefined, { ...base, ALZ_APPLY_ARM_CLIENT_SECRET: "a-static-secret-value" })), refusedWith("IDENTITY_VARIABLE_REFUSED"));
  assert.throws(() => seal(world({}, undefined, { ...base, ALZ_APPLY_ARM_SUBSCRIPTION_ID: "99999999-9999-4999-8999-999999999999" })), refusedWith("IDENTITY_TARGET_MISMATCH"));
  assert.throws(() => checkTemplate("not json"), refusedWith("TEMPLATE_UNREADABLE"));
});

// --- applying -------------------------------------------------------------------------------------------------------

test("apply: creates the stack from the sealed bytes only, with deny settings on, the unit's tags and no parameters; the stack's managed resources are the run's", async () => {
  const w = world();
  const sealed = seal(w);
  const { end, changes, run } = await apply(w, sealed.artifact);
  assert.deepEqual(end, { outcome: "SUCCEEDED" });
  assert.deepEqual(changes, sealed.changes);
  const creates = azCalls().filter((call) => sub(call) === "stack group create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].who, "APPLY");
  const args = creates[0].args;
  assert.equal(args[args.indexOf("--deny-settings-mode") + 1], DENY_SETTINGS_MODE);
  assert.ok(args.includes("--deny-settings-apply-to-child-scopes"));
  assert.equal(args[args.indexOf("--action-on-unmanage") + 1], "deleteResources");
  assert.ok(!args.includes("--parameters") && !args.some((arg) => arg.startsWith("--deny-settings-excluded")));
  const stack = stateOf(toolDir).stack!;
  assert.deepEqual(stack.resources, [VNET_ID]);
  assert.deepEqual(stack.tags, UNIT.tags);
  assert.ok(!azCalls().some((call) => call.args[0] === "group" && call.args[1] !== "show"), "the group is never created or deleted");
  assert.deepEqual(run.managedResources(), [VNET_ID], "ownership comes from the stack's managed resources, read as DISCOVERY");
  assert.equal(azCalls().at(-1)!.who, "DISCOVERY");
});

test("apply: a second apply of the same artifact is refused before anything runs, because the first moved the stack", async () => {
  const w = world();
  const sealed = seal(w);
  assert.deepEqual((await apply(w, sealed.artifact)).end, { outcome: "SUCCEEDED" });
  await assert.rejects(apply(w, sealed.artifact), refusedWith("PLAN_STALE"));
  assert.equal(azCalls().filter((call) => sub(call) === "stack group create").length, 1);
});

test("apply: a stale plan is refused, whether the stack changed before the apply prepared or between the rederive and the create", async () => {
  const w = world();
  const sealed = seal(w);
  // A stack appears out of band after the seal (someone else's apply).
  const other = world({}, undefined, w.env);
  const first = seal(other);
  await apply(other, first.artifact);
  await assert.rejects(apply(w, sealed.artifact), refusedWith("PLAN_STALE"));

  const v = world();
  const plan = seal(v);
  const snapshot = createImmutableSnapshot(v.project.projectRoot, v.project.manifest, fresh("snapshot"));
  const run = BICEP.openApply(input(v));
  try {
    run.prepare(snapshot.path);
    run.rederive(plan.artifact);
    // A seal against a stack that already exists, then the stack is changed after the rederive.
    writeFileSync(join(toolDir, "state.json"), JSON.stringify({ stack: { name: STACK_NAME, state: "succeeded", deploymentId: "x", lastModified: "2026-10-27T15:00:00Z", tags: UNIT.tags, denyMode: DENY_SETTINGS_MODE, childScopes: true, resources: [] } }));
    await assert.rejects(run.execute(plan.artifact, control()), refusedWith("PLAN_STALE"));
  } finally { run.removeSecrets(); snapshot.remove(); }
  assert.ok(!azCalls().some((call) => sub(call) === "stack group create"));
});

test("apply: any template change after the seal is refused, by the compiler's output or inside the artifact", async () => {
  const w = world();
  const sealed = seal(w);
  patch(toolDir, { bicepOutput: vnetTemplate({ addressPrefix: "10.251.0.0/24" }) });
  await assert.rejects(apply(w, sealed.artifact), refusedWith("ARTIFACT_TAMPERED"));
  patch(toolDir, { bicepOutput: undefined });
  const record = JSON.parse(sealed.artifact.toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...record, template: vnetTemplate({ addressPrefix: "10.9.0.0/16" }) }));
  await assert.rejects(apply(w, forged), refusedWith("ARTIFACT_TAMPERED"));
  const offTarget = Buffer.from(JSON.stringify({ ...record, resourceGroup: "another-group" }));
  await assert.rejects(apply(w, offTarget), refusedWith("ARTIFACT_TAMPERED"));
  assert.ok(!azCalls().some((call) => sub(call) === "stack group create"));
});

test("apply: deny settings that are off on the stack refuse the next seal and apply", async () => {
  const w = world();
  await apply(w, seal(w).artifact);
  const next = world({}, vnetTemplate({ addressPrefix: "10.251.0.0/24" }), w.env);
  writeFileSync(join(toolDir, "state.json"), JSON.stringify({ stack: { name: STACK_NAME, state: "succeeded", deploymentId: "y", lastModified: "2026-10-27T15:00:00Z", tags: UNIT.tags, denyMode: "none", childScopes: true, resources: [VNET_ID] } }));
  assert.throws(() => seal(next), refusedWith("DENY_SETTINGS_OFF"));
  patch(toolDir, { denyMode: DENY_SETTINGS_MODE, excludedPrincipals: ["00000000-0000-4000-8000-000000000001"] });
  assert.throws(() => seal(next), refusedWith("DENY_SETTINGS_OFF"), "an excluded principal is a way around the deny settings");
});

test("apply: the kill switch before the create stops it from ever running, and the kill switch during the create ends the run as KILLED", async () => {
  const w = world();
  const sealed = seal(w);
  writeFileSync(KILL, "stop");
  const before = await apply(w, sealed.artifact);
  assert.equal(before.result.notStarted, true);
  assert.equal(before.result.stopped, true);
  assert.ok(!azCalls().some((call) => sub(call) === "stack group create"), "nothing was created");
  rmSync(KILL);

  const v = world({ touchKillAtPoll: 0, pollStates: ["deploying", "deploying", "succeeded"] });
  const during = await apply(v, seal(v).artifact);
  assert.deepEqual(during.end, { outcome: "KILLED" });
  assert.equal(azCalls().filter((call) => sub(call) === "stack group create").length, 1, "never retried");
});

test("apply: a refused create is FAILED_NO_CHANGE, a failed stack is PARTIAL_REQUIRES_REVIEW, and neither carries engine text", async () => {
  const w = world({ createFail: true, failStderr: STDERR_CANARY });
  const failed = await apply(w, seal(w).artifact);
  assert.deepEqual(failed.end, { outcome: "FAILED_NO_CHANGE" });
  assert.ok(![STDERR_CANARY, TEMPLATE_CANARY].some((canary) => JSON.stringify(failed.result).includes(canary)));
  const v = world({ pollStates: ["deploying", "failed"] });
  assert.deepEqual((await apply(v, seal(v).artifact)).end, { outcome: "PARTIAL_REQUIRES_REVIEW" });
  const x = world({ failedResources: 1 });
  assert.deepEqual((await apply(x, seal(x).artifact)).end, { outcome: "PARTIAL_REQUIRES_REVIEW" });
});

test("apply: every private sign-in directory and the template file are removed with the run's secrets", async () => {
  const w = world();
  const { scratch } = await apply(w, seal(w).artifact);
  assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("az-") || name === "template"), []);
});

// --- observe and cleanup ---------------------------------------------------------------------------------------------

test("observe: the stack's managed resources, read back independently as DISCOVERY over ARM REST, exist after the apply", async () => {
  const w = world();
  const { run } = await apply(w, seal(w).artifact);
  const managed = run.managedResources()!;
  const arm = fakeArmHttp({ existing: managed });
  const { reader, close } = createDiscoveryArmReader({ env: w.env, subscriptionId: SUBSCRIPTION_ID, http: arm.http });
  try {
    for (const id of managed) assert.equal((await reader.check({ address: id, type: "Microsoft.Network/virtualNetworks", id, arn: null, origin: "IN_PLAN" })).existence, "PRESENT");
  } finally { close(); }
  assert.ok(arm.calls.every((call) => ["login.microsoftonline.com", "management.azure.com"].includes(new URL(call.url).host)));
});

async function cleanup(w: World, addresses: string[], stop = control()) {
  const snapshot = createImmutableSnapshot(w.project.projectRoot, w.project.manifest, fresh("snapshot"));
  const run = BICEP.openCleanup!(input(w, fresh("cleanup")));
  try {
    run.prepare(snapshot.path);
    const changes = run.planDestroy(addresses);
    const result = await run.execute(stop);
    const end = result.notStarted ? undefined : await run.settle(result);
    return { changes, result, end };
  } finally { run.removeSecrets(); snapshot.remove(); }
}

test("cleanup: the whole stack is deleted with deleteResources as APPLY, the pilot group stays, and a partial or foreign list is refused", async () => {
  const w = world();
  await apply(w, seal(w).artifact);
  await assert.rejects(cleanup(w, []), refusedWith("CLEANUP_ADDRESSES_INVALID"));
  await assert.rejects(cleanup(w, [VNET_ID.replace(VNET, "someone-elses-vnet")]), refusedWith("CLEANUP_PARTIAL_UNSUPPORTED"));
  writeFileSync(KILL, "stop");
  const stopped = await cleanup(w, [VNET_ID]);
  assert.equal(stopped.result.notStarted, true);
  assert.ok(!azCalls().some((call) => sub(call) === "stack group delete"));
  rmSync(KILL);
  const done = await cleanup(w, [VNET_ID]);
  assert.deepEqual(done.changes, [{ address: VNET_ID, type: "Microsoft.Network/virtualNetworks", action: "DELETE" }]);
  assert.deepEqual(done.end, { outcome: "SUCCEEDED" });
  const deletes = azCalls().filter((call) => sub(call) === "stack group delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].who, "APPLY");
  assert.equal(deletes[0].args[deletes[0].args.indexOf("--action-on-unmanage") + 1], "deleteResources");
  assert.ok(!azCalls().some((call) => call.args[0] === "group" && call.args[1] === "delete"));
  assert.equal(stateOf(toolDir).stack, null);
  // The fake ARM knows a provider type only from what the scenario names; the tag listing names the network type here, and nothing exists.
  const arm = fakeArmHttp({ existing: [], tagged: [VNET_ID] });
  const { reader, close } = createDiscoveryArmReader({ env: w.env, subscriptionId: SUBSCRIPTION_ID, http: arm.http });
  try { assert.equal((await reader.check({ address: VNET_ID, type: "Microsoft.Network/virtualNetworks", id: VNET_ID, arn: null, origin: "IN_PLAN" })).existence, "ABSENT"); } finally { close(); }
});

test("cleanup: a refused delete is FAILED_NO_CHANGE, a missing stack or one with deny settings off is refused before any delete", async () => {
  const w = world();
  await apply(w, seal(w).artifact);
  patch(toolDir, { deleteFail: true });
  assert.deepEqual((await cleanup(w, [VNET_ID])).end, { outcome: "FAILED_NO_CHANGE" });
  patch(toolDir, { deleteFail: false, denyMode: "none" });
  await assert.rejects(cleanup(w, [VNET_ID]), refusedWith("DENY_SETTINGS_OFF"));
  const v = world();
  await assert.rejects(cleanup(v, [VNET_ID]), refusedWith("CLEANUP_STACK_NOT_FOUND"));
  assert.equal(azCalls().filter((call) => sub(call) === "stack group delete").length, 0);
});

test("qualify: both versions, both sign-ins and read-only calls as each identity; nothing is created, changed or deleted", () => {
  const w = world();
  withSnapshot(w, (snapshotPath) => BICEP.qualify!({ ...input(w), snapshotPath, unit: UNIT }));
  assert.ok(azCalls().every((call) => ["version", "login", "account", "group"].includes(call.args[0]) || sub(call) === "stack group show"));
  assert.deepEqual([...new Set(azCalls().filter((call) => sub(call) === "stack group show").map((call) => call.who))].sort(), ["APPLY", "DISCOVERY"]);
});
