import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { normalizeBicepWhatIf } from "../src/iac/bicep-whatif.js";
import { normalizeCloudFormationChangeSet } from "../src/iac/cloudformation-changeset.js";
import { normalizePulumiPreview } from "../src/iac/pulumi-preview.js";
import { checkCreateTraceability, evaluateDestroyPreview, reportOrphans } from "../src/teardown/gates.js";
import {
  parseAwsTaggedResources,
  parseAzureTaggedResources,
  readBicepWhatIfTags,
  readCloudFormationChangeSetTags,
  readPulumiPreviewTags,
} from "../src/teardown/readers.js";
import type { DeletionUnit, DeletionUnitStateRef } from "../src/teardown/types.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";

const DESIGN_HASH = "d".repeat(64);
const BUILD_ID = "build-6c1f0a52-9d3e-4b7a-8e21-0f4c5d6a7b89";
const PULUMI_UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

const PULUMI_STATE: DeletionUnitStateRef = {
  engine: "PULUMI", backendUrl: "s3://alz-pulumi/state", stack: "alz-build-1",
};
const CFN_STATE: DeletionUnitStateRef = {
  engine: "CLOUDFORMATION", region: "eu-west-1", stackName: "alz-build-1",
};
const BICEP_STATE: DeletionUnitStateRef = {
  engine: "BICEP", scope: "/subscriptions/0000/resourceGroups/alz-build-1",
  deploymentStackName: "alz-build-1",
};

const BUCKET = "urn:pulumi:dev::alz::aws:s3/bucket:Bucket::audit";
const ATTACH = "urn:pulumi:dev::alz::aws:iam/rolePolicyAttachment:RolePolicyAttachment::attach";

type Tags = Record<string, string>;
const pulumiStep = (op: string, urn: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ op, urn, newState: { urn, type, ...extra } });
const pulumi = (steps: unknown[]) => JSON.stringify({ steps });

function pulumiCreatePlan(tags?: Tags, tagsAll?: Tags | string) {
  return pulumi([
    pulumiStep("create", BUCKET, "aws:s3/bucket:Bucket", {
      inputs: tags ? { bucket: "audit", tags } : { bucket: "audit" },
      outputs: tagsAll === undefined ? {} : { tagsAll },
    }),
    pulumiStep("create", ATTACH, "aws:iam/rolePolicyAttachment:RolePolicyAttachment", {
      inputs: { role: "audit" },
    }),
    pulumiStep("same", "urn:pulumi:dev::alz::pulumi:pulumi:Stack::alz-dev", "pulumi:pulumi:Stack"),
  ]);
}

function unitFrom(stateRef: DeletionUnitStateRef, createPlan: ReturnType<typeof normalizePulumiPreview>) {
  return recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef,
    designHash: DESIGN_HASH, createPlan, recordedAt: "2026-10-10T12:00:00.000Z" });
}

test("pulumi: tagsAll wins, computed tags and untaggable types are told apart, only creates read", () => {
  const tags = readPulumiPreviewTags(pulumi([
    pulumiStep("create", "a", "t", { inputs: { tags: { own: "1" } }, outputs: { tagsAll: { merged: "2" } } }),
    pulumiStep("create", "b", "t", { inputs: { tags: { own: "1" } }, outputs: { tagsAll: PULUMI_UNKNOWN } }),
    pulumiStep("create", "c", "t", { inputs: { tags: PULUMI_UNKNOWN } }),
    pulumiStep("create", "d", "t", { inputs: { name: "no tags set" } }),
    pulumiStep("create", "e", "aws:iam/policyAttachment:PolicyAttachment", { inputs: {} }),
    pulumiStep("update", "f", "t", { inputs: { tags: {} } }),
    pulumiStep("create-replacement", "g", "t", { inputs: { tags: {} } }),
  ]), { untaggableTypes: new Set(["aws:iam/policyAttachment:PolicyAttachment"]) });
  assert.deepEqual(tags.get("a"), { kind: "TAGGED", tags: { merged: "2" } });
  assert.deepEqual(tags.get("b"), { kind: "TAGGED", tags: { own: "1" } });
  assert.deepEqual(tags.get("c"), { kind: "UNKNOWN_AT_PLAN" });
  assert.deepEqual(tags.get("d"), { kind: "TAGGED", tags: {} });
  assert.deepEqual(tags.get("e"), { kind: "UNTAGGABLE" });
  assert.equal(tags.has("f"), false);
  assert.equal(tags.has("g"), false);
});

