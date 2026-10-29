import assert from "node:assert/strict";
import test from "node:test";

import { isDevOnlyPath, parsePilotContract, pilotTargetSha256, targetSha256Of } from "../src/apply/contract.js";
import { engineSpec } from "../src/apply/engine-spec.js";
import { GCP_API_BACKEND_SENTINEL, GCP_API_TARGET, PARENT_LABEL, TOPIC_PREFIX } from "../src/apply/gcp-api-target.js";
import { GCP } from "../src/apply/providers/gcp.js";
import type { PilotTarget } from "../src/apply/types.js";
import { PRODUCTION_DEPLOYMENT_CONTRACT } from "../src/qualification/production-contract.js";
import { approvers } from "./helpers/apply-fixtures.js";

// SYNTHETIC. The GCP API-native target shape and its target hash (docs/act-pilot-gcp-api-driver.md D4 and D9, owner-accepted
// 6483366237). No engine is registered for GCP_API here; that is lane G2, then INT-2.

const shared = { schemaVersion: 1, enabled: true, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: "/nonexistent/alz-kill", authorize: { DEV: ["APPLY"] } };
const three = { requiredApprovals: { DEV: 1, QA: 1, PROD: 2 } };
const devOnly = { enabledEnvironments: ["DEV"], requiredApprovals: { DEV: 1 } };
const awsCanary = { resources: [{ type: "aws_cloudwatch_log_group", count: 1 }] };
const azureCanary = { resources: [{ type: "azurerm_resource_group", count: 1 }] };
const cdkCanary = { resources: [{ type: "AWS::S3::Bucket", count: 1 }, { type: "AWS::SNS::Topic", count: 1 }] };
/** One contract per implemented path, written out here so the pinned hashes below depend on nothing else. */
const CONTRACTS: Readonly<Record<string, object>> = {
  "aws-terraform": { ...shared, ...three, provider: "AWS", engine: "TERRAFORM", embedStateWrite: true, targets: {
    DEV: { accountId: "111111111111", region: "us-east-1", backend: "examplefake-dev-state/pilot/dev.tfstate", workspace: "default", canary: awsCanary },
    QA: { accountId: "222222222222", region: "us-east-1", backend: "examplefake-qa-state/pilot/qa.tfstate", workspace: "default", canary: awsCanary },
    PROD: { accountId: "333333333333", region: "us-east-1", backend: "examplefake-prod-state/pilot/prod.tfstate", workspace: "default", canary: awsCanary },
  } },
  "azure-terraform": { ...shared, ...three, provider: "AZURE", engine: "TERRAFORM", embedStateWrite: true, targets: {
    DEV: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default", location: "westeurope", canary: azureCanary },
    QA: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "44444444-4444-4444-8444-444444444444", backend: "fixtureqastore/tfstate/qa.tfstate", workspace: "default", location: "westeurope", canary: azureCanary },
    PROD: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "33333333-3333-4333-8333-333333333333", backend: "fixtureprodstore/tfstate/prod.tfstate", workspace: "default", location: "westeurope", canary: azureCanary },
  } },
  "aws-cdk": { ...shared, ...three, provider: "AWS", engine: "CDK", targets: {
    DEV: { accountId: "111111111111", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: [], canary: cdkCanary },
    QA: { accountId: "222222222222", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: [], canary: cdkCanary },
    PROD: { accountId: "333333333333", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: [], canary: cdkCanary },
  } },
  "azure-bicep": { ...shared, ...devOnly, provider: "AZURE", engine: "BICEP", targets: {
    DEV: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", backend: "alz-pilot-stack", workspace: "default", resourceGroup: "alz-pilot-dev", location: "eastus2", canary: { resources: [{ type: "Microsoft.Network/virtualNetworks", count: 1 }] } },
  } },
  "gcp-terraform": { ...shared, ...devOnly, provider: "GCP", engine: "TERRAFORM", embedStateWrite: true, targets: {
    DEV: { projectId: "alz-pilot-dev", region: "europe-west4", parent: "folders/123456789", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } },
  } },
};
/** The target hashes these contracts had on main ae39be6, before the hash moved into one shared helper. */
const PINNED: readonly [string, "DEV" | "QA" | "PROD", string][] = [
  ["aws-terraform", "DEV", "3423e5c344dace045af015778584928bc1394dec43adf915e4742bd7f1723398"],
  ["aws-terraform", "QA", "091d6e3c1dac7542dd02036a3fbf72188e45944c2f2d37357977c0ff970ea42e"],
  ["aws-terraform", "PROD", "b37f7802468c1303232cbb41916f8b48b223aab90a524854757c56555ff1bb6a"],
  ["azure-terraform", "DEV", "9a5c4e4227b14cd4fdb722ab8b79b11f7047ffa13fb600a96587996332eda64a"],
  ["azure-terraform", "QA", "e3ed787ed545ca7782a05502806c191601a6dec2a1da13b7b0e9df767fa77dc1"],
  ["azure-terraform", "PROD", "da0eaf59feb4a340f99a85e851877122b27dd9e58153d9d29523e3e76e4e6a47"],
  ["aws-cdk", "DEV", "68e5f416b4ffc3a7851c3658f9f39c540e24f8f9c8f6a36d6d853f9d5a997383"],
  ["aws-cdk", "QA", "fb16d1f90d7f14aace9e6eece36ee48f1d6c21a5f179d5cf111dcec61a6fa7e3"],
  ["aws-cdk", "PROD", "2a31ccf3220ff1e57e348f686318351896d068c3c2141bf04e82aacae5624ff5"],
  ["azure-bicep", "DEV", "0c8f170cbce3f86df41ad073f2eaa21c0b63f82b21528eb0898ed5e445cad28f"],
  ["gcp-terraform", "DEV", "0a7cd8b9d7359d9292b1c7b86b1f9b89713394d20df4c66643f543bf3d0569cf"],
];

