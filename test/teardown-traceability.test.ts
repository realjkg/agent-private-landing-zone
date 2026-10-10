import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { DiscoveredResource } from "../src/discovery/types.js";
import { normalizeOpenTofuPlan, normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import {
  checkCreateTraceability,
  evaluateDestroyPreview,
  readTerraformPlanTags,
  reportOrphans,
} from "../src/teardown/gates.js";
import type { DeletionUnit, DeletionUnitStateRef } from "../src/teardown/types.js";
import {
  ALZ_TAG_KEYS,
  deletionUnitId,
  provenanceTags,
  recordDeletionUnit,
  verifyDeletionUnit,
} from "../src/teardown/unit.js";

const DESIGN_HASH = "d".repeat(64);
const BUILD_ID = "build-0b7e4c1a-3f2d-4e5a-9b8c-7d6e5f4a3b2c";
const S3_STATE: DeletionUnitStateRef = {
  engine: "TERRAFORM", backend: "s3",
  location: "s3://alz-state/builds/" + BUILD_ID + "/terraform.tfstate", workspace: "default",
};

type PlannedResource = {
  address: string;
  type: string;
  actions: string[];
  after?: Record<string, unknown> | null;
  afterUnknown?: Record<string, unknown>;
};

/** A `terraform show -json` plan with just the fields ALZ reads. */
function planJson(resources: PlannedResource[]): string {
  return JSON.stringify({
    format_version: "1.2",
    resource_changes: resources.map((resource) => ({
      address: resource.address,
      type: resource.type,
      change: {
        actions: resource.actions,
        after: resource.after === undefined ? {} : resource.after,
        after_unknown: resource.afterUnknown ?? {},
      },
    })),
  });
}

function unitFor(json: string, stateRef: DeletionUnitStateRef = S3_STATE, expires?: string) {
  return recordDeletionUnit({
    buildId: BUILD_ID, provider: "AWS", stateRef, designHash: DESIGN_HASH,
    createPlan: normalizeTerraformPlan(json), expires,
    recordedAt: "2026-10-10T12:00:00.000Z",
  });
}

const createPlanResources = (tags: Record<string, string>): PlannedResource[] => [
  { address: "aws_cloudwatch_log_group.alz_audit", type: "aws_cloudwatch_log_group",
    actions: ["create"], after: { name: "/alz/audit", tags_all: tags } },
  { address: "aws_iam_role_policy_attachment.audit", type: "aws_iam_role_policy_attachment",
    actions: ["create"], after: { role: "audit" } },
  { address: "data.aws_caller_identity.current", type: "aws_caller_identity",
    actions: ["read"], after: {} },
];

function tagsFor(unit: DeletionUnit): Record<string, string> {
  return { ...unit.tags, team: "platform" };
}

/** Record the unit from an untagged plan, then render the tagged plan the build would emit. */
function taggedBuild() {
  const unit = unitFor(planJson(createPlanResources({})));
  const json = planJson(createPlanResources(tagsFor(unit)));
  return { unit, json };
}

test("a deletion unit is deterministic, tag-safe and tamper-evident", () => {
  const { unit } = taggedBuild();
  assert.equal(unit.unitId, deletionUnitId(BUILD_ID, S3_STATE));
  assert.match(unit.unitId, /^alzu-[a-f0-9]{20}$/);
  assert.deepEqual(unit.plannedCreates,
    ["aws_cloudwatch_log_group.alz_audit", "aws_iam_role_policy_attachment.audit"]);
  assert.deepEqual(unit.tags, {
    "alz-managed-by": "alz", "alz-unit": unit.unitId, "alz-build": BUILD_ID,
  });
  // Same inputs, same unit; different state container, different unit.
  assert.equal(unitFor(planJson(createPlanResources({}))).unitHash, unit.unitHash);
  assert.notEqual(deletionUnitId(BUILD_ID, { ...S3_STATE, workspace: "other" }), unit.unitId);
  assert.equal(verifyDeletionUnit(unit), unit);

  for (const tampered of [
    { ...unit, plannedCreates: [...unit.plannedCreates, "aws_s3_bucket.customer_data"] },
    { ...unit, stateRef: { ...S3_STATE, workspace: "prod" } },
    { ...unit, tags: { ...unit.tags, "alz-build": "build-other" } },
  ]) {
    assert.throws(() => verifyDeletionUnit(tampered as DeletionUnit), /DELETION_UNIT_INVALID/);
  }
});

test("tag keys and values are valid for AWS, Azure and Kubernetes labels", () => {
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const azureForbidden = /[<>%&\\?/]/;
  const { unit } = taggedBuild();
  for (const [key, value] of Object.entries(unit.tags)) {
    assert.match(key, label);
    assert.match(value, label);
    assert.doesNotMatch(key + value, azureForbidden);
  }
  assert.throws(() => provenanceTags({ unitId: "alzu-x", buildId: "Build_UPPER" }),
    /BUILD_ID_NOT_TAG_SAFE/);
  assert.throws(() => provenanceTags({ unitId: "alzu-x", buildId: "b".repeat(64) }),
    /BUILD_ID_NOT_TAG_SAFE/);
  assert.throws(() => provenanceTags({ unitId: "alzu-x", buildId: "b", expires: "next week" }),
    /EXPIRES_NOT_ISO_DATE/);
  assert.equal(provenanceTags({ unitId: "alzu-x", buildId: "b", expires: "2026-12-31" })
    [ALZ_TAG_KEYS.expires], "2026-12-31");
});

test("a unit can only describe resources the build itself creates", () => {
  const record = (resources: PlannedResource[], stateRef = S3_STATE) =>
    recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef,
      designHash: DESIGN_HASH, createPlan: normalizeTerraformPlan(planJson(resources)) });
  assert.throws(() => record([
    { address: "aws_s3_bucket.customer", type: "aws_s3_bucket", actions: ["update"] },
    { address: "aws_sqs_queue.new", type: "aws_sqs_queue", actions: ["create"] },
  ]), /NON_ADDITIVE_PLAN:aws_s3_bucket.customer=UPDATE/);
  assert.throws(() => record([
    { address: "aws_vpc.main", type: "aws_vpc", actions: ["delete", "create"] },
  ]), /NON_ADDITIVE_PLAN/);
  assert.throws(() => record([
    { address: "data.aws_region.current", type: "aws_region", actions: ["read"] },
  ]), /NO_PLANNED_CREATES/);
  assert.throws(() => record(createPlanResources({}),
    { engine: "PULUMI", backendUrl: "s3://x", stack: "dev" }), /STATE_REF_ENGINE_MISMATCH/);
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS",
    stateRef: S3_STATE, designHash: "not-a-hash",
    createPlan: normalizeTerraformPlan(planJson(createPlanResources({}))) }), /DESIGN_HASH/);
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS",
    stateRef: S3_STATE, designHash: DESIGN_HASH,
    createPlan: { ...normalizeTerraformPlan(planJson(createPlanResources({}))), engine: "ANSIBLE" } }),
  /ANSIBLE_HAS_NO_DELETION_UNIT/);
});