test("pulumi end to end: create gate and destroy preview over the real preview shapes", () => {
  const untaggable = { untaggableTypes: new Set(["aws:iam/rolePolicyAttachment:RolePolicyAttachment"]) };
  const unit = unitFrom(PULUMI_STATE, normalizePulumiPreview(pulumiCreatePlan()));
  assert.deepEqual(unit.plannedCreates, [ATTACH, BUCKET].sort());

  const json = pulumiCreatePlan(unit.tags);
  const ok = checkCreateTraceability(unit, normalizePulumiPreview(json),
    readPulumiPreviewTags(json, untaggable));
  assert.equal(ok.verdict, "TRACEABLE", ok.reasons.join("; "));
  assert.deepEqual(ok.tagged, [BUCKET]);
  assert.deepEqual(ok.stateOnly, [ATTACH]);

  // The attachment has no tags and is not allowlisted: blocked, not silently state-only.
  const strict = checkCreateTraceability(unit, normalizePulumiPreview(json), readPulumiPreviewTags(json));
  assert.equal(strict.verdict, "BLOCKED");
  assert.match(strict.reasons.join("\n"), /UNTAGGED_CREATE: urn:pulumi:.*RolePolicyAttachment/);

  const untagged = pulumiCreatePlan();
  assert.match(checkCreateTraceability(unit, normalizePulumiPreview(untagged),
    readPulumiPreviewTags(untagged, untaggable)).reasons.join("\n"), /UNTAGGED_CREATE: urn:pulumi:.*Bucket/);

  const destroy = pulumi([pulumiStep("delete", BUCKET, "aws:s3/bucket:Bucket"),
    pulumiStep("delete", ATTACH, "aws:iam/rolePolicyAttachment:RolePolicyAttachment")]);
  assert.equal(evaluateDestroyPreview(unit, normalizePulumiPreview(destroy)).verdict, "READY_FOR_AUTHORIZATION");
  const stray = pulumi([pulumiStep("delete", BUCKET, "x"),
    pulumiStep("delete", "urn:pulumi:dev::alz::aws:s3/bucket:Bucket::customer", "x")]);
  const blocked = evaluateDestroyPreview(unit, normalizePulumiPreview(stray));
  assert.equal(blocked.verdict, "BLOCKED");
  assert.match(blocked.reasons.join("\n"), /DELETE_OUTSIDE_UNIT: .*customer/);
});

const CFN_BUCKET = "AuditBucket";
const CFN_ROLE = "AuditRole";
function cfnChange(id: string, type: string, afterContext?: unknown, action = "Add") {
  return { Type: "Resource", ResourceChange: {
    Action: action, LogicalResourceId: id, ResourceType: type,
    ...(afterContext === undefined ? {} : { AfterContext: afterContext }),
  } };
}
const cfnContext = (properties: unknown, doubleEncode = false) => JSON.stringify({
  Properties: doubleEncode ? JSON.stringify(properties) : properties, Metadata: {},
});
const cfn = (changes: unknown[]) => JSON.stringify({ ChangeSetName: "alz-preview", Changes: changes });
const cfnTags = (tags: Tags) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

test("cloudformation: reads AfterContext tags, and reports nothing when the change set has none", () => {
  const tags = readCloudFormationChangeSetTags(cfn([
    cfnChange("A", "AWS::S3::Bucket", cfnContext({ Tags: cfnTags({ k: "v" }) })),
    cfnChange("B", "AWS::S3::Bucket", cfnContext({ Tags: cfnTags({ k: "v" }) }, true)),
    cfnChange("C", "AWS::SSM::Parameter", cfnContext({ Tags: { map: "form" } })),
    cfnChange("D", "AWS::S3::Bucket", cfnContext({ BucketName: "no-tags" })),
    cfnChange("E", "AWS::S3::Bucket", cfnContext({ Tags: [{ Key: "k", Value: { Ref: "Param" } }] })),
    cfnChange("F", "AWS::IAM::Policy", cfnContext({})),
    cfnChange("G", "AWS::S3::Bucket"),
    cfnChange("H", "AWS::S3::Bucket", "{not json"),
    cfnChange("I", "AWS::S3::Bucket", cfnContext({ Tags: [] }), "Modify"),
  ]), { untaggableTypes: new Set(["AWS::IAM::Policy"]) });
  assert.deepEqual(tags.get("A"), { kind: "TAGGED", tags: { k: "v" } });
  assert.deepEqual(tags.get("B"), { kind: "TAGGED", tags: { k: "v" } });
  assert.deepEqual(tags.get("C"), { kind: "TAGGED", tags: { map: "form" } });
  assert.deepEqual(tags.get("D"), { kind: "TAGGED", tags: {} });
  assert.deepEqual(tags.get("E"), { kind: "UNKNOWN_AT_PLAN" });
  assert.deepEqual(tags.get("F"), { kind: "UNTAGGABLE" });
  for (const absent of ["G", "H", "I"]) assert.equal(tags.has(absent), false, absent);
});

