import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig, type EvidenceRunnerConfig } from "../src/evidence-runner/config.js";
import { RELEASE_GATE_IDS } from "../src/evidence-runner/gate-ids.js";
import { gateModeOf, gatePlan, releaseGates } from "../src/evidence-runner/gates.js";
import { compareIdentity, identityHash, ownerInputs, runPreflight, unbuiltProbe } from "../src/evidence-runner/preflight.js";
import { PRODUCTION_RELEASE_GATES } from "../src/qualification/release-admission.js";
import { ACCOUNT, CANDIDATE, SUBSCRIPTION, TENANT, fakeProbe, fixtureRoot, observedAws, observedAzure, validConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the runner's preflight. No probe here reaches a cloud; the identity comparison is tested with fakes.

const config = (overrides: Record<string, unknown> = {}): EvidenceRunnerConfig => {
  const result = parseConfig(validConfig(overrides));
  assert.ok(result.ok);
  return result.config;
};
const clean = { ok: true as const, commit: CANDIDATE, origin: "GIT_CHECKOUT" as const };

test("the observed identity must equal the expected account, tenant and subscription", () => {
  assert.equal(compareIdentity("aws", config(), observedAws).code, "VERIFIED");
  assert.equal(compareIdentity("aws", config(), observedAws).kind, "OPERATOR_CLI_LOGIN");
  assert.equal(compareIdentity("azure", config(), observedAzure).code, "VERIFIED");
  const wrongAccount = compareIdentity("aws", config(), { ...observedAws, accountId: "999988887777" });
  assert.equal(wrongAccount.code, "WRONG_ACCOUNT");
  assert.match(wrongAccount.detail, /999988887777 \(expected 111122223333\)/);
  assert.equal(compareIdentity("azure", config(), { ...observedAzure, subscriptionId: TENANT }).code, "WRONG_ACCOUNT");
  assert.equal(compareIdentity("azure", config(), { ...observedAzure, tenantId: SUBSCRIPTION }).code, "WRONG_ACCOUNT");
  assert.equal(compareIdentity("aws", config(), { status: "NOT_SIGNED_IN", detail: "Run aws sso login." }).code, "NOT_SIGNED_IN");
  assert.equal(compareIdentity("aws", config(), { status: "PROBE_NOT_BUILT" }).code, "IDENTITY_NOT_VERIFIED");
  assert.equal(compareIdentity("aws", config({ aws: undefined }), observedAws).code, "NOT_CONFIGURED");
});

test("in this build a configured provider is never verified, so a real run stops BLOCKED before any read", async () => {
  const preflight = await runPreflight({ root: fixtureRoot(), env: {}, config: config(), source: clean, probe: unbuiltProbe });
  assert.equal(preflight.blocked, true);
  assert.deepEqual(preflight.identities.map((check) => check.code), ["IDENTITY_NOT_VERIFIED", "IDENTITY_NOT_VERIFIED"]);
});

test("a provider the configuration does not name is never probed", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  const preflight = await runPreflight({ root: fixtureRoot(), env: {}, config: config({ azure: undefined }), source: clean, probe });
  assert.deepEqual(probe.calls, ["aws"]);
  assert.equal(preflight.blocked, false);
  assert.deepEqual(preflight.identities.map((check) => check.code), ["VERIFIED", "NOT_CONFIGURED"]);
});

test("a dirty checkout, another HEAD or a mutation identity in the environment blocks the run", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  const root = fixtureRoot();
  const dirty = await runPreflight({ root, env: {}, config: config(), source: { ok: false, reason: "The checkout has uncommitted changes." }, probe });
  assert.equal(dirty.checks.find((check) => check.id === "source")?.code, "SOURCE_NOT_CLEAN");
  const other = await runPreflight({ root, env: {}, config: config(), source: { ...clean, commit: "f".repeat(40) }, probe });
  assert.equal(other.checks.find((check) => check.id === "source")?.code, "CANDIDATE_NOT_HEAD");
  const mutation = await runPreflight({ root, env: { ALZ_APPLY_AWS_ROLE_ARN: "x", ALZ_DISCOVERY_AWS_REGION: "eu-west-1" }, config: config(), source: clean, probe });
  const check = mutation.checks.find((item) => item.id === "mutation-identities")!;
  assert.equal(check.code, "MUTATION_IDENTITY_PRESENT");
  assert.match(check.detail, /ALZ_APPLY_AWS_ROLE_ARN/);
  assert.doesNotMatch(check.detail, /ALZ_DISCOVERY/, "a read-only identity is not a mutation identity");
  for (const result of [dirty, other, mutation]) assert.equal(result.blocked, true);
});

