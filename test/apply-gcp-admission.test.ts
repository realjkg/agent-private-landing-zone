import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signApproval } from "../src/apply/approval.js";
import { backendOverride } from "../src/apply/backend-pin.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { authorizeContract, inspectPilotContract, loadPilotContract, pilotContractSha256, pilotTargetSha256, targetMoved, writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { identityVariables } from "../src/tools/identity.js";
import { checkApplyIdentities } from "../src/apply/identities.js";
import { loadRunRecords, observeRun, openReader, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { PROVIDER_IDS, providerSpec } from "../src/apply/provider.js";
import { AWS } from "../src/apply/providers/aws.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { GCP, GCP_DENIED_TYPES_REVIEWED_AGAINST } from "../src/apply/providers/gcp.js";
import { basesOf, readBlueprintRecord } from "../src/apply/run-records.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { APPLY_ADAPTER, CLEANUP_ADAPTER } from "../src/apply/terraform.js";
import { OFFICIAL_PROVIDER_HASHES, REVIEWED_PROVIDER_VERSIONS, lockedProviders, unofficialProviderHash, unreviewedProviderVersion } from "../src/apply/lockfile.js";
import { TERRAFORM } from "../src/apply/engines/terraform.js";
import type { PilotContract, SignedApproval } from "../src/apply/types.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import type { GcpHttp, GcpRequest } from "../src/observe/gcp-rest.js";
import { VERIFIERS } from "../src/observe/verify.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../src/teardown/driver/types.js";
import { buildManifest, canonicalJson } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { PROFILES, TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import { sha256 } from "../src/util/sha256.js";
import {
  CANARIES, ENGINE_VERSION, H, NOW, POLICY, REQUESTER, SOURCE_COMMIT, STATE_CANARY, approvalFor, approvers, awsContractJson, behave as behaveIn, callsOf, contractJson as azureContractJson, human, installFakeTerraform, keys, sha,
  writeReviewedContract, type Behavior,
} from "./helpers/apply-fixtures.js";

// GCP Terraform admission (path 5, DEV only; owner decision 6481421924 on issue #39, ported from #323 by INT-1a). SYNTHETIC: the engine is
// the fake terraform, Google is a scripted HTTP fake, and every project, bucket, service account and token below is fake. It pins the
// product's logic for a GCP contract end to end (contract, identities, canary allowlist, seal, apply, observe, cleanup proposal, cleanup,
// leftovers) and never stands for a live Google project. Admission in code only: the repository ships no contract, so ACT stays DISABLED.

const root = mkdtempSync(join(tmpdir(), "alz-gcp-admission-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-gcp-admission-tf-"));
const fakeDir = toolDir;
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);
let counter = 0;
const fresh = (label: string): string => { const path = join(root, label + "-" + (counter += 1)); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const KILL = join(root, "KILL");

const PROJECT = "alz-pilot-dev";
const REGION = "europe-west4";
const BUCKET = "alz-pilot-dev-state";
const BACKEND = BUCKET + "/pilot/dev";
const DEV: ResolvedTarget = { account: PROJECT, backend: BACKEND, workspace: "default" };
const GOOGLE = "registry.terraform.io/hashicorp/google";
/** The owner decision E1 canary for GCP (PLAN 6481447333, section 2): one Pub/Sub topic, nothing else. */
const CANARY = { resources: [{ type: "google_pubsub_topic", count: 1 }] };
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
  targets: { DEV: { projectId: PROJECT, region: REGION, backend: BACKEND, workspace: "default", canary: CANARY } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: KILL, authorize: { DEV: ["APPLY", "CLEANUP"] },
  // Required for GCP Terraform (#345 review N1): the plan names STATE_WRITE for the gcs backend.
  embedStateWrite: true, ...over,
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
  assert.match(reason(gcpContract({ engine: "BICEP" })), /^engine: BICEP is valid only with AZURE/);
});

test("GCP Terraform requires embedStateWrite true (#345 review N1): absent, false or a non-boolean is refused at load and seals nothing; AWS and Azure Terraform keep their opt-in default", async () => {
  const loaded = loadPilotContract(contractAt(gcpContract()));
  assert.equal(loaded.enabled, true);
  assert.equal((loaded as PilotContract).embedStateWrite, true);
  const required = /^embedStateWrite: GCP TERRAFORM \(path 5\) requires embedStateWrite true/;
  const absent = (({ embedStateWrite: _dropped, ...rest }) => rest)(gcpContract());
  for (const [label, raw] of [["absent", absent], ["false", gcpContract({ embedStateWrite: false })]] as const) {
    assert.match(reason(raw), required, label);
    const off = loadPilotContract(contractAt(raw));
    assert.equal(off.enabled, false, label);
    assert.equal((off as { code: string }).code, "CONTRACT_INVALID", label);
    assert.match((off as { reason: string }).reason, required, label);
  }
  assert.match(reason(gcpContract({ embedStateWrite: "true" })), /^embedStateWrite: expected true or false/);
  // Through the driver: a contract without it seals nothing, before any engine call.
  const w = world();
  writeReviewedContract(w.contractPath, absent);
  const before = callsOf(fakeDir).length;
  const p = gcpProject();
  const refused = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, w.deps);
  assert.equal(refused.ok, false);
  assert.equal((refused as { code?: string }).code, "CONTRACT_INVALID");
  assert.equal(callsOf(fakeDir).length, before, "no engine call");
  // AWS and Azure Terraform are unchanged (an owner decision): a contract without embedStateWrite still loads.
  for (const raw of [awsContractJson(KILL), azureContractJson(KILL)]) {
    assert.equal("embedStateWrite" in raw, false);
    assert.equal(loadPilotContract(contractAt(raw)).enabled, true, (raw as { provider: string }).provider);
  }
});