test("cloudformation end to end: tags must be proven by the change set itself", () => {
  const creates = (tags?: Tags, withContext = true) => cfn([
    cfnChange(CFN_BUCKET, "AWS::S3::Bucket",
      withContext ? cfnContext(tags ? { Tags: cfnTags(tags) } : {}) : undefined),
    cfnChange(CFN_ROLE, "AWS::IAM::Role",
      withContext ? cfnContext(tags ? { Tags: cfnTags(tags) } : {}) : undefined),
  ]);
  const unit = unitFrom(CFN_STATE, normalizeCloudFormationChangeSet(creates()));
  const check = (json: string) => checkCreateTraceability(unit,
    normalizeCloudFormationChangeSet(json), readCloudFormationChangeSetTags(json));

  const ok = check(creates(unit.tags));
  assert.equal(ok.verdict, "TRACEABLE", ok.reasons.join("; "));
  assert.deepEqual(ok.tagged, [CFN_ROLE, CFN_BUCKET].sort());

  assert.match(check(creates()).reasons.join("\n"), /UNTAGGED_CREATE: AuditBucket/);
  // Created without --include-property-values: no AfterContext, so tags are unproven.
  const noContext = check(creates(unit.tags, false));
  assert.equal(noContext.verdict, "BLOCKED");
  assert.match(noContext.reasons.join("\n"), /TAGS_NOT_REPORTED: AuditBucket/);
});

const SUB = "/subscriptions/0000/resourceGroups/alz-build-1/providers";
const SA = SUB + "/Microsoft.Storage/storageAccounts/alzaudit";
const RA = SUB + "/Microsoft.Authorization/roleAssignments/1234";
function bicepChange(resourceId: string, changeType: string, after?: unknown) {
  return { resourceId, changeType, ...(after === undefined ? {} : { after }) };
}
const bicep = (changes: unknown[]) => JSON.stringify({ status: "Succeeded", changes });

test("bicep: reads after.tags of creates; an omitted tags block is an empty tag set", () => {
  const tags = readBicepWhatIfTags(bicep([
    bicepChange(SA, "Create", { type: "Microsoft.Storage/storageAccounts", tags: { k: "v" } }),
    bicepChange(SUB + "/x/untagged", "Create", { type: "Microsoft.Storage/storageAccounts" }),
    bicepChange(RA, "Create", { type: "Microsoft.Authorization/roleAssignments" }),
    bicepChange(SUB + "/x/modified", "Modify", { tags: { k: "v" } }),
    bicepChange(SUB + "/x/noafter", "Create"),
  ]), { untaggableTypes: new Set(["Microsoft.Authorization/roleAssignments"]) });
  assert.deepEqual(tags.get(SA), { kind: "TAGGED", tags: { k: "v" } });
  assert.deepEqual(tags.get(SUB + "/x/untagged"), { kind: "TAGGED", tags: {} });
  assert.deepEqual(tags.get(RA), { kind: "UNTAGGABLE" });
  assert.equal(tags.has(SUB + "/x/modified"), false);
  assert.equal(tags.has(SUB + "/x/noafter"), false);
});

test("bicep end to end: create gate and a destroy preview that stays inside the unit", () => {
  const creates = (tags?: Tags) => bicep([
    bicepChange(SA, "Create", { type: "Microsoft.Storage/storageAccounts", ...(tags ? { tags } : {}) }),
    bicepChange(RA, "Create", { type: "Microsoft.Authorization/roleAssignments" }),
  ]);
  const unit = unitFrom(BICEP_STATE, normalizeBicepWhatIf(creates()));
  const untaggable = { untaggableTypes: new Set(["Microsoft.Authorization/roleAssignments"]) };
  const json = creates(unit.tags);
  const ok = checkCreateTraceability(unit, normalizeBicepWhatIf(json), readBicepWhatIfTags(json, untaggable));
  assert.equal(ok.verdict, "TRACEABLE", ok.reasons.join("; "));
  assert.deepEqual(ok.stateOnly, [RA]);
  const bad = creates();
  assert.match(checkCreateTraceability(unit, normalizeBicepWhatIf(bad),
    readBicepWhatIfTags(bad, untaggable)).reasons.join("\n"), /UNTAGGED_CREATE/);

  const destroy = bicep([bicepChange(SA, "Delete"), bicepChange(RA, "Delete")]);
  assert.equal(evaluateDestroyPreview(unit, normalizeBicepWhatIf(destroy)).verdict, "READY_FOR_AUTHORIZATION");
  const extra = bicep([bicepChange(SA, "Delete"), bicepChange(SUB + "/x/customer", "Delete")]);
  assert.equal(evaluateDestroyPreview(unit, normalizeBicepWhatIf(extra)).verdict, "BLOCKED");
});