test("plan tags: tags_all wins, unknown tags and untaggable types are told apart", () => {
  const tags = readTerraformPlanTags(planJson([
    { address: "a.merged", type: "a", actions: ["create"],
      after: { tags: { only: "resource" }, tags_all: { merged: "default_tags" } } },
    { address: "a.computed", type: "a", actions: ["create"], after: { tags_all: null },
      afterUnknown: { tags_all: true } },
    { address: "a.empty", type: "a", actions: ["create"], after: { tags: null } },
    { address: "a.untaggable", type: "a", actions: ["create"], after: { role: "x" } },
    { address: "a.updated", type: "a", actions: ["update"], after: { tags: {} } },
    { address: "a.replaced", type: "a", actions: ["delete", "create"], after: { tags: {} } },
  ]));
  assert.deepEqual(tags.get("a.merged"), { kind: "TAGGED", tags: { merged: "default_tags" } });
  assert.deepEqual(tags.get("a.computed"), { kind: "UNKNOWN_AT_PLAN" });
  assert.deepEqual(tags.get("a.empty"), { kind: "TAGGED", tags: {} });
  assert.deepEqual(tags.get("a.untaggable"), { kind: "UNTAGGABLE" });
  assert.equal(tags.has("a.updated"), false);
  assert.equal(tags.has("a.replaced"), false);
});

test("create traceability: exact unit, every taggable create stamped", () => {
  const { unit, json } = taggedBuild();
  const report = checkCreateTraceability(unit, normalizeTerraformPlan(json), readTerraformPlanTags(json));
  assert.equal(report.verdict, "TRACEABLE", report.reasons.join("; "));
  assert.equal(report.tagCoverage, "VERIFIED");
  assert.deepEqual(report.tagged, ["aws_cloudwatch_log_group.alz_audit"]);
  assert.deepEqual(report.stateOnly, ["aws_iam_role_policy_attachment.audit"]);

  // No tag reader for the engine: still checked against the unit, coverage UNVERIFIED.
  const stateOnly = checkCreateTraceability(unit, normalizeTerraformPlan(json));
  assert.equal(stateOnly.verdict, "TRACEABLE");
  assert.equal(stateOnly.tagCoverage, "UNVERIFIED");
});

