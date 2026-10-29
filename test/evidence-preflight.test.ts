import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig, type EvidenceRunnerConfig } from "../src/evidence-runner/config.js";
import { RELEASE_GATE_IDS } from "../src/evidence-runner/gate-ids.js";
import { gateModeOf, gatePlan, releaseGates } from "../src/evidence-runner/gates.js";
import { compareIdentity, contractEnablesPath, contractScope, identityHash, ownerInputs, runPreflight, unbuiltProbe, type PreflightInputs } from "../src/evidence-runner/preflight.js";
import { DEFAULT_STAGES } from "../src/evidence-runner/types.js";
import { PRODUCTION_RELEASE_GATES } from "../src/qualification/release-admission.js";
import { AUTHORIZING_CONTRACT, ACCOUNT, CANDIDATE, PROJECT, SUBSCRIPTION, TENANT, fakeProbe, fixtureRoot, observedAws, observedAzure, observedGcp, validConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the runner's preflight. No probe here reaches a cloud; the identity comparison is tested with fakes.

const config = (overrides: Record<string, unknown> = {}): EvidenceRunnerConfig => {
  const result = parseConfig(validConfig(overrides));
  assert.ok(result.ok);
  return result.config;
};
const clean = { ok: true as const, commit: CANDIDATE, origin: "GIT_CHECKOUT" as const };
const preflightOf = (input: Omit<PreflightInputs, "stages"> & { stages?: PreflightInputs["stages"] }) => runPreflight({ stages: DEFAULT_STAGES, ...input });

test("the identity must name the expected account, tenant, subscription and project", () => {
  assert.equal(compareIdentity("aws", config(), observedAws).code, "VERIFIED");
  assert.equal(compareIdentity("aws", config(), observedAws).kind, "FEDERATED");
  assert.equal(compareIdentity("aws", config(), { ...observedAws, region: "us-east-2" }).code, "WRONG_ACCOUNT", "a region other than the configured one is refused");
  const gcp = config({ gcp: { expectedProjectId: PROJECT, region: "europe-west1" } });
  assert.equal(compareIdentity("gcp", gcp, observedGcp).code, "VERIFIED");
  assert.equal(compareIdentity("gcp", gcp, { ...observedGcp, projectId: "another-project" }).code, "WRONG_ACCOUNT");
  assert.equal(compareIdentity("gcp", config(), observedGcp).code, "NOT_CONFIGURED");
  assert.equal(compareIdentity("aws", config(), { status: "MISSING", detail: "Set ALZ_DISCOVERY_AWS_ROLE_ARN." }).code, "FEDERATED_IDENTITY_MISSING");
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

test("a configured provider whose identity is not verified stops the run BLOCKED before any read", async () => {
  const preflight = await preflightOf({ root: fixtureRoot(), env: {}, config: config(), source: clean, probe: unbuiltProbe });
  assert.equal(preflight.blocked, true);
  assert.deepEqual(preflight.identities.map((check) => check.code), ["IDENTITY_NOT_VERIFIED", "IDENTITY_NOT_VERIFIED", "NOT_CONFIGURED"]);
});

test("a provider the configuration does not name, or whose stage is not selected, is never probed", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  const preflight = await preflightOf({ root: fixtureRoot(), env: {}, config: config({ azure: undefined }), source: clean, probe });
  assert.deepEqual(probe.calls, ["aws"]);
  assert.equal(preflight.blocked, false);
  assert.deepEqual(preflight.identities.map((check) => check.code), ["VERIFIED", "NOT_CONFIGURED", "NOT_CONFIGURED"]);
  const summaryOnly = fakeProbe({ aws: observedAws, azure: observedAzure });
  const summary = await preflightOf({ root: fixtureRoot(), env: {}, config: config(), source: clean, probe: summaryOnly, stages: ["preflight", "summary"] });
  assert.deepEqual(summaryOnly.calls, [], "the summary reads no identity");
  assert.deepEqual(summary.identities, []);
});

test("guided stages: mutation identities are not refused, and HEAD may be the commit that differs from the candidate in the contract only", async () => {
  const probe = fakeProbe({});
  const contractCommit = "c".repeat(40);
  const env = { ALZ_APPLY_AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/apply" };
  const base = { root: fixtureRoot(), env, config: config(), probe, source: { ...clean, commit: contractCommit } };
  const ok = await preflightOf({ ...base, stages: ["preflight", "act:aws-terraform"], changedPaths: () => ["config/act-pilot-contract.json"] });
  assert.equal(ok.checks.find((check) => check.id === "source")?.code, "CONTRACT_COMMIT_IS_HEAD");
  assert.equal(ok.checks.find((check) => check.id === "mutation-identities")?.code, "NOT_CHECKED");
  assert.equal(ok.blocked, false);
  assert.equal(ok.headCommit, contractCommit);
  for (const changed of [["config/act-pilot-contract.json", "src/apply/driver.ts"], [], undefined]) {
    const refused = await preflightOf({ ...base, stages: ["preflight", "cleanup:aws-terraform"], changedPaths: () => changed });
    assert.equal(refused.checks.find((check) => check.id === "source")?.code, "CANDIDATE_NOT_HEAD", JSON.stringify(changed));
    assert.equal(refused.blocked, true);
  }
  const readonly = await preflightOf({ ...base, stages: ["preflight", "aws-readonly"], changedPaths: () => ["config/act-pilot-contract.json"] });
  assert.equal(readonly.checks.find((check) => check.id === "source")?.code, "CANDIDATE_NOT_HEAD", "read-only stages run at the candidate itself");
  assert.equal(readonly.checks.find((check) => check.id === "mutation-identities")?.code, "MUTATION_IDENTITY_PRESENT");
  assert.deepEqual(probe.calls, ["aws"], "only the selected read-only stage's identity is read");
});

test("a dirty checkout, another HEAD or a mutation identity in the environment blocks the run", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  const root = fixtureRoot();
  const dirty = await preflightOf({ root, env: {}, config: config(), source: { ok: false, reason: "The checkout has uncommitted changes." }, probe });
  assert.equal(dirty.checks.find((check) => check.id === "source")?.code, "SOURCE_NOT_CLEAN");
  const other = await preflightOf({ root, env: {}, config: config(), source: { ...clean, commit: "f".repeat(40) }, probe });
  assert.equal(other.checks.find((check) => check.id === "source")?.code, "CANDIDATE_NOT_HEAD");
  const mutation = await preflightOf({ root, env: { ALZ_APPLY_AWS_ROLE_ARN: "x", ALZ_DISCOVERY_AWS_REGION: "eu-west-1" }, config: config(), source: clean, probe });
  const check = mutation.checks.find((item) => item.id === "mutation-identities")!;
  assert.equal(check.code, "MUTATION_IDENTITY_PRESENT");
  assert.match(check.detail, /ALZ_APPLY_AWS_ROLE_ARN/);
  assert.doesNotMatch(check.detail, /ALZ_DISCOVERY/, "a read-only identity is not a mutation identity");
  for (const result of [dirty, other, mutation]) assert.equal(result.blocked, true);
});

test("the committed contract's authorize decides whether ACT is reported disabled (the contract itself is checked by the ./alz apply children)", async () => {
  const probe = fakeProbe({ aws: observedAws, azure: observedAzure });
  for (const contract of [undefined, "not json", { ...AUTHORIZING_CONTRACT, enabled: false }, { ...AUTHORIZING_CONTRACT, authorize: {} }, { enabled: true }, { ...AUTHORIZING_CONTRACT, authorize: ["DEV"] }]) {
    const off = await preflightOf({ root: fixtureRoot(contract), env: {}, config: config(), source: clean, probe });
    assert.equal(off.checks.find((check) => check.id === "act")?.code, "SKIPPED_ACT_DISABLED", JSON.stringify(contract));
    assert.equal(off.actScope, "EMPTY");
  }
  const authorized = await preflightOf({ root: fixtureRoot(AUTHORIZING_CONTRACT), env: {}, config: config(), source: clean, probe });
  assert.equal(authorized.checks.find((check) => check.id === "act")?.code, "AUTHORIZATION_PRESENT");
  assert.equal(authorized.ownerInputs.find((input) => input.id === "pilot-authorization")?.code, "AUTHORIZATION_PRESENT");
  // The retired pin file is never read: one beside an unauthorized contract changes nothing.
  const root = fixtureRoot();
  writeFileSync(join(root, "config", "act-pilot-contract.sha256"), "c".repeat(64) + "\n");
  assert.equal((await preflightOf({ root, env: {}, config: config(), source: clean, probe })).actScope, "EMPTY");
});

test("a path runs only under a committed contract that names its provider and engine and authorizes the operation in DEV", () => {
  const scope = (contract: unknown) => contractScope(fixtureRoot(contract));
  const aws = { ...AUTHORIZING_CONTRACT, provider: "AWS", engine: "TERRAFORM", authorize: { DEV: ["APPLY", "CLEANUP"] } };
  assert.deepEqual(contractEnablesPath(scope(aws), "aws-terraform", "APPLY"), { ok: true });
  assert.deepEqual(contractEnablesPath(scope(aws), "aws-terraform", "CLEANUP"), { ok: true });
  assert.equal((contractEnablesPath(scope(aws), "aws-cdk", "APPLY") as { code: string }).code, "CONTRACT_NOT_FOR_PATH");
  assert.equal((contractEnablesPath(scope(aws), "azure-terraform", "APPLY") as { code: string }).code, "CONTRACT_NOT_FOR_PATH");
  assert.equal((contractEnablesPath(scope({ ...aws, engine: undefined }), "aws-terraform", "APPLY") as { code: string }).code, "CONTRACT_NOT_FOR_PATH", "no engine is never read as Terraform");
  assert.equal((contractEnablesPath(scope({ ...aws, authorize: { DEV: ["APPLY"] } }), "aws-terraform", "CLEANUP") as { code: string }).code, "ACT_NOT_AUTHORIZED");
  assert.equal((contractEnablesPath(scope({ ...aws, authorize: { QA: ["APPLY"] } }), "aws-terraform", "APPLY") as { code: string }).code, "ACT_NOT_AUTHORIZED");
  for (const off of [undefined, { ...aws, enabled: false }, { ...aws, authorize: {} }, "not json"]) {
    assert.equal((contractEnablesPath(scope(off), "aws-terraform", "APPLY") as { code: string }).code, "ACT_DISABLED", JSON.stringify(off));
  }
});

test("owner inputs: the no-op stack, the federated identity, the contract's authorization and the act targets, each with its BLOCKED reason", () => {
  const inputs = ownerInputs(config(), "EMPTY");
  assert.deepEqual(inputs.map((input) => input.code), ["OWNER_INPUT_NOOP_STACK", "OWNER_INPUT_FEDERATED_IDENTITY", "OWNER_INPUT_AUTHORIZATION", "OWNER_INPUT_ACT_TARGETS"]);
  assert.ok(inputs.every((input) => input.status === "BLOCKED"));
  assert.match(inputs[0].detail, /never creates, updates or deletes it/);
  assert.match(inputs[1].detail, /never under your CLI login/);
  assert.deepEqual(ownerInputs(config({ aws: undefined, azure: undefined, act: { repository: "o/r", paths: {} } }), "EMPTY").map((input) => input.code), ["OWNER_INPUT_AUTHORIZATION"]);
});

test("the identity hash binds the expected ids and changes with any of them", () => {
  const base = identityHash(config());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(identityHash(config({ aws: { expectedAccountId: "999988887777", region: "eu-west-1", qualificationStack: "s" } })), base);
  assert.notEqual(identityHash(config({ azure: undefined })), base);
  assert.notEqual(identityHash(config({ gcp: { expectedProjectId: PROJECT, region: "europe-west1" } })), base);
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
  for (const id of ["arm64-final-image", "isolated-recovery", "security-review:independent", "lifecycle:clean-install", "lifecycle:upgrade", "lifecycle:rollback", "lifecycle:configuration-migration"]) {
    assert.equal(mode(id), "NO_PRODUCER", id);
  }
  // The CI gates' producer merged in #274: the owner runs ./alz qualify ci-evidence, and the summary indexes what it wrote.
  for (const id of ["source-ci", "release-archive"]) {
    assert.equal(mode(id), "OWNER", id);
    assert.match(plan.find((gate) => gate.id === id)!.note, new RegExp("qualify ci-evidence --gate " + id));
  }
  assert.equal(mode("platform:linux-x64"), "OWNER", "the merged lifecycle runner produces the platform gates on each host");
  assert.equal(mode("aws-provider"), "AUTO");
  assert.equal(mode("azure-provider"), "AUTO");
  // GCP Terraform is admitted in code for DEV only (owner decision 6481421924), but the live read-only GCP inventory has no runner stage:
  // gcp-provider is reported NO_PRODUCER, never planned as AUTO, and never Azure's stage by default. The owner's scope of 2026-10-28
  // (#39 6480066863) excludes the GCP preview gate, so the shipped plan reports it OUT_OF_SCOPE; with no exclusion it is produced at seal
  // like any admitted path's preview gate (GUIDED S5), for the authorized path only.
  assert.equal(mode("gcp-provider"), "NO_PRODUCER");
  assert.match(plan.find((gate) => gate.id === "gcp-provider")!.note, /no read-only GCP inventory producer exists on main/);
  assert.equal(gatePlan(["gcp-provider"], new Set())[0].mode, "NO_PRODUCER");
  assert.ok(outOfScope.has("preview:terraform-gcp-brownfield"));
  assert.equal(mode("preview:terraform-gcp-brownfield"), "OUT_OF_SCOPE");
  const unscopedGcpPreview = gatePlan(["preview:terraform-gcp-brownfield"], new Set())[0];
  assert.equal(unscopedGcpPreview.mode, "GUIDED");
  assert.match(unscopedGcpPreview.note, /preview-evidence after a seal of the authorized path; the runner does not sequence it/);
  assert.equal(gatePlan(["other-provider"], new Set())[0].mode, "NO_PRODUCER");
  assert.equal(mode("private-model-runtime"), "OWNER");
  assert.equal(mode("act:aws-terraform"), "GUIDED");
  for (const path of ["aws-terraform", "aws-cdk", "azure-terraform", "azure-bicep", "gcp-terraform"]) {
    const entry = plan.find((gate) => gate.id === "act:" + path)!;
    assert.deepEqual([entry.mode, entry.slice], ["GUIDED", "S5"], path);
    assert.match(entry.note, new RegExp("--stage act:" + path + ", then --stage cleanup:" + path), path);
  }
  assert.equal(gatePlan(["act:gcp-gcp_api"], new Set())[0].mode, "NO_PRODUCER", "an ACT gate the runner has no stage for is never planned");
  for (const id of outOfScope) assert.equal(mode(id), "OUT_OF_SCOPE", id);
  assert.equal(gateModeOf("future-gate"), "UNKNOWN");
  assert.equal(gatePlan(["future-gate"], new Set())[0].mode, "NO_PRODUCER", "an unknown gate id fails closed");
});

const DROPPED_BROWNFIELD = [
  "preview:terraform-aws-brownfield", "preview:terraform-azure-brownfield", "preview:cdk-aws-brownfield", "preview:bicep-azure-brownfield", "preview:terraform-gcp-brownfield",
];

test("the owner dropped the brownfield preview gates from this release (2026-10-28): the runner reports each OUT_OF_SCOPE and plans no stage for it, and the in-scope preview producer mapping is unchanged", () => {
  const { ids, outOfScope } = releaseGates(".");
  const plan = gatePlan(ids, outOfScope);
  for (const id of DROPPED_BROWNFIELD) {
    assert.ok(ids.includes(id), id + " is still a registry gate");
    assert.ok(outOfScope.has(id), id + " is excluded by config/release/scope.json");
    assert.equal(gateModeOf(id), "LIVE_PREVIEW", id);
    const entry = plan.find((gate) => gate.id === id)!;
    assert.equal(entry.mode, "OUT_OF_SCOPE", id);
    assert.equal(entry.slice, undefined, id);
    assert.match(entry.note, /owner's release scope/, id);
  }
  // No preview gate is in this release's scope any more.
  assert.deepEqual(ids.filter((id) => id.startsWith("preview:") && !outOfScope.has(id)), []);
  // Were the owner to bring a preview gate back into scope, it is produced by ./alz apply preview-evidence after a seal of the
  // authorized path (GUIDED); GCP Terraform's too, now that it is admitted in code for DEV only (owner decision 6481421924).
  // The runner does not sequence that producer, so it plans no slice for it.
  for (const id of DROPPED_BROWNFIELD) {
    const inScope = gatePlan([id], new Set())[0];
    assert.deepEqual([inScope.mode, inScope.slice], ["GUIDED", undefined], id);
    assert.match(inScope.note, /after a seal of the authorized path/, id);
  }
});

test("the Bicep ACT gate is in scope and admitted in code: act:azure-bicep is a guided DEV stage, for the authorized path only", () => {
  const { ids, outOfScope } = releaseGates(".");
  assert.ok(ids.includes("act:azure-bicep") && !outOfScope.has("act:azure-bicep"));
  assert.equal(gateModeOf("act:azure-bicep"), "LIVE_ACT");
  const act = gatePlan(ids, outOfScope).find((gate) => gate.id === "act:azure-bicep")!;
  assert.deepEqual([act.mode, act.slice], ["GUIDED", "S5"]);
  assert.match(act.note, /at the commit carrying this path's reviewed contract; you type every phrase/);
});

const PILLARS = [
  "pillar:operational-excellence", "pillar:security", "pillar:reliability", "pillar:performance", "pillar:cost", "pillar:sustainability",
];

test("the owner moved the six pillar gates to v1.1 (2026-10-28): the runner reports each OUT_OF_SCOPE and plans no stage for it; with no exclusion each is still NO_PRODUCER", () => {
  const { ids, outOfScope } = releaseGates(".");
  const plan = gatePlan(ids, outOfScope);
  for (const id of PILLARS) {
    assert.ok(ids.includes(id), id + " is still a registry gate");
    assert.ok(outOfScope.has(id), id + " is excluded by config/release/scope.json");
    assert.equal(gateModeOf(id), "LIVE_METRIC", id);
    const entry = plan.find((gate) => gate.id === id)!;
    assert.equal(entry.mode, "OUT_OF_SCOPE", id);
    assert.equal(entry.slice, undefined, id);
    assert.match(entry.note, /owner's release scope/, id);
    // The mapping itself is unchanged: were the owner to bring a pillar gate back into scope, it has no producer yet.
    assert.equal(gatePlan([id], new Set())[0].mode, "NO_PRODUCER", id);
  }
  assert.deepEqual(ids.filter((id) => id.startsWith("pillar:") && !outOfScope.has(id)), [], "no pillar gate is in this release's scope");
  // gcp-provider stays required (#39, 6481421924): its gate is not excluded and is reported NO_PRODUCER until the runner has a read-only GCP inventory stage.
  assert.ok(!outOfScope.has("gcp-provider"));
  assert.equal(plan.find((gate) => gate.id === "gcp-provider")!.mode, "NO_PRODUCER");
});