test("DEV only: QA and PROD are refused in every form, and an AWS- or Azure-shaped target, or another target's fields, is not a GCP target", () => {
  const devTarget = gcpContract().targets.DEV;
  for (const [label, over, said] of [
    ["enabledEnvironments QA", { enabledEnvironments: ["QA"] }, /^enabledEnvironments: only the explicit DEV-only pilot/],
    ["enabledEnvironments PROD", { enabledEnvironments: ["PROD"] }, /^enabledEnvironments: only the explicit DEV-only pilot/],
    ["enabledEnvironments DEV and QA", { enabledEnvironments: ["DEV", "QA"] }, /^enabledEnvironments: only the explicit DEV-only pilot/],
    ["enabledEnvironments DEV and PROD", { enabledEnvironments: ["DEV", "PROD"] }, /^enabledEnvironments: only the explicit DEV-only pilot/],
    ["enabledEnvironments as text", { enabledEnvironments: "DEV" }, /^enabledEnvironments: only the explicit DEV-only pilot/],
    ["no enabledEnvironments", { enabledEnvironments: undefined }, /^enabledEnvironments: GCP TERRAFORM \(path 5\) is admitted for DEV only/],
    ["a QA target", { targets: { DEV: devTarget, QA: { ...devTarget, projectId: "alz-pilot-qa" } } }, /^targets\.QA: unknown field/],
    ["a PROD target", { targets: { DEV: devTarget, PROD: { ...devTarget, projectId: "alz-pilot-prod" } } }, /^targets\.PROD: unknown field/],
    ["QA approvals", { requiredApprovals: { DEV: 1, QA: 1 } }, /^requiredApprovals\.QA: unknown field/],
    ["a QA authorize entry", { authorize: { DEV: ["APPLY"], QA: ["APPLY"] } }, /^authorize\.QA: unknown field/],
    ["an AWS target", { targets: { DEV: { accountId: "111111111111", region: "us-east-1", backend: "alz-state/dev.tfstate", workspace: "default", canary: CANARY } } }, /^targets\.DEV\./],
    ["an Azure target", { targets: { DEV: { tenantId: "11111111-1111-1111-1111-111111111111", subscriptionId: "22222222-2222-2222-2222-222222222222", backend: "store/tfstate/dev.tfstate", workspace: "default" } } }, /^targets\.DEV\./],
    ["a Bicep resource group", { targets: { DEV: { ...devTarget, resourceGroup: "rg" } } }, /^targets\.DEV\.resourceGroup: unknown field/],
    ["the provider in lowercase", { provider: "gcp" }, /^provider and engine/],
  ] as const) {
    assert.match(reason(gcpContract(over as Record<string, unknown>)), said, label);
    const loaded = loadPilotContract(contractAt(gcpContract(over as Record<string, unknown>)));
    assert.ok("reason" in loaded && loaded.code === "CONTRACT_INVALID", label + ": " + JSON.stringify(loaded));
  }
  // A DEV-only contract has no QA or PROD to authorize, ever.
  const loaded = loadPilotContract(contractAt(gcpContract())) as PilotContract;
  for (const environment of ["QA", "PROD"] as const) {
    const refusal = authorizeContract(loaded, environment, "APPLY");
    assert.equal(refusal.ok, false, environment);
    assert.equal((refusal as { code?: string }).code, "ACT_NOT_AUTHORIZED", environment);
  }
  // E1: an APPLY needs the target's canary allowlist; the reviewed contract without one authorizes no APPLY (CLEANUP still is).
  const bare = loadPilotContract(contractAt(gcpContract({ targets: { DEV: { projectId: PROJECT, region: REGION, backend: BACKEND, workspace: "default" } } }))) as PilotContract;
  assert.equal((authorizeContract(bare, "DEV", "APPLY") as { code?: string }).code, "CANARY_ALLOWLIST_MISSING");
  assert.ok(authorizeContract(bare, "DEV", "CLEANUP").ok);
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
  assert.equal(hashOf({}), base, "deterministic");
  const variants = [
    hashOf({ parent: "folders/42" }), hashOf({ parent: "folders/43" }), hashOf({ parent: "organizations/42" }), hashOf({ projectId: "alz-pilot-dev2" }),
    hashOf({ region: "us-central1" }), hashOf({ backend: BUCKET + "/pilot/other" }), hashOf({ backend: BUCKET + "/pilot" }), hashOf({ workspace: "other" }),
    hashOf({ canary: CANARY }), hashOf({ canary: { resources: [{ type: "google_pubsub_topic", count: 2 }] } }),
  ];
  assert.equal(new Set([base, ...variants]).size, 1 + variants.length, "project, parent (absent or which), region, backend, workspace and canary each change the target hash");
  // The run's target is bound: a contract that later adds or moves the parent, or moves the project or region, no longer states it.
  const run = hashOf({ parent: "folders/42" })!;
  const later = (over: Record<string, unknown>) => loadPilotContract(contractAt(target({ parent: "folders/42", ...over }))) as PilotContract;
  assert.equal(targetMoved(run, later({}), "DEV"), undefined, "the same target");
  for (const over of [{ parent: "folders/43" }, { parent: undefined }, { projectId: "alz-pilot-dev2" }, { region: "us-central1" }]) {
    assert.equal(targetMoved(run, later(over), "DEV")?.code, "TARGET_NOT_IN_CONTRACT", JSON.stringify(over));
  }
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

test("the Terraform apply profile hands a child exactly the four Google identity variables and switches the metadata server off; the base terraform profile hands none (review N1, N2 of #323)", () => {
  const env = identityEnv();
  const extra = { ALZ_APPLY_GOOGLE_CREDENTIALS: "/run/key.json", ALZ_APPLY_GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.x", ALZ_APPLY_GCE_METADATA_HOST: "169.254.169.254", ALZ_APPLY_CLOUDSDK_CONFIG: "/x" };
  const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base: { ...env, ...extra }, toolDirs: [toolDir], home: fresh("home"), tmp: fresh("tmp"), identity: "APPLY" });
  for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"]) assert.equal(child.env[name], env["ALZ_APPLY_" + name], name);
  for (const name of ["GOOGLE_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_CONFIG"]) assert.equal(child.env[name], undefined, name + " never reaches a child");
  assert.deepEqual(child.refused, ["ALZ_APPLY_CLOUDSDK_CONFIG", "ALZ_APPLY_GCE_METADATA_HOST", "ALZ_APPLY_GOOGLE_CREDENTIALS", "ALZ_APPLY_GOOGLE_OAUTH_ACCESS_TOKEN"].sort());
  assert.equal(child.env.GCE_METADATA_HOST, "metadata.invalid", "the fixed value, not the identity's");
  assert.equal(child.env.GCE_METADATA_IP, "metadata.invalid");
  assert.equal(child.env.NO_GCE_CHECK, "True");
  // N1: the general terraform profile (the tool runner, the teardown adapter) takes no Google variable at all.
  const general = buildChildEnvironment({ profile: PROFILES.terraform, base: { ...env, ...extra }, toolDirs: [toolDir], home: fresh("home"), tmp: fresh("tmp"), identity: "APPLY" });
  assert.deepEqual(Object.keys(general.env).filter((name) => /^(GOOGLE|GCLOUD|CLOUDSDK|GCE)_|^NO_GCE_CHECK$/.test(name)), [], "no Google variable or metadata setting");
  assert.ok(general.refused.includes("ALZ_APPLY_GOOGLE_APPLICATION_CREDENTIALS") && general.refused.includes("ALZ_APPLY_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"));
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
/** The canary topic's storage policy as hashicorp/google 8.9.0 plans it (R2 of G1): exactly the contract's region. */
const STORAGE_POLICY = { message_storage_policy: [{ allowed_persistence_regions: [REGION], enforce_in_transit: null }] };
const created = (address: string, type: string) => ({
  address, type, mode: "managed", provider_name: GOOGLE, change: { actions: ["create"], before: null, after: { name: "x", ...(type === "google_pubsub_topic" ? STORAGE_POLICY : {}) } },
});
/** The canary plan: exactly one Pub/Sub topic created (owner decision E1). */
const CREATES = [created("google_pubsub_topic.unit", "google_pubsub_topic")];
const stateOf = (type: string, name: string, id: string) => ({ mode: "managed", type, name, provider: 'provider["' + GOOGLE + '"]', instances: [{ schema_version: 0, attributes: { id, secret_value: STATE_CANARY } }] });
const STATE = [
  stateOf("google_pubsub_topic", "unit", TOPIC), stateOf("google_service_account", "app", APP_SA), stateOf("google_storage_bucket", "data", DATA_BUCKET),
  // In the state but not in the plan: a service account, a data bucket and the state bucket itself, none created by this run.
  stateOf("google_storage_bucket", "state", BUCKET),
];
const PROVIDER_CONFIG = { google: { name: "google", full_name: GOOGLE, expressions: { project: { constant_value: PROJECT }, default_labels: { references: ["local.unit_labels"] } } } };
/** What init saves for the gcs backend: the contract's bucket and prefix; the credential settings stay null (filled at apply from the APPLY env). */
const SAVED = { type: "gcs", config: { bucket: BUCKET, prefix: "pilot/dev", credentials: null, impersonate_service_account: null, access_token: null, storage_custom_endpoint: null } };

type Cloud = { topics: Set<string>; tagged: string[]; requests: GcpRequest[]; regions?: unknown };
function fakeGoogle(cloud: Cloud): GcpHttp {
  return async (request) => {
    cloud.requests.push(request);
    const url = new URL(request.url);
    if (request.method === "POST" && request.url === "https://sts.googleapis.com/v1/token") return { status: 200, body: JSON.stringify({ access_token: FEDERATED_CANARY, token_type: "Bearer" }) };
    if (request.method === "POST" && url.host === "iamcredentials.googleapis.com") return { status: 200, body: JSON.stringify({ accessToken: ACCESS_CANARY, expireTime: "2026-10-27T15:00:00Z" }) };
    if (request.method === "GET" && url.host === "pubsub.googleapis.com") {
      const name = url.pathname.replace(/^\/v1\//, "");
      // The topic reports the storage policy it was created with (D11), unless a test says otherwise (null: none at all).
      const policy = cloud.regions === undefined ? { messageStoragePolicy: { allowedPersistenceRegions: [REGION] } } : cloud.regions === null ? {} : { messageStoragePolicy: { allowedPersistenceRegions: cloud.regions } };
      return cloud.topics.has(name) ? { status: 200, body: JSON.stringify({ name, labels: {}, ...policy }) } : { status: 404, body: "{}" };
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
    showProviderConfig: PROVIDER_CONFIG, savedBackend: SAVED, providerSelections: { [GOOGLE]: "8.9.0" },
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

/** The reviewed google provider (8.9.0) with its official linux_amd64 package hash: what `terraform providers lock` writes. */
const LINUX_H1 = "h1:1REt6EKYmjtrLK5PC/AHGZ2FFaHs0EMsvLOyv2eADeA=";
const lockOf = (version = "8.9.0", hashes = [LINUX_H1]) =>
  '# lock\nprovider "' + GOOGLE + '" {\n  version     = "' + version + '"\n  constraints = "' + version + '"\n  hashes = [\n' + hashes.map((h) => '    "' + h + '",\n').join("") + "  ]\n}\n";
function gcpProject(lock = lockOf()) {
  const projectRoot = fresh("project");
  writeFileSync(join(projectRoot, "main.tf"), 'resource "google_pubsub_topic" "unit" {\n  name = "alz-unit-topic"\n}\n');
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), lock);
  const resolved = { engineVersion: ENGINE_VERSION, providers: lockedProviders(lock), lockFileSha256: sha(lock), dependencies: [], inputs: [{ name: "region", identity: H("f") }] };
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
  // Review N2 of #341: the evidence names the product commit that sealed and ran the plan.
  assert.equal(s.sealed.sourceCommit, SOURCE_COMMIT);
  assert.equal(applied.evidence.sourceCommit, SOURCE_COMMIT);
  // Review N2 of #341: the driver kept the blueprint from the state the apply left, identifiers only, bound to this apply's evidence.
  const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(applied.evidence as never)), w.evidenceDir);
  assert.ok(blueprint, "the blueprint was kept");
  assert.equal(blueprint.source, "TERRAFORM_STATE_PULL");
  assert.equal(blueprint.sourceCommit, SOURCE_COMMIT);
  assert.equal(blueprint.unitId, s.sealed.unit?.unitId);
  assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.type, e.id, e.origin]), [
    ["google_pubsub_topic.unit", "google_pubsub_topic", TOPIC, "IN_PLAN"], ["google_service_account.app", "google_service_account", APP_SA, "NOT_IN_PLAN"],
    ["google_storage_bucket.data", "google_storage_bucket", DATA_BUCKET, "NOT_IN_PLAN"], ["google_storage_bucket.state", "google_storage_bucket", BUCKET, "NOT_IN_PLAN"],
  ]);
  assert.deepEqual(blueprint.blueprint.missing, []);
  noSecretIn("blueprint", blueprint);
  // The apply-time init wrote STATE_WRITE's credential path and service account into the backend file, and nothing else of an identity.
  const applyInit = callsOf(fakeDir).filter((c) => c.args[0] === "init").at(-1)!;
  // A literal comparison, never a pattern built from a value (review 6453205218, B1: CodeQL js/incomplete-sanitization).
  assert.ok(String(applyInit.backendConfig).includes('impersonate_service_account = "' + email("STATE_WRITE") + '"'), "STATE_WRITE's service account");
  assert.ok(String(applyInit.backendConfig).includes('bucket = "' + BUCKET + '"') && String(applyInit.backendConfig).includes('prefix = "pilot/dev"'), "the contract's bucket and prefix");
  assert.doesNotMatch(String(applyInit.backendConfig), /access_token|endpoint|encryption_key/);
  const applyCall = callsOf(fakeDir).find((c) => c.args[0] === "apply")!;
  assert.equal(applyCall.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT, email("APPLY"), "terraform apply runs as APPLY");
  assert.equal(applyCall.env.GCE_METADATA_HOST, "metadata.invalid", "with the metadata server off");
  assert.equal(applyCall.env.NO_GCE_CHECK, "True");
  // The post-init check read the providers init selected: the reviewed google version only.
  assert.ok(callsOf(fakeDir).some((c) => c.args[0] === "version"), "provider_selections were read after init");

  const observation = await observeRun(s.sealed.artifactSha256, w.observe());
  assert.ok(observation.ok, JSON.stringify(observation));
  assert.equal(observation.record.verifier, "GCP_REST");
  assert.equal(observation.record.sourceCommit, SOURCE_COMMIT, "the observation names the same product commit");
  const results = new Map(observation.record.resources.map((r) => [r.address, [r.result, r.reason]]));
  assert.deepEqual(results.get("google_pubsub_topic.unit"), ["VERIFIED", undefined]);
  assert.deepEqual(results.get("google_service_account.app"), ["UNVERIFIABLE", "NO_GCP_READ_MAPPING"], "a type the reader has no read for is named, never assumed");
  assert.equal(observation.record.inventory, "COMPLETE");
  assert.deepEqual(observation.record.unexpected, []);
  // D15 (G1): the reader minted one token per host, Pub/Sub's with the pubsub scope, never the read-only cloud-platform scope (GF2).
  const minted = w.cloud.requests.filter((r) => r.url.endsWith(":generateAccessToken")).map((r) => (JSON.parse(r.body ?? "{}") as { scope: string[] }).scope.join(" ")).sort();
  assert.deepEqual(minted, ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/pubsub"]);
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
    "google_service_account.app": "PROTECTED_IDENTITY", "google_storage_bucket.data": "NOT_IN_PLAN", "google_storage_bucket.state": "PROTECTED_BACKEND",
  });
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