test("create traceability blocks untagged, out-of-unit, missing and non-additive changes", () => {
  const { unit } = taggedBuild();
  const check = (resources: PlannedResource[], target: DeletionUnit = unit) => {
    const json = planJson(resources);
    return checkCreateTraceability(target, normalizeTerraformPlan(json), readTerraformPlanTags(json));
  };
  const tagged = createPlanResources(tagsFor(unit));

  const untagged = check(createPlanResources({ team: "platform" }));
  assert.equal(untagged.verdict, "BLOCKED");
  assert.match(untagged.reasons.join("\n"),
    /UNTAGGED_CREATE: aws_cloudwatch_log_group.alz_audit missing or wrong alz-managed-by, alz-unit, alz-build/);

  const wrongUnit = check(createPlanResources({ ...unit.tags, "alz-unit": "alzu-someoneelse" }));
  assert.match(wrongUnit.reasons.join("\n"), /UNTAGGED_CREATE: .* alz-unit/);

  const extra = check([...tagged, { address: "aws_sqs_queue.extra", type: "aws_sqs_queue",
    actions: ["create"], after: { tags_all: tagsFor(unit) } }]);
  assert.match(extra.reasons.join("\n"), /CREATE_OUTSIDE_UNIT: aws_sqs_queue.extra/);

  const missing = check(tagged.filter((r) => r.address !== "aws_iam_role_policy_attachment.audit"));
  assert.match(missing.reasons.join("\n"), /PLANNED_CREATE_ABSENT: aws_iam_role_policy_attachment.audit/);

  const touchesCustomer = check([...tagged, { address: "aws_s3_bucket.customer",
    type: "aws_s3_bucket", actions: ["update"], after: { tags: {} } }]);
  assert.match(touchesCustomer.reasons.join("\n"), /NON_ADDITIVE_CHANGE: aws_s3_bucket.customer UPDATE/);

  const computed = check([tagged[0], { ...tagged[1] }].map((resource, index) => index === 0
    ? { ...resource, after: { tags_all: null }, afterUnknown: { tags_all: true } } : resource));
  assert.match(computed.reasons.join("\n"), /TAGS_UNKNOWN_AT_PLAN: aws_cloudwatch_log_group.alz_audit/);
});

test("a local state file is refused: losing it orphans everything it tracks", () => {
  const local: DeletionUnitStateRef = { engine: "TERRAFORM", backend: "local",
    location: "./terraform.tfstate", workspace: "default" };
  const unit = unitFor(planJson(createPlanResources({})), local);
  const json = planJson(createPlanResources(tagsFor(unit)));
  const report = checkCreateTraceability(unit, normalizeTerraformPlan(json), readTerraformPlanTags(json));
  assert.equal(report.verdict, "BLOCKED");
  assert.match(report.reasons.join("\n"), /STATE_NOT_DURABLE/);
});

test("destroy preview: ready only when it deletes exactly what the unit created", () => {
  const { unit } = taggedBuild();
  const destroy = (resources: PlannedResource[]) =>
    evaluateDestroyPreview(unit, normalizeTerraformPlan(planJson(resources)));
  const deleteOf = (address: string): PlannedResource =>
    ({ address, type: address.split(".")[0], actions: ["delete"], after: null });

  const ready = destroy([deleteOf("aws_cloudwatch_log_group.alz_audit"),
    deleteOf("aws_iam_role_policy_attachment.audit"),
    { address: "data.aws_caller_identity.current", type: "aws_caller_identity", actions: ["read"] }]);
  assert.equal(ready.verdict, "READY_FOR_AUTHORIZATION", ready.reasons.join("; "));
  assert.deepEqual(ready.deletes, unit.plannedCreates);
  assert.deepEqual(ready.alreadyAbsent, []);
  assert.equal(ready.executionMode, "PREVIEW_ONLY");
  assert.equal(ready.infrastructureAct, "DISABLED");
  assert.equal(ready.unitHash, unit.unitHash);

  const partial = destroy([deleteOf("aws_cloudwatch_log_group.alz_audit")]);
  assert.equal(partial.verdict, "READY_FOR_AUTHORIZATION");
  assert.deepEqual(partial.alreadyAbsent, ["aws_iam_role_policy_attachment.audit"]);

  // A customer resource imported into the unit's state blocks the whole teardown.
  const imported = destroy([deleteOf("aws_cloudwatch_log_group.alz_audit"),
    deleteOf("aws_s3_bucket.customer_data")]);
  assert.equal(imported.verdict, "BLOCKED");
  assert.match(imported.reasons.join("\n"), /DELETE_OUTSIDE_UNIT: aws_s3_bucket.customer_data/);

  const mixed = destroy([deleteOf("aws_cloudwatch_log_group.alz_audit"),
    { address: "aws_iam_role_policy_attachment.audit", type: "x", actions: ["delete", "create"] }]);
  assert.match(mixed.reasons.join("\n"),
    /NON_DELETE_IN_DESTROY_PLAN: aws_iam_role_policy_attachment.audit REPLACE/);

  assert.equal(destroy([]).verdict, "NOTHING_TO_DESTROY");

  const wrongEngine = evaluateDestroyPreview(unit,
    normalizeOpenTofuPlan(planJson([deleteOf("aws_cloudwatch_log_group.alz_audit")])));
  assert.match(wrongEngine.reasons.join("\n"), /ENGINE_MISMATCH/);

  assert.throws(() => evaluateDestroyPreview(
    { ...unit, plannedCreates: [...unit.plannedCreates, "aws_s3_bucket.customer_data"].sort() },
    normalizeTerraformPlan(planJson([deleteOf("aws_s3_bucket.customer_data")]))),
  /UNIT_HASH_MISMATCH/);
});

