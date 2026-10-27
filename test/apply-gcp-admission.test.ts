import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { backendOverride } from "../src/apply/backend-pin.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { authorizeContract, inspectPilotContract, loadPilotContract, pilotContractSha256, pilotTargetSha256, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { identityVariables } from "../src/tools/identity.js";
import { checkApplyIdentities } from "../src/apply/identities.js";
import { loadRunRecords, observeRun, openReader, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { PROVIDER_IDS, providerSpec } from "../src/apply/provider.js";
import { AWS } from "../src/apply/providers/aws.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { GCP } from "../src/apply/providers/gcp.js";
import { basesOf } from "../src/apply/run-records.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { APPLY_ADAPTER, CLEANUP_ADAPTER } from "../src/apply/terraform.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import type { GcpHttp, GcpRequest } from "../src/observe/gcp-rest.js";
import { VERIFIERS } from "../src/observe/verify.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import {
  CANARIES, ENGINE_VERSION, H, NOW, POLICY, REQUESTER, SOURCE_COMMIT, STATE_CANARY, approvalFor, approvers, behave as behaveIn, callsOf, human, installFakeTerraform, keys, sha,
  writeReviewedContract,
} from "./helpers/apply-fixtures.js";

// GCP Terraform admission (path 5; the admission-wiring lane, #39). SYNTHETIC: the engine is the fake terraform, Google is a scripted
// HTTP fake, and every project, bucket, service account and token below is fake. It pins the product's logic for a GCP contract end to
// end (contract, identities, seal, apply, observe, cleanup proposal, cleanup, leftovers) and never stands for a live Google project.
// Admission in code only: the repository ships no contract, so ACT stays DISABLED.

const root = mkdtempSync(join(tmpdir(), "alz-gcp-admission-"));
/** The shared fake engine (test/helpers/apply-fixtures.ts) lives in `fakeDir`; `toolDir` holds the program the driver runs. */
const fakeDir = mkdtempSync(join(tmpdir(), "alz-gcp-admission-fake-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-gcp-admission-tf-"));
test.after(() => { removeTree(root); removeTree(fakeDir); removeTree(toolDir); });
installFakeTerraform(fakeDir);
/**
 * The shared fake's destroy plan lists each target with no `provider_name`, which real Terraform always reports (and which the GCP
 * spec now requires, review N4 of #305). This wrapper runs the shared fake and adds the google provider to exactly those entries.
 */