// --- E1: the canary allowlist for GCP -------------------------------------------------------------------------------------

const sealRefusal = async (w: World, project = gcpProject()) => {
  const result = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: project.manifest, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved, requester: REQUESTER }, w.deps);
  assert.equal(result.ok, false, JSON.stringify(result));
  return result as { ok: false; code: string; message: string };
};
const rebehave = (over: Behavior) => behaveIn(fakeDir, KILL, {
  applyAdvance: true, showOnlyConfigured: true, showResources: CREATES, stateResources: STATE, unitTagAttribute: "effective_labels",
  showProviderConfig: PROVIDER_CONFIG, savedBackend: SAVED, providerSelections: { [GOOGLE]: "8.9.0" }, ...over,
});

test("canary (GCP Terraform, owner decision E1): one google_pubsub_topic seals; a subscription, a topic or project IAM binding, or a second topic is RESOURCE_NOT_IN_CANARY at seal, and an apply re-derives the same judgment", async () => {
  // The allowlist's type is judged by the generic Terraform rule: an exact type, never a pattern.
  assert.ok(TERRAFORM.canaryTypeOk!("google_pubsub_topic"));
  for (const type of ["google_pubsub_*", "google_pubsub_topic*", "GOOGLE_PUBSUB_TOPIC", "google", "pubsub_topic.unit"]) {
    assert.match(reason(gcpContract({ targets: { DEV: { ...gcpContract().targets.DEV, canary: { resources: [{ type, count: 1 }] } } } })), /canary\.resources\[0\]\.type: invalid/, type);
  }
  // The control: exactly one topic seals, and the canary is in the sealed target hash.
  const w0 = world();
  const s = await seal(w0);
  assert.equal(s.sealed.targetSha256, pilotTargetSha256(loadPilotContract(w0.contractPath) as PilotContract, "DEV"));

  for (const [label, extra, said] of [
    ["a subscription", [created("google_pubsub_subscription.unit", "google_pubsub_subscription")], /google_pubsub_subscription\.unit: type google_pubsub_subscription is not in the canary allowlist/],
    ["a topic IAM member", [created("google_pubsub_topic_iam_member.publisher", "google_pubsub_topic_iam_member")], /type google_pubsub_topic_iam_member is not in the canary allowlist/],
    ["a topic IAM binding", [created("google_pubsub_topic_iam_binding.publishers", "google_pubsub_topic_iam_binding")], /type google_pubsub_topic_iam_binding is not in the canary allowlist/],
    ["a topic IAM policy", [created("google_pubsub_topic_iam_policy.all", "google_pubsub_topic_iam_policy")], /type google_pubsub_topic_iam_policy is not in the canary allowlist/],
    ["a project IAM member", [created("google_project_iam_member.owner", "google_project_iam_member")], /type google_project_iam_member is not in the canary allowlist/],
    ["a project IAM binding", [created("google_project_iam_binding.owners", "google_project_iam_binding")], /type google_project_iam_binding is not in the canary allowlist/],
    ["a second topic", [created("google_pubsub_topic.second", "google_pubsub_topic")], /google_pubsub_topic: the plan creates 2, the canary allowlist names exactly 1/],
    ["an update of an existing topic", [{ ...created("google_pubsub_topic.existing", "google_pubsub_topic"), change: { actions: ["update"], before: {}, after: { ...STORAGE_POLICY } } }], /google_pubsub_topic\.existing \(google_pubsub_topic\): the plan would \["update"\] it/],
  ] as const) {
    const w = world();
    rebehave({ showResources: [...CREATES, ...extra] });
    const refusal = await sealRefusal(w);
    assert.equal(refusal.code, "RESOURCE_NOT_IN_CANARY", label + ": " + refusal.message);
    assert.match(refusal.message, said, label);
    assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "apply"), label + ": nothing applied");
  }
  // No topic at all is refused too: the allowlist names exactly one.
  const none = world();
  rebehave({ showResources: [] });
  const empty = await sealRefusal(none);
  assert.equal(empty.code, "RESOURCE_NOT_IN_CANARY");
  assert.match(empty.message, /google_pubsub_topic: the plan creates 0, the canary allowlist names exactly 1/);

  // A sealed canary whose plan grows a subscription by the time the apply re-derives the change list is refused before anything runs.
  rebehave({ showResources: [...CREATES, created("google_pubsub_subscription.late", "google_pubsub_subscription")] });
  const late = await apply(w0, s);
  assert.equal(late.ok, false);
  assert.equal((late as { code: string }).code, "RESOURCE_NOT_IN_CANARY", JSON.stringify(late));
  assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "apply"), "nothing applied");
});