const awsList = (items: unknown[], token = "") =>
  JSON.stringify({ PaginationToken: token, ResourceTagMappingList: items });
const ARN = "arn:aws:logs:eu-west-1:123456789012:log-group:/alz/audit";

test("inventories: AWS and Azure listings become tag-only, never-authoritative resources", () => {
  const aws = parseAwsTaggedResources(awsList([
    { ResourceARN: ARN, Tags: [{ Key: "alz-managed-by", Value: "alz" }, { Key: "alz-unit", Value: "alzu-1" }] },
    { ResourceARN: "arn:aws:s3:::alz-bucket", Tags: [] },
    { Tags: [] },
  ]));
  assert.equal(aws.complete, true);
  assert.equal(aws.resources.length, 2);
  assert.deepEqual(aws.resources[0], {
    resourceId: ARN, provider: "AWS", resourceType: "aws:logs", name: "log-group:/alz/audit",
    scope: "123456789012", region: "eu-west-1",
    tags: { "alz-managed-by": "alz", "alz-unit": "alzu-1" },
    metadata: { inventory: "resourcegroupstaggingapi" },
    ownership: "UNKNOWN", mutationPolicy: "READ_ONLY", sourceOfTruth: "UNKNOWN",
  });
  assert.equal(parseAwsTaggedResources(awsList([], "next-page")).complete, false);
  // `aws ... --max-items N` truncates with a CLI-level NextToken, not the service's PaginationToken.
  assert.equal(parseAwsTaggedResources(JSON.stringify({
    ResourceTagMappingList: [], PaginationToken: "", NextToken: "eyJNYXJrZXIiOm51bGx9",
  })).complete, false);
  assert.throws(() => parseAwsTaggedResources("{}"), /TAGGED_INVENTORY_INVALID/);

  const azure = parseAzureTaggedResources(JSON.stringify([
    { id: SA, name: "alzaudit", type: "Microsoft.Storage/storageAccounts",
      location: "westeurope", resourceGroup: "alz-build-1", tags: { "alz-managed-by": "alz" } },
    { id: SUB + "/x/notags", name: "n", type: "t", tags: null },
  ]));
  assert.equal(azure.resources[0].provider, "AZURE");
  assert.equal(azure.resources[0].mutationPolicy, "READ_ONLY");
  assert.equal(azure.resources[0].ownership, "UNKNOWN");
  assert.deepEqual(azure.resources[1].tags, {});
  assert.throws(() => parseAzureTaggedResources("{}"), /TAGGED_INVENTORY_INVALID/);
});

test("orphans over a real-shaped AWS listing: tracked, unknown unit, and no authority gained", () => {
  const unit = unitFrom(PULUMI_STATE, normalizePulumiPreview(pulumiCreatePlan()));
  const inventory = parseAwsTaggedResources(awsList([
    { ResourceARN: ARN, Tags: Object.entries(unit.tags).map(([Key, Value]) => ({ Key, Value })) },
    { ResourceARN: "arn:aws:sqs:eu-west-1:123456789012:lost", Tags: [
      { Key: "alz-managed-by", Value: "alz" }, { Key: "alz-unit", Value: "alzu-gone" }] },
    { ResourceARN: "arn:aws:s3:::customer", Tags: [{ Key: "team", Value: "payments" }] },
  ]));
  const report = reportOrphans(inventory.resources, [unit], "2026-10-10");
  assert.deepEqual(report.findings.map((f) => f.status), ["TRACKED", "ORPHAN_UNKNOWN_UNIT"]);
  assert.equal(report.orphans, 1);
  assert.ok(inventory.resources.every((r) => r.mutationPolicy === "READ_ONLY" && r.ownership === "UNKNOWN"));
});

