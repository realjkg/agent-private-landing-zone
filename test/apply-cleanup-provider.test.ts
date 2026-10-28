import assert from "node:assert/strict";
import test from "node:test";

import { protectedDeletionIn } from "../src/apply/cleanup-proposal.js";
import type { PilotContract, PlanChange } from "../src/apply/types.js";

// Review N5 of #310: the cleanup classifier (`protectionOf` in src/apply/cleanup-proposal.ts) answers per provider, and a provider
// with no branch of its own is never "an ordinary leaf". SYNTHETIC: contracts and blueprint entries are explicit fixtures, cast where
// the provider id is one the types do not name; nothing reads a cloud or runs an engine. Every project and bucket below is fake.

type Entry = { address: string; type: string; id: string | null; arn: string | null; holdsIdentityArn?: true };
const contractOf = (provider: string, targets: Record<string, unknown>): PilotContract => ({ provider, engine: "TERRAFORM", targets } as unknown as PilotContract);
const deleting = (entry: Entry): PlanChange => ({ address: entry.address, type: entry.type, action: "DELETE" });
const verdict = (contract: PilotContract, entry: Entry): string | undefined => protectedDeletionIn([deleting(entry)], [entry], contract, {});
const codeIn = (message: string | undefined): string | undefined => message === undefined ? undefined : /\(([A-Z_]+)\)\.$/.exec(message)?.[1];

const GCP_CONTRACT = contractOf("GCP", {
  DEV: { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default" },
  QA: { projectId: "alz-pilot-qa", region: "europe-west4", backend: "alz-pilot-qa-state/pilot/qa", workspace: "default" },
});

test("a provider with no classifier branch fails closed: every entry is unclassifiable, never an ordinary leaf, whatever its type or id", () => {
  for (const provider of ["OCI", "", "aws", "Azure", "gcp"]) {
    const contract = contractOf(provider, { DEV: { backend: "state/pilot", workspace: "default" } });
    for (const entry of [
      { address: "x_leaf.a", type: "x_leaf", id: "leaf-1", arn: null },
      { address: "google_pubsub_topic.t", type: "google_pubsub_topic", id: "projects/alz-pilot-dev/topics/t", arn: null },
      { address: "aws_sqs_queue.q", type: "aws_sqs_queue", id: "https://sqs.us-east-1.amazonaws.com/111111111111/q", arn: "arn:aws:sqs:us-east-1:111111111111:q" },
      { address: "y.none", type: "y", id: null, arn: null },
    ]) {
      const message = verdict(contract, entry);
      assert.ok(message !== undefined, JSON.stringify(provider) + " " + entry.type + " must not pass as ordinary");
      assert.match(message, /OWNERSHIP_AMBIGUOUS/, JSON.stringify(provider) + " " + entry.type);
    }
  }
});

test("the GCP branch is wired: only a reviewed leaf passes; the state buckets of every environment, identities, containers and unreviewed types are kept", () => {
  const leaf = { address: "google_pubsub_topic.t", type: "google_pubsub_topic", id: "projects/alz-pilot-dev/topics/alz-t", arn: null };
  assert.equal(verdict(GCP_CONTRACT, leaf), undefined, "google_pubsub_topic is the one reviewed leaf");
  const cases: [string, Entry][] = [
    ["PROTECTED_BACKEND", { address: "google_storage_bucket.state", type: "google_storage_bucket", id: "alz-pilot-dev-state", arn: null }],
    ["PROTECTED_BACKEND", { address: "google_storage_bucket.qa", type: "google_storage_bucket", id: "gs://alz-pilot-qa-state", arn: null }],
    ["PROTECTED_BACKEND", { address: "google_storage_bucket_iam_member.m", type: "google_storage_bucket_iam_member", id: "b/alz-pilot-dev-state roles/storage.admin user:x@example.com", arn: null }],
    ["PROTECTED_IDENTITY", { address: "google_service_account.sa", type: "google_service_account", id: "projects/alz-pilot-dev/serviceAccounts/x@alz-pilot-dev.iam.gserviceaccount.com", arn: null }],
    ["PROTECTED_IDENTITY", { address: "google_project_iam_member.m", type: "google_project_iam_member", id: null, arn: null }],
    ["CONTAINS_OTHERS", { address: "google_project.p", type: "google_project", id: "projects/alz-pilot-dev", arn: null }],
    ["CONTAINS_OTHERS", { address: "google_project_service.s", type: "google_project_service", id: "alz-pilot-dev/pubsub.googleapis.com", arn: null }],
    ["TYPE_UNREVIEWED", { address: "google_storage_bucket.data", type: "google_storage_bucket", id: "alz-pilot-dev-data", arn: null }],
    ["OWNERSHIP_AMBIGUOUS", { address: "google_pubsub_topic.blank", type: "google_pubsub_topic", id: " ", arn: null }],
    ["OWNERSHIP_AMBIGUOUS", { address: "terraform_data.w", type: "terraform_data", id: "serviceAccount:x@alz-pilot-dev.iam.gserviceaccount.com", arn: null }],
    ["OWNERSHIP_AMBIGUOUS", { address: "google_pubsub_topic.wrapped", type: "google_pubsub_topic", id: "projects/alz-pilot-dev/topics/w", arn: null, holdsIdentityArn: true }],
  ];
  for (const [code, entry] of cases) {
    const message = verdict(GCP_CONTRACT, entry);
    assert.ok(message !== undefined, entry.address + " must be kept");
    if (code === "OWNERSHIP_AMBIGUOUS") assert.match(message, /OWNERSHIP_AMBIGUOUS/, entry.address);
    else assert.equal(codeIn(message), code, entry.address + ": " + message);
  }
  // A dependent the state does not hold is judged by its type alone, as on AWS and Azure.
  assert.equal(codeIn(protectedDeletionIn([{ address: "google_service_account_key.k", type: "google_service_account_key", action: "DELETE" }], [], GCP_CONTRACT, {})), "PROTECTED_IDENTITY");
});

test("the AWS and Azure branches are unchanged by the fail-closed default (controls)", () => {
  const aws = contractOf("AWS", { DEV: { accountId: "111111111111", region: "us-east-1", backend: "alz-state/pilot/dev", workspace: "default" } });
  assert.equal(codeIn(verdict(aws, { address: "aws_s3_bucket.state", type: "aws_s3_bucket", id: "alz-state", arn: null })), "PROTECTED_BACKEND");
  assert.equal(codeIn(verdict(aws, { address: "aws_iam_role.r", type: "aws_iam_role", id: "r", arn: null })), "PROTECTED_IDENTITY");
  const azure = contractOf("AZURE", { DEV: { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", backend: "alzstate/tfstate/dev.tfstate", workspace: "default" } });
  assert.equal(codeIn(verdict(azure, { address: "azurerm_resource_group.g", type: "azurerm_resource_group", id: null, arn: null })), "RETAINED_GROUP");
  assert.equal(verdict(azure, {
    address: "azurerm_virtual_network.v", type: "azurerm_virtual_network", arn: null,
    id: "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-pilot/providers/Microsoft.Network/virtualNetworks/vnet-pilot",
  }), undefined, "an ordinary Azure resource still passes");
});