// --- the reviewed hashicorp/google version ---------------------------------------------------------------------------------

test("hashicorp/google is pinned to the reviewed 8.9.0 with HashiCorp's official hashes: another version, an unofficial hash, or another google source refuses the seal; init's own selection is checked again", async () => {
  assert.equal(GCP_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/google 8.9.0", "re-review the denied types against the new schema before changing this");
  assert.equal(REVIEWED_PROVIDER_VERSIONS[GOOGLE], "8.9.0");
  const official = OFFICIAL_PROVIDER_HASHES[GOOGLE + " 8.9.0"]!;
  assert.equal([...official].filter((h) => h.startsWith("zh:")).length, 11, "one zh: per platform zip in the signed SHA256SUMS");
  assert.deepEqual([...official].filter((h) => h.startsWith("h1:")).sort(), ["h1:1REt6EKYmjtrLK5PC/AHGZ2FFaHs0EMsvLOyv2eADeA=", "h1:EcUkiM2dD/TtxkpcH/2BtPFp8oHIiU4x6R/Dn43sS3Y="]);
  assert.equal(unreviewedProviderVersion(lockedProviders(lockOf())), undefined);
  assert.equal(unofficialProviderHash(lockOf("8.9.0", [...official])), undefined, "every official hash is accepted");
  assert.deepEqual(unreviewedProviderVersion(lockedProviders(lockOf("8.8.1"))), { source: GOOGLE, locked: "8.8.1", reviewed: "8.9.0" });
  assert.deepEqual(unofficialProviderHash(lockOf("8.9.0", ["h1:" + "A".repeat(43) + "="])), { source: GOOGLE, version: "8.9.0" });
  assert.deepEqual(unofficialProviderHash(lockOf("8.9.0", [])), { source: GOOGLE, version: "8.9.0" }, "no hash at all");
  assert.deepEqual(unofficialProviderHash(lockOf("8.9.0", ["h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg="])), { source: GOOGLE, version: "8.9.0" }, "azurerm's hash under google");

  for (const [label, lock, code] of [
    ["8.8.1", lockOf("8.8.1"), "PROVIDER_VERSION_NOT_REVIEWED"],
    ["9.0.0", lockOf("9.0.0"), "PROVIDER_VERSION_NOT_REVIEWED"],
    ["an unofficial hash", lockOf("8.9.0", ["zh:" + "0".repeat(64)]), "PROVIDER_HASH_NOT_OFFICIAL"],
  ] as const) {
    const w = world();
    const refusal = await sealRefusal(w, gcpProject(lock));
    assert.ok(JSON.stringify(refusal).includes(code), label + ": " + JSON.stringify(refusal));
    assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "init"), label + ": refused before init");
  }
  // After init, what Terraform actually selected: another google version, google-beta, or another registry host is refused before any plan.
  for (const [label, selections, code] of [
    ["init selected 8.8.1", { [GOOGLE]: "8.8.1" }, "PROVIDER_VERSION_NOT_REVIEWED"],
    ["google-beta", { [GOOGLE]: "8.9.0", "registry.terraform.io/hashicorp/google-beta": "8.9.0" }, "PROVIDER_NOT_ADMITTED"],
    ["an OpenTofu host", { "registry.opentofu.org/hashicorp/google": "8.9.0" }, "PROVIDER_NOT_ADMITTED"],
    ["aws in a GCP project", { [GOOGLE]: "8.9.0", "registry.terraform.io/hashicorp/aws": "6.68.0" }, "PROVIDER_NOT_ADMITTED"],
  ] as const) {
    const w = world();
    rebehave({ providerSelections: selections });
    const refusal = await sealRefusal(w);
    assert.ok(JSON.stringify(refusal).includes(code), label + ": " + JSON.stringify(refusal));
    assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "plan"), label + ": no plan ran");
  }
});