test("./alz teardown CLI: pulumi unit, untaggable allowlist, and an incomplete listing never exits clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "alz-teardown-readers-"));
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", resolve("src/cli/teardown.ts"), ...args],
    { encoding: "utf8", cwd: process.cwd() });
  try {
    const file = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const recorded = cli("record", "--engine", "PULUMI", "--build-id", BUILD_ID, "--provider", "AWS",
      "--state", file("state.json", JSON.stringify(PULUMI_STATE)), "--design-hash", DESIGN_HASH,
      "--plan", file("create.json", pulumiCreatePlan()));
    assert.equal(recorded.status, 0, recorded.stderr);
    const unit = JSON.parse(recorded.stdout) as DeletionUnit;
    const unitPath = file("unit.json", recorded.stdout);
    const tagged = file("tagged.json", pulumiCreatePlan(unit.tags));

    const strict = cli("check-plan", "--unit", unitPath, "--plan", tagged);
    assert.equal(strict.status, 2);
    assert.match(strict.stdout, /UNTAGGED_CREATE/);
    const allowed = cli("check-plan", "--unit", unitPath, "--plan", tagged,
      "--untaggable-types", "aws:iam/rolePolicyAttachment:RolePolicyAttachment");
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).verdict, "TRACEABLE");

    const preview = cli("destroy-preview", "--unit", unitPath, "--plan", file("destroy.json",
      pulumi([pulumiStep("delete", BUCKET, "x"), pulumiStep("delete", ATTACH, "x")])));
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).verdict, "READY_FOR_AUTHORIZATION");

    const tags = Object.entries(unit.tags).map(([Key, Value]) => ({ Key, Value }));
    const complete = cli("orphans", "--units", unitPath, "--aws-tagged",
      file("aws.json", awsList([{ ResourceARN: ARN, Tags: tags }])));
    assert.equal(complete.status, 0, complete.stdout + complete.stderr);
    assert.equal(JSON.parse(complete.stdout).inventoryComplete, true);
    const paginated = cli("orphans", "--units", unitPath, "--aws-tagged",
      file("aws-page.json", awsList([{ ResourceARN: ARN, Tags: tags }], "more")));
    assert.equal(paginated.status, 2);
    assert.equal(JSON.parse(paginated.stdout).inventoryComplete, false);

    assert.equal(cli("orphans", "--units", unitPath).status, 1);
    assert.equal(cli("record", "--engine", "ANSIBLE", "--build-id", BUILD_ID, "--provider", "AWS",
      "--state", file("s2.json", "{}"), "--design-hash", DESIGN_HASH,
      "--plan", file("c2.json", "{}")).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("known untaggable CloudFormation types are never read as untagged, with or without AfterContext", () => {
  const tags = readCloudFormationChangeSetTags(cfn([
    cfnChange("CDKMetadata", "AWS::CDK::Metadata"),
    cfnChange("Policy", "AWS::IAM::Policy", cfnContext({ PolicyName: "p" })),
    cfnChange("Role", "AWS::IAM::Role", cfnContext({})),
  ]));
  assert.deepEqual(tags.get("CDKMetadata"), { kind: "UNTAGGABLE" });
  assert.deepEqual(tags.get("Policy"), { kind: "UNTAGGABLE" });
  // A taggable type that omits tags is still an empty tag set (blocked), not exempted.
  assert.deepEqual(tags.get("Role"), { kind: "TAGGED", tags: {} });
});

test("an AWS CDK unit is checked against a CloudFormation change set; other engine pairs still must match", () => {
  const plan = normalizeCloudFormationChangeSet(cfn([cfnChange("Bucket", "AWS::S3::Bucket", cfnContext({}))]));
  const cdk: DeletionUnitStateRef = { engine: "AWS_CDK", region: "eu-west-1", stackName: "alz-build-1" };
  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: cdk, designHash: DESIGN_HASH, createPlan: plan });
  assert.equal(unit.engine, "AWS_CDK");
  const json = cfn([cfnChange("Bucket", "AWS::S3::Bucket", cfnContext({ Tags: cfnTags(unit.tags) }))]);
  const ok = checkCreateTraceability(unit, normalizeCloudFormationChangeSet(json), readCloudFormationChangeSetTags(json));
  assert.equal(ok.verdict, "TRACEABLE", ok.reasons.join("; "));
  assert.equal(evaluateDestroyPreview(unit, normalizeCloudFormationChangeSet(cfn([
    cfnChange("Bucket", "AWS::S3::Bucket", undefined, "Remove")]))).verdict, "READY_FOR_AUTHORIZATION");
  // Not symmetric and not general: CDK may use CloudFormation plans, nothing else crosses engines.
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: cdk, designHash: DESIGN_HASH,
    createPlan: normalizePulumiPreview(pulumiCreatePlan()) }), /STATE_REF_ENGINE_MISMATCH/);
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: CFN_STATE, designHash: DESIGN_HASH,
    createPlan: normalizePulumiPreview(pulumiCreatePlan()) }), /STATE_REF_ENGINE_MISMATCH/);
});