writeFileSync(join(toolDir, "terraform"), `#!${process.execPath}
const { spawnSync } = require("child_process");
const r = spawnSync(${JSON.stringify(join(fakeDir, "terraform"))}, process.argv.slice(2), { stdio: ["inherit", "pipe", "inherit"] });
let out = r.stdout.toString("utf8");
const args = process.argv.slice(2);
if (args[0] === "show" && args[2] && args[2].endsWith("alz-cleanup.tfplan")) {
  const doc = JSON.parse(out);
  doc.resource_changes = doc.resource_changes.map((c) => c.provider_name ? c : { ...c, mode: "managed", provider_name: "registry.terraform.io/hashicorp/google" });
  out = JSON.stringify(doc);
}
process.stdout.write(out);
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
let counter = 0;
const fresh = (label: string): string => { const path = join(root, label + "-" + (counter += 1)); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const KILL = join(root, "KILL");

const PROJECT = "alz-pilot-dev";
const REGION = "europe-west4";
const BUCKET = "alz-pilot-dev-state";
const BACKEND = BUCKET + "/pilot/dev";
const DEV: ResolvedTarget = { account: PROJECT, backend: BACKEND, workspace: "default" };
const GOOGLE = "registry.terraform.io/hashicorp/google";
const IDENTITIES = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const;
const email = (identity: string): string => "alz-" + identity.toLowerCase().replace("_", "-") + "@" + PROJECT + ".iam.gserviceaccount.com";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot/providers/alz-oidc";
const OIDC_CANARY = "CANARY-GCP-OIDC-0001";
const FEDERATED_CANARY = "CANARY-GCP-FEDERATED-0002";
const ACCESS_CANARY = "CANARY-GCP-ACCESS-0003";
const TOKENS = [OIDC_CANARY, FEDERATED_CANARY, ACCESS_CANARY];

/** Four workload identity federation identities, each its own credential configuration, token file and service account. */
const identityEnv = (): NodeJS.ProcessEnv => {
  const dir = fresh("identities");
  const env: NodeJS.ProcessEnv = { HOME: "/home/operator" };
  for (const identity of IDENTITIES) {
    const tokenFile = join(dir, identity.toLowerCase() + ".jwt");
    writeFileSync(tokenFile, (identity === "DISCOVERY" ? OIDC_CANARY : "oidc-" + identity.toLowerCase()) + "\n", { mode: 0o600 });
    const configuration = join(dir, identity.toLowerCase() + ".json");
    writeFileSync(configuration, JSON.stringify({ type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile } }));
    env["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] = configuration;
    env["ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"] = email(identity);
    env["ALZ_" + identity + "_GOOGLE_PROJECT"] = PROJECT;
    env["ALZ_" + identity + "_GOOGLE_REGION"] = REGION;
  }
  return env;
};

const gcpContract = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "GCP", engine: "TERRAFORM", enabledEnvironments: ["DEV"],
  targets: { DEV: { projectId: PROJECT, region: REGION, backend: BACKEND, workspace: "default" } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] }, ...over,
});
const contractAt = (contract: unknown): string => { const path = join(fresh("contract"), "act-pilot-contract.json"); writeReviewedContract(path, contract); return path; };
const reason = (raw: unknown): string => { const r = inspectPilotContract(raw); return r.ok ? "OK" : r.reason; };

// --- the contract ----------------------------------------------------------------------------------------------------------

test("GCP is admitted with Terraform for DEV only: the provider is registered, the DEV-only contract loads and authorizes, the three-stage contract and GCP_API stay refused", () => {
  assert.ok(PROVIDER_IDS.includes("GCP"));
  assert.equal(providerSpec("GCP"), GCP);
  assert.equal(GCP.backendType, "gcs");
  assert.equal(backendOverride("gcs"), 'terraform {\n  backend "gcs" {}\n}\n');

  const loaded = loadPilotContract(contractAt(gcpContract()));
  assert.ok(!("reason" in loaded), JSON.stringify(loaded));
  const authorized = authorizeContract(loaded as PilotContract, "DEV", "APPLY");
  assert.ok(authorized.ok);
  assert.deepEqual(authorized.authorization.entry, { provider: "GCP", engine: "TERRAFORM", environment: "DEV", account: PROJECT, operations: ["APPLY", "CLEANUP"] });

  // The DEV-only scope is required, not optional, for this path.
  const threeStage = gcpContract({
    enabledEnvironments: undefined, requiredApprovals: { DEV: 1, QA: 1, PROD: 2 },
    targets: Object.fromEntries((["dev", "qa", "prod"] as const).map((e) => [e.toUpperCase(), { projectId: "alz-pilot-" + e, region: REGION, backend: "alz-pilot-" + e + "-state/pilot/" + e, workspace: "default" }])),
  });
  assert.match(reason(threeStage), /^enabledEnvironments: GCP TERRAFORM \(path 5\) is admitted for DEV only/);
  const off = loadPilotContract(contractAt(threeStage));
  assert.ok("reason" in off && off.code === "CONTRACT_INVALID");
  // GCP API-native is still a planned path; GCP with CDK is not a combination at all.
  const api = loadPilotContract(contractAt(gcpContract({ engine: "GCP_API" })));
  assert.ok("reason" in api && api.code === "NOT_IMPLEMENTED", JSON.stringify(api));
  assert.match(reason(gcpContract({ engine: "CDK" })), /^engine: CDK is valid only with AWS/);
});

test("GCP targets are validated field by field, the optional parent included, and every field is in the run's target hash", () => {
  const target = (over: Record<string, unknown>) => gcpContract({ targets: { DEV: { projectId: PROJECT, region: REGION, backend: BACKEND, workspace: "default", ...over } } });
  for (const [label, over] of [
    ["project", { projectId: "ALZ-PILOT" }], ["region", { region: "europe-west4-a" }], ["backend without prefix", { backend: BUCKET }], ["backend with google", { backend: "my-google-state/p" }],
    ["workspace", { workspace: "a b" }], ["parent", { parent: "projects/alz-pilot-dev" }], ["parent number", { parent: "folders/0" }], ["unknown field", { zone: "europe-west4-a" }],
  ] as const) assert.notEqual(reason(target(over)), "OK", label);
  assert.equal(reason(target({ parent: "folders/42" })), "OK");
  assert.equal(reason(target({ parent: "organizations/123456789012" })), "OK");

  const hashOf = (over: Record<string, unknown>) => pilotTargetSha256(loadPilotContract(contractAt(target(over))) as PilotContract, "DEV");
  const base = hashOf({});
  assert.ok(base && /^[0-9a-f]{64}$/.test(base));
  const variants = [hashOf({ parent: "folders/42" }), hashOf({ parent: "folders/43" }), hashOf({ region: "us-central1" }), hashOf({ backend: BUCKET + "/pilot/other" }), hashOf({ workspace: "other" })];
  assert.equal(new Set([base, ...variants]).size, 6, "parent, region, backend and workspace each change the target hash");
});

test("the GCP unit is a gcs state container: its id differs from the same location under another backend kind", () => {
  const contractSha256 = H("c");
  const gcp = pilotUnitOf({ provider: "GCP", contractSha256, environment: "DEV", target: DEV });
  assert.match(gcp.unitId, /^alzu-[0-9a-f]{20}$/);
  assert.notEqual(gcp.unitId, pilotUnitOf({ provider: "AWS", contractSha256, environment: "DEV", target: DEV }).unitId);
  assert.notEqual(gcp.unitId, pilotUnitOf({ provider: "AZURE", contractSha256, environment: "DEV", target: DEV }).unitId);
  for (const value of Object.values(gcp.tags)) assert.match(value, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "a GCP label value");
});

// --- the runner profile and identities ---------------------------------------------------------------------------------------

test("the Terraform apply profile hands a child exactly the four Google identity variables, approves *.googleapis.com, and switches the metadata server off", () => {
  const env = identityEnv();
  const extra = { ALZ_APPLY_GOOGLE_CREDENTIALS: "/run/key.json", ALZ_APPLY_GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.x", ALZ_APPLY_GCE_METADATA_HOST: "169.254.169.254", ALZ_APPLY_CLOUDSDK_CONFIG: "/x" };
  const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base: { ...env, ...extra }, toolDirs: [toolDir], home: fresh("home"), tmp: fresh("tmp"), identity: "APPLY" });
  for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"]) assert.equal(child.env[name], env["ALZ_APPLY_" + name], name);
  for (const name of ["GOOGLE_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_CONFIG"]) assert.equal(child.env[name], undefined, name + " never reaches a child");
  assert.deepEqual(child.refused, ["ALZ_APPLY_CLOUDSDK_CONFIG", "ALZ_APPLY_GCE_METADATA_HOST", "ALZ_APPLY_GOOGLE_CREDENTIALS", "ALZ_APPLY_GOOGLE_OAUTH_ACCESS_TOKEN"].sort());
  assert.equal(child.env.GCE_METADATA_HOST, "127.0.0.1:9", "the fixed value, not the identity's");
  assert.equal(child.env.GCE_METADATA_IP, "127.0.0.1:9");
  assert.equal(child.env.NO_GCE_CHECK, "True");
  assert.ok(TERRAFORM_APPLY_PROFILE.approvedHosts.includes("*.googleapis.com"));
  // Another identity's Google variables do not reach the APPLY child.
  assert.notEqual(child.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, email("STATE_WRITE"));
});

test("an AWS or Azure identity carrying a Google variable is refused by name, now that the Terraform profile can inject Google variables", () => {
  for (const [spec, name] of [[AWS, "GOOGLE_APPLICATION_CREDENTIALS"], [AZURE, "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"], [AWS, "GCE_METADATA_HOST"], [AZURE, "CLOUDSDK_CONFIG"], [AWS, "GCLOUD_PROJECT"]] as const) {
    const refusal = spec.ambientRefusal({ ["ALZ_APPLY_" + name]: "x" });
    assert.equal(refusal?.code, "IDENTITY_NOT_CONFIGURED", spec.id + " " + name);
    assert.ok(refusal?.message.includes("ALZ_APPLY_" + name));
  }
  assert.deepEqual(checkApplyIdentities(identityEnv(), GCP, IDENTITIES), { ok: true }, "the GCP identities themselves pass");
});

test("the GCP verifier is wired: GCP_REST is a verifier with its own leftover bases, and openReader opens it for a GCP contract's project only", () => {
  assert.ok(VERIFIERS.includes("GCP_REST"));
  assert.deepEqual(basesOf("GCP_REST"), { absent: "GCP_REST_ABSENT", present: "GCP_REST_PRESENT" });
  assert.deepEqual(basesOf("AZURE_RESOURCE_MANAGER"), { absent: "ARM_ABSENT", present: "ARM_PRESENT" }, "control");
  assert.deepEqual(basesOf("AWS_CLOUD_CONTROL"), { absent: "CLOUD_CONTROL_ABSENT", present: "CLOUD_CONTROL_PRESENT" }, "control");
  const opened = openReader({ contractPath: contractAt(gcpContract()), evidenceDir: fresh("evidence"), env: identityEnv(), gcp: async () => ({ status: 500, body: "" }) }, "DEV");
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.equal(opened.reader.verifier, "GCP_REST");
  assert.equal(opened.binarySha256, null, "in process; no program to hash");
  opened.close();
});

// --- the journey -----------------------------------------------------------------------------------------------------------

const TOPIC = "projects/" + PROJECT + "/topics/alz-unit-topic";
const APP_SA = "projects/" + PROJECT + "/serviceAccounts/alz-app@" + PROJECT + ".iam.gserviceaccount.com";
const DATA_BUCKET = "alz-pilot-dev-data";
const created = (address: string, type: string) => ({ address, type, mode: "managed", provider_name: GOOGLE, change: { actions: ["create"], before: null, after: { name: "x" } } });
const CREATES = [created("google_pubsub_topic.unit", "google_pubsub_topic"), created("google_service_account.app", "google_service_account"), created("google_storage_bucket.data", "google_storage_bucket")];
const stateOf = (type: string, name: string, id: string) => ({ mode: "managed", type, name, provider: 'provider["' + GOOGLE + '"]', instances: [{ schema_version: 0, attributes: { id, secret_value: STATE_CANARY } }] });
const STATE = [
  stateOf("google_pubsub_topic", "unit", TOPIC), stateOf("google_service_account", "app", APP_SA), stateOf("google_storage_bucket", "data", DATA_BUCKET),
  // In the state but not in the plan: the state bucket itself.
  stateOf("google_storage_bucket", "state", BUCKET),
];
const PROVIDER_CONFIG = { google: { name: "google", full_name: GOOGLE, expressions: { project: { constant_value: PROJECT }, default_labels: { references: ["local.unit_labels"] } } } };
/** What init saves for the gcs backend: the contract's bucket and prefix; the credential settings stay null (filled at apply from the APPLY env). */
const SAVED = { type: "gcs", config: { bucket: BUCKET, prefix: "pilot/dev", credentials: null, impersonate_service_account: null, access_token: null, storage_custom_endpoint: null } };

type Cloud = { topics: Set<string>; tagged: string[]; requests: GcpRequest[] };
function fakeGoogle(cloud: Cloud): GcpHttp {
  return async (request) => {
    cloud.requests.push(request);
    const url = new URL(request.url);
    if (request.method === "POST" && request.url === "https://sts.googleapis.com/v1/token") return { status: 200, body: JSON.stringify({ access_token: FEDERATED_CANARY, token_type: "Bearer" }) };
    if (request.method === "POST" && url.host === "iamcredentials.googleapis.com") return { status: 200, body: JSON.stringify({ accessToken: ACCESS_CANARY, expireTime: "2026-10-27T15:00:00Z" }) };
    if (request.method === "GET" && url.host === "pubsub.googleapis.com") {
      const name = url.pathname.replace(/^\/v1\//, "");
      return cloud.topics.has(name) ? { status: 200, body: JSON.stringify({ name, labels: {} }) } : { status: 404, body: "{}" };
    }
    if (request.method === "GET" && url.host === "cloudasset.googleapis.com") return { status: 200, body: JSON.stringify({ results: cloud.tagged.map((name) => ({ name })) }) };
    return { status: 500, body: "" };
  };
}

type World = { deps: ApplyDeps; contractPath: string; evidenceDir: string; cloud: Cloud; observe(at?: number): ObserveDeps };
let vaultDir = "";
test.before(async () => {
  vaultDir = fresh("qualification");
  const terraformSha256 = sha(readFileSync(join(toolDir, "terraform")));
  for (const [adapterVersion, argvDigest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [CLEANUP_ADAPTER.adapterVersion, CLEANUP_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
    const written = await writeQualificationEvidence({
      schemaVersion: 1, engine: "TERRAFORM", realEngine: true, backendIdentitySeparated: true, projectId: PROJECT, region: REGION, backend: BACKEND, workspace: "default",
      stateWriteClientId: email("STATE_WRITE"), applyClientId: email("APPLY"), terraformSha256, adapterVersion, argvDigest, engineVersion: ENGINE_VERSION, qualifiedAt: "2026-10-11T00:00:00.000Z",
    } as never, GCP, vaultDir);
    assert.ok(written.ok, JSON.stringify(written));
  }
});

function world(): World {
  const contractPath = contractAt(gcpContract());
  const unit = pilotUnitOf({ provider: "GCP", contractSha256: pilotContractSha256(loadPilotContract(contractPath) as PilotContract), environment: "DEV", target: DEV });
  behaveIn(fakeDir, KILL, {
    applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTags: { ...unit.tags }, unitTagAttribute: "effective_labels",
    showProviderConfig: PROVIDER_CONFIG, savedBackend: SAVED,
  });
  const evidenceDir = fresh("evidence");
  const cloud: Cloud = { topics: new Set([TOPIC]), tagged: [TOPIC], requests: [] };
  const env = identityEnv();
  const deps: ApplyDeps = {
    sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vaultDir, evidenceDir, nonces: openNonceStore(fresh("nonces")), env, now: () => NOW,
    scratchParent: fresh("scratch"), toolDirs: [toolDir], killPollMs: 40, killGraceMs: 400,
  };
  return { deps, contractPath, evidenceDir, cloud, observe: (at = 60_000) => ({ contractPath, evidenceDir, env, toolDirs: [toolDir], scratchParent: deps.scratchParent, now: () => new Date(NOW.getTime() + at), gcp: fakeGoogle(cloud) }) };
}

function gcpProject() {
  const projectRoot = fresh("project");
  const lock = '# lock\nprovider "' + GOOGLE + '" {\n  version = "6.10.0"\n}\n';
  writeFileSync(join(projectRoot, "main.tf"), 'resource "google_pubsub_topic" "unit" {\n  name = "alz-unit-topic"\n}\n');
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), lock);
  const resolved = { engineVersion: ENGINE_VERSION, providers: [{ source: GOOGLE, version: "6.10.0" }], lockFileSha256: sha(lock), dependencies: [], inputs: [{ name: "region", identity: H("f") }] };
  const manifest = buildManifest({ engine: "TERRAFORM", mode: "PROJECT", target: DEV, unitHash: H("1"), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved });
  return { projectRoot, manifest, resolved };
}

async function seal(w: World) {
  const p = gcpProject();
  const result = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  assert.ok(result.ok, JSON.stringify(result));
  const loaded = await loadSealedPlan(result.path);
  assert.ok(loaded.ok);
  return { sealed: result.sealed, project: p, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
}
type Sealed = Awaited<ReturnType<typeof seal>>;
const apply = (w: World, s: Sealed, approvals: SignedApproval[] = [approvalFor(s.sealed, "alice")]) => runApply({
  invocation: human(DEV), environment: "DEV", target: { ...DEV }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
}, w.deps);
const cleanupApproval = (proposal: CleanupProposal, who: keyof typeof keys): SignedApproval => signApproval({
  schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, approverId: who,
  issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
}, keys[who].priv, "CLEANUP");
const noSecretIn = (label: string, ...values: unknown[]) => {
  for (const text of values.map((v) => JSON.stringify(v))) for (const canary of [...TOKENS, ...CANARIES, STATE_CANARY]) assert.ok(!text.includes(canary), label + ": " + canary);
};

test("GCP Terraform journey (SYNTHETIC): seal, apply, observe through Google's REST APIs as DISCOVERY, propose (only the reviewed leaf), clean up, and verify leftovers; nothing but identifiers is ever recorded", async () => {
  const w = world();
  const s = await seal(w);
  assert.equal(s.sealed.target.account, PROJECT);
  assert.equal(s.sealed.unit?.unitId, pilotUnitOf({ provider: "GCP", contractSha256: s.sealed.contractSha256, environment: "DEV", target: DEV }).unitId);
  assert.deepEqual(s.sealed.unit?.untagged, [], "every created resource carries the unit labels under effective_labels");
  const inits = callsOf(fakeDir).filter((c) => c.args[0] === "init");
  assert.ok(inits.length > 0 && inits.every((c) => c.backendOverride === 'terraform {\n  backend "gcs" {}\n}\n'), "every init is pinned to the gcs backend");

  const applied = await apply(w, s);
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.evidence.outcome, "SUCCEEDED");
  assert.equal(applied.evidence.authority.mutation, "TERRAFORM_APPLY_OF_SEALED_PLAN");
  // The apply-time init wrote STATE_WRITE's credential path and service account into the backend file, and nothing else of an identity.
  const applyInit = callsOf(fakeDir).filter((c) => c.args[0] === "init").at(-1)!;
  assert.match(String(applyInit.backendConfig), new RegExp('impersonate_service_account = "' + email("STATE_WRITE").replace(/[.@]/g, "\\$&") + '"'));
  assert.doesNotMatch(String(applyInit.backendConfig), /access_token|endpoint|encryption_key/);
  const applyCall = callsOf(fakeDir).find((c) => c.args[0] === "apply")!;
  assert.equal(applyCall.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, email("APPLY"), "terraform apply runs as APPLY");
  assert.equal(applyCall.env.GCE_METADATA_HOST, "127.0.0.1:9", "with the metadata server off");

  const observation = await observeRun(s.sealed.artifactSha256, w.observe());
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verifier, "GCP_REST");
  const results = new Map(observation.record.resources.map((r) => [r.address, [r.result, r.reason]]));
  assert.deepEqual(results.get("google_pubsub_topic.unit"), ["VERIFIED", undefined]);
  assert.deepEqual(results.get("google_service_account.app"), ["UNVERIFIABLE", "NO_GCP_READ_MAPPING"], "a type the reader has no read for is named, never assumed");
  assert.equal(observation.record.inventory, "COMPLETE");
  assert.deepEqual(observation.record.unexpected, []);
  const hosts = [...new Set(w.cloud.requests.map((r) => new URL(r.url).host))].sort();
  assert.deepEqual(hosts, ["cloudasset.googleapis.com", "iamcredentials.googleapis.com", "pubsub.googleapis.com", "sts.googleapis.com"]);
  assert.ok(w.cloud.requests.every((r) => !r.url.includes(OIDC_CANARY) && !r.url.includes(ACCESS_CANARY)), "no token in a URL");
  noSecretIn("observation", observation.record, observation.report);
  assert.ok(callsOf(fakeDir).every((c) => TOKENS.every((t) => !JSON.stringify(c).includes(t))), "no token reached the engine's argv or environment");

  const records = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok, JSON.stringify(records));
  const contract = loadPilotContract(w.contractPath) as PilotContract;
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.ok(built.ok, JSON.stringify(built));
  const proposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);
  assert.equal(proposal.provider, "GCP");
  assert.deepEqual(proposal.deletes.map((d) => [d.address, d.identifier, d.observed]), [["google_pubsub_topic.unit", TOPIC, "VERIFIED"]], "the one reviewed GCP leaf, by its resource name");
  assert.ok(proposal.deletes[0]!.risk?.includes("subscriptions"), "its material risk is named");
  const kept = new Map(proposal.excluded.map((x) => [x.address, x.ownership]));
  assert.deepEqual(Object.fromEntries(kept), {
    "google_service_account.app": "PROTECTED_IDENTITY", "google_storage_bucket.data": "TYPE_UNREVIEWED", "google_storage_bucket.state": "PROTECTED_BACKEND",
  });
  assert.match(proposal.excluded.find((x) => x.address === "google_storage_bucket.data")!.reason, /src\/apply\/cleanup-gcp\.ts/, "the GCP leaf list is named, not the AWS one");
  noSecretIn("proposal", proposal);

  const cleaned = await runCleanup({
    invocation: human(DEV), environment: "DEV", target: { ...DEV }, proposal, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot,
    approvals: [cleanupApproval(proposal, "alice")],
  }, w.deps);
  assert.ok(cleaned.ok, JSON.stringify(cleaned));
  assert.deepEqual(cleaned.evidence.deletes, ["google_pubsub_topic.unit"]);
  const destroy = callsOf(fakeDir).filter((c) => c.args[0] === "plan" && c.args[1] === "-destroy");
  assert.deepEqual(destroy.at(-1)!.args.filter((a) => a.startsWith("-target=")), ["-target=google_pubsub_topic.unit"]);

  w.cloud.topics.delete(TOPIC);
  w.cloud.tagged = [];
  const leftovers = await verifyProposalLeftovers(proposal, w.observe(600_000));
  assert.ok(leftovers.ok, JSON.stringify(leftovers));
  assert.equal(leftovers.record.verifier, "GCP_REST");
  const topic = leftovers.record.resources.find((r) => r.address === "google_pubsub_topic.unit")!;
  assert.deepEqual([topic.disposition, topic.basis], ["CONFIRMED_DELETED", "GCP_REST_ABSENT"]);
  noSecretIn("leftovers", leftovers.record);
});

test("GCP journey refusals (SYNTHETIC): a three-stage GCP contract seals nothing; a stray labeled resource fails the observation and no proposal is made; an unread run-created leaf is refused, never proposed", async () => {
  // The three-stage contract is not a contract for this path: nothing is sealed.
  const w0 = world();
  writeReviewedContract(w0.contractPath, gcpContract({ enabledEnvironments: undefined }));
  const p = gcpProject();
  const refusedSeal = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w0.deps);
  assert.equal(refusedSeal.ok, false);
  assert.equal((refusedSeal as { code?: string }).code, "CONTRACT_INVALID");

  const w = world();
  const s = await seal(w);
  assert.ok((await apply(w, s)).ok);
  // A labeled resource of this unit that the state does not name (here a bucket, by the asset name Cloud Asset Inventory reports) fails the observation.
  w.cloud.tagged = [TOPIC, "projects/_/buckets/" + DATA_BUCKET];
  const stray = await observeRun(s.sealed.artifactSha256, w.observe());
  assert.ok(stray.ok);
  assert.equal(stray.record.verdict, "FAILED");
  assert.deepEqual(stray.record.unexpected, ["projects/_/buckets/" + DATA_BUCKET]);
  const records = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok);
  const contract = loadPilotContract(w.contractPath) as PilotContract;
  const fromStray = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.equal(fromStray.ok, false);
  assert.equal((fromStray as { code?: string }).code, "OBSERVATION_INCONCLUSIVE");

  // The topic's read is denied: the run-created leaf is unread, and GCP accepts no unread reason, so no proposal is made.
  w.cloud.tagged = [TOPIC];
  const denying: GcpHttp = async (request) => new URL(request.url).host === "pubsub.googleapis.com" ? { status: 403, body: "{}" } : fakeGoogle(w.cloud)(request);
  const denied = await observeRun(s.sealed.artifactSha256, { ...w.observe(), gcp: denying });
  assert.ok(denied.ok);
  const deniedRecords = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(deniedRecords.ok);
  const fromDenied = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...deniedRecords, changes: s.sealed.changes, channel: "CLI", contract, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.equal(fromDenied.ok, false);
  assert.equal((fromDenied as { code?: string }).code, "OBSERVATION_INCONCLUSIVE");
  // The STATE_WRITE identity's own values are what the saved backend may name: an init that saved APPLY's service account refuses the seal.
  const w2 = world();
  behaveIn(fakeDir, KILL, {
    applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, showProviderConfig: PROVIDER_CONFIG,
    savedBackend: { type: "gcs", config: { ...SAVED.config, impersonate_service_account: email("APPLY") } },
  });
  const p2 = gcpProject();
  const tainted = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: p2.manifest, projectRoot: p2.projectRoot, policyVersion: POLICY, resolved: p2.resolved, requester: REQUESTER }, w2.deps);
  assert.equal(tainted.ok, false);
  assert.match(JSON.stringify(tainted), /BACKEND_NOT_IN_CONTRACT/);
  assert.equal(identityVariables(w2.deps.env!, "STATE_WRITE").get("GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"), email("STATE_WRITE"));
});