// --- N3 and the data-source judge through the seal -----------------------------------------------------------------------------

test("review N3 of #323 through the seal: a google_project data source naming another project, or none, is refused and nothing is sealed; the contract's project passes", async () => {
  const dataSource = (expressions: Record<string, unknown>) => ({
    showConfigurationExtra: { root_module: { resources: [{ address: "data.google_project.this", mode: "data", type: "google_project", name: "this", provider_config_key: "google", expressions }] } },
  });
  const passing = world();
  rebehave(dataSource({ project_id: { constant_value: PROJECT } }));
  const sealed = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, ...(() => { const p = gcpProject(); return { manifest: p.manifest, projectRoot: p.projectRoot, resolved: p.resolved }; })(), policyVersion: POLICY, requester: REQUESTER }, passing.deps);
  assert.ok(sealed.ok, JSON.stringify(sealed));
  // At seal the judge's code is named in the refusal (the driver maps a *_NOT_IN_CONTRACT code to TARGET_NOT_IN_CONTRACT at apply and cleanup).
  for (const [label, expressions, code] of [
    ["another project", { project_id: { constant_value: "alz-other-project" } }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["the provider's default", {}, "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT"],
    ["an expression", { project_id: { references: ["var.project"] } }, "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT"],
  ] as const) {
    const w = world();
    rebehave(dataSource(expressions));
    const refusal = await sealRefusal(w);
    assert.ok(refusal.message.includes("(" + code + ")"), label + ": " + JSON.stringify(refusal));
    assert.ok(!refusal.message.includes("alz-other-project"), label + ": the refusal names the code, never the value");
  }
  // A read value naming another project (the prior state of a data source) is refused even when the configuration names the contract's.
  const w = world();
  rebehave({
    ...dataSource({ project_id: { constant_value: PROJECT } }),
    showDocumentExtra: { prior_state: { values: { root_module: { resources: [{ address: "data.google_project.this", mode: "data", type: "google_project", name: "this", provider_name: GOOGLE, values: { project_id: "alz-other-project", number: "1" } }] } } } },
  });
  assert.ok((await sealRefusal(w)).message.includes("(PROVIDER_ACCOUNT_NOT_IN_CONTRACT)"));
});