test("D9: every implemented path's target hash is byte-identical to main's (AWS and Azure Terraform, CDK, Bicep, GCP Terraform)", () => {
  for (const [path, env, hash] of PINNED) {
    const contract = parsePilotContract(JSON.stringify(CONTRACTS[path]));
    assert.ok(contract.enabled, path + ": " + JSON.stringify(contract));
    assert.equal(pilotTargetSha256(contract, env), hash, path + " " + env);
  }
});

const apiTarget = (over: Record<string, unknown> = {}): PilotTarget => ({
  projectId: "alz-pilot-dev", region: "us-central1", backend: GCP_API_BACKEND_SENTINEL, workspace: "default", topicPrefix: "alz-act-dev1-",
  canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] }, ...over,
} as unknown as PilotTarget);
const apiHash = (over: Record<string, unknown> = {}): string => targetSha256Of(GCP, GCP_API_TARGET, apiTarget(over));

test("D9: every GCP API-native target field joins the target hash: the project, the region, the prefix, the backend sentinel, the workspace, the canary, and parent when stated", () => {
  const base = apiHash();
  assert.equal(apiHash(), base, "deterministic");
  for (const [field, value] of [
    ["projectId", "alz-pilot-dev2"], ["region", "europe-west4"], ["topicPrefix", "alz-act-dev2-"], ["backend", "GCP_API_NO_STATE2"], ["workspace", "other"],
    ["canary", { resources: [{ type: "google_pubsub_topic", count: 2 }] }], ["parent", "folders/123456789"],
  ] as const) {
    assert.notEqual(apiHash({ [field]: value }), base, field + " moves the target");
  }
  assert.notEqual(apiHash({ parent: "folders/1" }), apiHash({ parent: "folders/2" }), "a moved parent moves the target");
  // Without its location field, the same target would hash like a GCP Terraform target: the prefix is what makes it this path's.
  assert.notEqual(base, targetSha256Of(GCP, undefined, apiTarget()));
});

test("D4: the GCP API-native target shape: the backend is exactly the sentinel, the workspace exactly default, and the prefix an alz- namespace", () => {
  assert.equal(GCP_API_TARGET.backendOk("GCP_API_NO_STATE"), true);
  for (const bad of ["gcp_api_no_state", "GCP_API_NO_STATE ", "alz-pilot-dev-state/pilot/dev", "", "alz-act-dev1-"]) assert.equal(GCP_API_TARGET.backendOk(bad), false, bad);
  assert.equal(GCP_API_TARGET.workspaceOk("default"), true);
  assert.equal(GCP_API_TARGET.workspaceOk("dev"), false);
  assert.deepEqual(GCP_API_TARGET.locationFields, ["topicPrefix"]);
  for (const good of ["alz-act-dev1-", "alz-a-", "alz-" + "a".repeat(40) + "-"]) assert.ok(TOPIC_PREFIX.test(good) && GCP_API_TARGET.fields.topicPrefix(good), good);
  for (const bad of ["alz-", "alz--x", "alz-act-dev1", "ALZ-act-", "alz-act_dev-", "act-dev1-", "alz-" + "a".repeat(41) + "-", 7, undefined]) {
    assert.equal(GCP_API_TARGET.fields.topicPrefix(bad), false, String(bad));
  }
  // The prefix plus the 12-character suffix drawn at seal is always a valid topic id (alz-, at most 64 characters, D10).
  assert.ok(/^alz-[a-z0-9-]{1,59}[a-z0-9]$/.test("alz-" + "a".repeat(40) + "-" + "0123456789ab"));
  assert.equal(PARENT_LABEL, "owner-declared, not observed");
});