test("orphan report: report only, tags are pointers never authority", () => {
  const { unit } = taggedBuild();
  const resource = (resourceId: string, tags?: Record<string, string>): DiscoveredResource => ({
    resourceId, provider: "AWS", resourceType: "aws:logs:log-group", name: resourceId,
    ownership: "MANAGED_BY_CUSTOMER", mutationPolicy: "READ_ONLY", sourceOfTruth: "UNKNOWN", tags,
  });
  const report = reportOrphans([
    resource("tracked", { ...unit.tags }),
    resource("unattributed", { "alz-managed-by": "alz" }),
    resource("lost-state", { ...unit.tags, "alz-unit": "alzu-00000000000000000000" }),
    resource("forged", { ...unit.tags, "alz-build": "build-forged" }),
    resource("expired", { ...unit.tags, "alz-expires": "2026-01-01" }),
    resource("customer", { team: "payments" }),
    resource("untagged"),
  ], [unit], "2026-10-10");
  const status = Object.fromEntries(report.findings.map((f) => [f.resourceId, f.status]));
  assert.deepEqual(status, {
    tracked: "TRACKED", unattributed: "ORPHAN_UNATTRIBUTED", "lost-state": "ORPHAN_UNKNOWN_UNIT",
    forged: "TAG_CONFLICT", expired: "TRACKED",
  });
  assert.equal(report.action, "REPORT_ONLY");
  assert.equal(report.orphans, 3);
  assert.equal(report.expired, 1);
  // Nothing in the report changes what discovery says may be mutated.
  assert.equal(JSON.stringify(report).includes("DELETE_ALLOWED"), false);
});

test("./alz teardown CLI: record, check, preview and orphans over files, read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "alz-teardown-"));
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", resolve("src/cli/teardown.ts"), ...args],
    { encoding: "utf8", cwd: process.cwd() });
  try {
    const file = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const statePath = file("state.json", JSON.stringify(S3_STATE));
    const recorded = cli("record", "--build-id", BUILD_ID, "--provider", "AWS",
      "--state", statePath, "--design-hash", DESIGN_HASH,
      "--plan", file("untagged.json", planJson(createPlanResources({}))));
    assert.equal(recorded.status, 0, recorded.stderr);
    const unit = JSON.parse(recorded.stdout) as DeletionUnit;
    verifyDeletionUnit(unit);
    const unitPath = file("unit.json", recorded.stdout);

    const tagged = file("tagged.json", planJson(createPlanResources(tagsFor(unit))));
    const ok = cli("check-plan", "--unit", unitPath, "--plan", tagged);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(JSON.parse(ok.stdout).verdict, "TRACEABLE");

    const blocked = cli("check-plan", "--unit", unitPath,
      "--plan", file("bad.json", planJson(createPlanResources({}))));
    assert.equal(blocked.status, 2);
    assert.equal(JSON.parse(blocked.stdout).verdict, "BLOCKED");

    const preview = cli("destroy-preview", "--unit", unitPath, "--plan", file("destroy.json",
      planJson(unit.plannedCreates.map((address) =>
        ({ address, type: "x", actions: ["delete"], after: null })))));
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).verdict, "READY_FOR_AUTHORIZATION");

    const orphans = cli("orphans", "--units", unitPath, "--resources", file("resources.json",
      JSON.stringify([{ resourceId: "stray", provider: "AWS", resourceType: "x", name: "stray",
        ownership: "UNKNOWN", mutationPolicy: "READ_ONLY", sourceOfTruth: "UNKNOWN",
        tags: { "alz-managed-by": "alz" } }])));
    assert.equal(orphans.status, 2);
    assert.equal(JSON.parse(orphans.stdout).orphans, 1);

    const bad = cli("record", "--build-id");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /TEARDOWN_ARGUMENT_INVALID/);
    assert.equal(cli("--help").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