test("review N1 of #339 through the seal: a topic planned in another project, unknown until apply, or configured by an expression, and a provider block without the contract's constant project, seal nothing", async () => {
  const topicIn = (after: Record<string, unknown>, afterUnknown: Record<string, unknown> = {}) =>
    [{ ...created("google_pubsub_topic.unit", "google_pubsub_topic"), change: { actions: ["create"], before: null, after: { name: "x", ...STORAGE_POLICY, ...after }, after_unknown: afterUnknown } }];
  const configured = (project: unknown) => ({
    showConfigurationExtra: { root_module: { resources: [{ address: "google_pubsub_topic.unit", mode: "managed", type: "google_pubsub_topic", name: "unit", provider_config_key: "google", expressions: { name: { constant_value: "alz-unit-topic" }, message_storage_policy: [{ allowed_persistence_regions: { constant_value: [REGION] } }], project } }] } },
  });
  // The control: planned in the contract's project, configured with its constant.
  const ok = world();
  rebehave({ showResources: topicIn({ project: PROJECT }, { project: false }), ...configured({ constant_value: PROJECT }) });
  const p = gcpProject();
  const sealed = await sealPreview({ invocation: human(DEV), environment: "DEV", target: DEV, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER }, ok.deps);
  assert.ok(sealed.ok, JSON.stringify(sealed));
  for (const [label, behavior, code] of [
    ["planned in another project", { showResources: topicIn({ project: "victim-proj-123" }) }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["planned project unknown until apply", { showResources: topicIn({}, { project: true }) }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["configured in another project", configured({ constant_value: "victim-proj-123" }), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["configured by an expression", configured({ references: ["var.p"] }), "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["a provider block whose project is an expression", { showProviderConfig: { google: { ...PROVIDER_CONFIG.google, expressions: { ...PROVIDER_CONFIG.google.expressions, project: { references: ["var.p"] } } } } }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
  ] as const) {
    const w = world();
    rebehave(behavior as Behavior);
    const refusal = await sealRefusal(w);
    assert.ok(refusal.message.includes("(" + code + ")"), label + ": " + JSON.stringify(refusal));
    assert.ok(!refusal.message.includes("victim-proj-123"), label + ": the refusal names the code, never the value");
  }
});

test("R1 and R2 of G1 through the seal and the apply: a topic with CMEK, a schema, retention or a tag binding, or stored outside the contract's region, seals nothing; a sealed canary whose re-derived plan changes region is refused before anything runs", async () => {
  const topicWith = (after: Record<string, unknown>, afterUnknown: Record<string, unknown> = {}) =>
    [{ ...created("google_pubsub_topic.unit", "google_pubsub_topic"), change: { actions: ["create"], before: null, after: { name: "x", ...STORAGE_POLICY, ...after }, after_unknown: afterUnknown } }];
  for (const [label, after, afterUnknown, code] of [
    ["CMEK", { kms_key_name: "projects/other-proj/locations/europe-west4/keyRings/r/cryptoKeys/k" }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["a schema", { schema_settings: [{ schema: "projects/other-proj/schemas/s", encoding: "JSON" }] }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["an ingestion source", { ingestion_data_source_settings: [{ cloud_storage: [{ bucket: "other" }] }] }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["a JavaScript transform", { message_transforms: [{ javascript_udf: [{ code: "x", function_name: "f" }] }] }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["message retention", { message_retention_duration: "86400s" }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["a tag binding", { tags: { "tagKeys/1": "tagValues/2" } }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["ABANDON on destroy", { deletion_policy: "ABANDON" }, {}, "CANARY_ATTRIBUTE_NOT_IN_CONTRACT"],
    ["another region", { message_storage_policy: [{ allowed_persistence_regions: ["us-central1"] }] }, {}, "LOCATION_NOT_IN_CONTRACT"],
    ["no storage policy", { message_storage_policy: [] }, {}, "LOCATION_NOT_IN_CONTRACT"],
    ["a region unknown until apply", {}, { message_storage_policy: [{ allowed_persistence_regions: [true] }] }, "LOCATION_NOT_IN_CONTRACT"],
  ] as const) {
    const w = world();
    rebehave({ showResources: topicWith(after, afterUnknown) });
    const refusal = await sealRefusal(w);
    assert.ok(refusal.message.includes("(" + code + ")"), label + ": " + JSON.stringify(refusal));
    assert.ok(!refusal.message.includes("other-proj") && !refusal.message.includes("us-central1"), label + ": the refusal names the code, never the value");
    assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "apply"), label + ": nothing applied");
  }
  // The re-derivation at apply runs the same judge: a plan that now stores elsewhere is the contract's target no more.
  const w = world();
  const s = await seal(w);
  rebehave({ showResources: topicWith({ message_storage_policy: [{ allowed_persistence_regions: ["us-central1"] }] }) });
  const moved = await apply(w, s);
  assert.equal(moved.ok, false);
  assert.equal((moved as { code: string }).code, "TARGET_NOT_IN_CONTRACT", JSON.stringify(moved));
  assert.match((moved as { message: string }).message, /LOCATION_NOT_IN_CONTRACT/);
  assert.ok(callsOf(fakeDir).every((c) => c.args[0] !== "apply"), "nothing applied");
});

test("D11 read-back (G1): observation compares the topic's storage policy with the contract's region; another region FAILS as DIFFERENT_FROM_DESIRED and no cleanup is proposed, a missing policy is not observable yet", async () => {
  const w = world();
  const s = await seal(w);
  assert.ok((await apply(w, s)).ok);
  const resultOf = async (regions: unknown) => {
    w.cloud.regions = regions;
    const observed = await observeRun(s.sealed.artifactSha256, w.observe());
    assert.ok(observed.ok, JSON.stringify(observed));
    const topic = observed.record.resources.find((r) => r.address === "google_pubsub_topic.unit")!;
    return [observed.record.verdict, topic.result, topic.reason];
  };
  // PARTIAL overall only because this fixture's state also holds types the reader has no read for (named, never assumed).
  assert.deepEqual(await resultOf(undefined), ["PARTIAL", "VERIFIED", undefined], "exactly the contract's region");
  assert.deepEqual(await resultOf(["us-central1"]), ["FAILED", "DIFFERENT_FROM_DESIRED", "LOCATION_NOT_IN_CONTRACT"]);
  assert.deepEqual(await resultOf([REGION, "us-central1"]), ["FAILED", "DIFFERENT_FROM_DESIRED", "LOCATION_NOT_IN_CONTRACT"], "a second region");
  const records = await loadRunRecords(s.sealed.artifactSha256, w.evidenceDir);
  assert.ok(records.ok);
  const contract = loadPilotContract(w.contractPath) as PilotContract;
  const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract, engineVersion: s.sealed.engineVersion, env: w.deps.env!, now: new Date(NOW.getTime() + 120_000) });
  assert.equal(built.ok, false, "a run whose topic is stored elsewhere gets no product cleanup (D11)");
  assert.equal((built as { code?: string }).code, "OBSERVATION_INCONCLUSIVE");
  assert.deepEqual(await resultOf(null), ["INCONCLUSIVE", "NOT_YET_OBSERVABLE", "STORAGE_POLICY_NOT_READ"], "no policy in the answer is unknown, never assumed");
});