test("the pin file's presence alone decides whether ACT is reported disabled (the contract itself is checked by ./alz apply preflight in S5)", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  const empty = await runPreflight({ root: fixtureRoot(""), env: {}, config: config(), source: clean, probe });
  assert.equal(empty.checks.find((check) => check.id === "act")?.code, "SKIPPED_ACT_DISABLED");
  const pinned = await runPreflight({ root: fixtureRoot("c".repeat(64) + "\n"), env: {}, config: config(), source: clean, probe });
  assert.equal(pinned.checks.find((check) => check.id === "act")?.code, "PIN_PRESENT");
  assert.equal(pinned.ownerInputs.find((input) => input.id === "pilot-pin")?.code, "PIN_PRESENT");
});

test("owner inputs: the no-op stack, the federated qualification identity and the pin, each with its BLOCKED reason", () => {
  const inputs = ownerInputs(config(), "EMPTY");
  assert.deepEqual(inputs.map((input) => input.code), ["OWNER_INPUT_NOOP_STACK", "OWNER_INPUT_FEDERATED_IDENTITY", "OWNER_INPUT_PIN"]);
  assert.ok(inputs.every((input) => input.status === "BLOCKED"));
  assert.match(inputs[0].detail, /never creates, updates or deletes it/);
  assert.match(inputs[1].detail, /never under your CLI login/);
  assert.deepEqual(ownerInputs(config({ aws: undefined, azure: undefined }), "EMPTY").map((input) => input.code), ["OWNER_INPUT_PIN"]);
});

test("the identity hash binds the expected ids and changes with any of them", () => {
  const base = identityHash(config());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(identityHash(config({ aws: { expectedAccountId: "999988887777", region: "eu-west-1", qualificationStack: "s" } })), base);
  assert.notEqual(identityHash(config({ azure: undefined })), base);
  assert.ok(!base.includes(ACCOUNT));
});

test("every release gate is mapped, read as data without the registry; gates with no producer report NO_PRODUCER", () => {
  // The runner reads the ids from config/release/status.json and derives each mode itself (it never imports the
  // registry, which loads the apply path). This test, which may import the registry, pins both against it.
  const { ids, outOfScope } = releaseGates(".");
  assert.deepEqual(ids, PRODUCTION_RELEASE_GATES.map((gate) => gate.id), "status.json lists every registry gate, in order");
  assert.deepEqual(RELEASE_GATE_IDS, PRODUCTION_RELEASE_GATES.map((gate) => gate.id), "the runner's committed copy of the gate ids follows the registry");
  for (const gate of PRODUCTION_RELEASE_GATES) assert.equal(gateModeOf(gate.id), gate.mode, gate.id);
  const plan = gatePlan(ids, outOfScope);
  const mode = (id: string) => plan.find((gate) => gate.id === id)?.mode;
  for (const id of ["arm64-final-image", "isolated-recovery", "security-review:independent", "pillar:security", "lifecycle:clean-install", "lifecycle:upgrade", "lifecycle:rollback", "lifecycle:configuration-migration", "source-ci", "release-archive"]) {
    assert.equal(mode(id), "NO_PRODUCER", id);
  }
  assert.equal(mode("platform:linux-x64"), "OWNER", "the merged lifecycle runner produces the platform gates on each host");
  assert.equal(mode("aws-provider"), "AUTO");
  assert.equal(mode("azure-provider"), "AUTO");
  // GCP's gates are required before GCP is admitted: reported, never planned as AUTO or GUIDED, and never Azure's stage by default.
  for (const id of ["gcp-provider", "preview:terraform-gcp-brownfield"]) {
    assert.equal(mode(id), "NO_PRODUCER", id);
    assert.match(plan.find((gate) => gate.id === id)!.note, /not an admitted provider/, id);
  }
  assert.equal(gatePlan(["other-provider"], new Set())[0].mode, "NO_PRODUCER");
  assert.equal(mode("private-model-runtime"), "OWNER");
  assert.equal(mode("act:aws-terraform"), "GUIDED");
  assert.match(plan.find((gate) => gate.id === "act:aws-cdk")!.note, /CDK_CLEANUP_NOT_IMPLEMENTED/);
  for (const id of outOfScope) assert.equal(mode(id), "OUT_OF_SCOPE", id);
  assert.equal(gateModeOf("future-gate"), "UNKNOWN");
  assert.equal(gatePlan(["future-gate"], new Set())[0].mode, "NO_PRODUCER", "an unknown gate id fails closed");
});