test("D9 and INT-2: GCP API-native is DEV only, loads with its own target shape, and is admitted with its own mutation, never as GCP Terraform", () => {
  assert.equal(isDevOnlyPath("GCP", "GCP_API"), true);
  assert.equal(isDevOnlyPath("GCP", "TERRAFORM"), true);
  assert.equal(isDevOnlyPath("AWS", "TERRAFORM"), false);
  const contract = parsePilotContract(JSON.stringify({ ...shared, ...devOnly, provider: "GCP", engine: "GCP_API", targets: { DEV: apiTarget() } }));
  assert.ok(contract.enabled, JSON.stringify(contract));
  // Its target hash is the shared rule over the GCP_API shape: what targetSha256Of gives for the same target.
  assert.equal(pilotTargetSha256(contract, "DEV"), targetSha256Of(GCP, GCP_API_TARGET, apiTarget()));
  // DEV only: without the scope statement, or with a QA target, it does not load.
  const unscoped = parsePilotContract(JSON.stringify({ ...shared, ...three, provider: "GCP", engine: "GCP_API", targets: { DEV: apiTarget(), QA: apiTarget({ projectId: "alz-pilot-qa" }), PROD: apiTarget({ projectId: "alz-pilot-prod" }) } }));
  assert.equal(unscoped.enabled, false);
  assert.match((unscoped as { reason: string }).reason, /admitted for DEV only/);
  // A GCP Terraform target (a gcs backend, no topicPrefix) is not a GCP_API target, and the reverse.
  const asTerraformTarget = parsePilotContract(JSON.stringify({ ...shared, ...devOnly, provider: "GCP", engine: "GCP_API", targets: { DEV: { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } } }));
  assert.equal(asTerraformTarget.enabled, false);
  const asApiTarget = parsePilotContract(JSON.stringify({ ...shared, ...devOnly, provider: "GCP", engine: "TERRAFORM", embedStateWrite: true, targets: { DEV: apiTarget() } }));
  assert.equal(asApiTarget.enabled, false);
  const combinations = PRODUCTION_DEPLOYMENT_CONTRACT.spec.release.actPilot.combinations as readonly { provider: string; engine: string; mutation: string }[];
  assert.deepEqual(combinations.filter((c) => c.provider === "GCP").map((c) => [c.engine, c.mutation]), [["TERRAFORM", "TERRAFORM_APPLY_OF_SEALED_PLAN"], ["GCP_API", "GCP_PUBSUB_TOPIC_CREATE_OF_SEALED_REQUEST"]]);
});

test("#358 review N4: a GCP_API canary allows exactly one google_pubsub_topic, refused at contract load otherwise; GCP Terraform keeps the general bound", () => {
  const load = (engine: "GCP_API" | "TERRAFORM", count: unknown) => parsePilotContract(JSON.stringify(engine === "GCP_API"
    ? { ...shared, ...devOnly, provider: "GCP", engine, targets: { DEV: apiTarget({ canary: { resources: [{ type: "google_pubsub_topic", count }] } }) } }
    : { ...shared, ...devOnly, provider: "GCP", engine, embedStateWrite: true, targets: { DEV: { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count }] } } } }));
  assert.equal(load("GCP_API", 1).enabled, true);
  for (const count of [2, 10, 10_000]) {
    const refused = load("GCP_API", count);
    assert.equal(refused.enabled, false, String(count));
    assert.equal((refused as { code: string }).code, "CONTRACT_INVALID");
    assert.match((refused as { reason: string }).reason, /targets\.DEV\.canary\.resources\[0\]\.count: the GCP_API engine creates at most 1 google_pubsub_topic per run, so its canary allows exactly 1/);
  }
  for (const count of [0, -1, 1.5, "1"]) assert.equal(load("GCP_API", count).enabled, false, String(count));
  assert.equal(load("TERRAFORM", 2).enabled, true, "GCP Terraform is unchanged: the general bound applies");
  assert.equal(engineSpec("GCP_API")?.canaryCountMax, 1);
  for (const id of ["TERRAFORM", "CDK", "BICEP"] as const) assert.equal(engineSpec(id)?.canaryCountMax, undefined, id);
});
