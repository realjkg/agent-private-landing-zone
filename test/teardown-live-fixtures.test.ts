import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { normalizeBicepWhatIf } from "../src/iac/bicep-whatif.js";
import { normalizeCloudFormationChangeSet } from "../src/iac/cloudformation-changeset.js";
import { normalizePulumiPreview } from "../src/iac/pulumi-preview.js";
import { normalizeTerraformPlan } from "../src/iac/terraform-plan.js";
import { renderAwsTerraformCandidate, reviewAwsTerraformProposals } from "../src/qualification/aws-terraform-agent.js";
import { checkCreateTraceability, evaluateDestroyPreview, readTerraformPlanTags } from "../src/teardown/gates.js";
import {
  parseAwsTaggedResources,
  parseAzureTaggedResources,
  readBicepWhatIfTags,
  readCloudFormationChangeSetTags,
  readPulumiPreviewTags,
} from "../src/teardown/readers.js";
import type { DeletionUnitStateRef } from "../src/teardown/types.js";
import { deletionUnitId, provenanceTags, recordDeletionUnit } from "../src/teardown/unit.js";

// REAL tool output (test/fixtures/live/MANIFEST.json says exactly how each file
// was produced). These tests exist because fixtures written from documentation
// can encode the author's assumptions; real captures cannot. Engines without a
// capture yet are listed under "stillNeeded" in the manifest, and any file
// dropped into the matching directory is automatically smoke-tested below.

const ROOT = resolve("test/fixtures/live");
const TF = (name: string) => readFileSync(join(ROOT, "terraform", name), "utf8");

const DESIGN_HASH = "d".repeat(64);
// The inputs the tagged capture was rendered with (see MANIFEST.json).
const BUILD_ID = "build-00000000-0000-4000-8000-000000000001";
const STATE: DeletionUnitStateRef = {
  engine: "TERRAFORM", backend: "s3",
  location: "s3://example-alz-state/builds/example/terraform.tfstate", workspace: "default",
};
const LOG_GROUP = "aws_cloudwatch_log_group.alz_audit";

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const fixtures = () => walk(ROOT)
  .map((path) => relative(ROOT, path).split("\\").join("/"))
  .filter((path) => path !== "MANIFEST.json" && path !== "README.md");

test("every live capture is listed in the manifest with its tool, version and command", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "MANIFEST.json"), "utf8")) as {
    captures: Array<{ file: string; engine: string; tool: string; command: string; capturedAt: string; mode: string }>;
  };
  const listed = manifest.captures.map((capture) => capture.file).sort();
  assert.deepEqual(fixtures().sort(), listed, "unlisted or missing fixture files");
  for (const capture of manifest.captures) {
    for (const field of ["engine", "tool", "command", "capturedAt", "mode"] as const) {
      assert.ok(capture[field], capture.file + " is missing " + field);
    }
    assert.ok(existsSync(join(ROOT, capture.file)), capture.file);
  }
});

// Captures come from real accounts, so this is a guard against committing
// something sensitive. Documentation placeholders are the only identifiers
// allowed; anything else must be sanitized (README.md).
const FORBIDDEN: Array<[string, RegExp]> = [
  ["AWS access key id", /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["email address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["secret-looking value", /"(?:password|secret|client_secret|access_key|secret_key|private_key|token|api_key)"\s*:\s*"[^"]+"/i],
];
const ALLOWED_ACCOUNTS = new Set(["123456789012", "000000000000"]);
const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

test("live captures contain no real account identifiers or secrets", () => {
  for (const file of fixtures()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const [label, pattern] of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, file + ": " + label);
    }
    for (const match of text.matchAll(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/g)) {
      assert.ok(ALLOWED_ACCOUNTS.has(match[1]), file + ": real-looking AWS account id " + match[1]);
    }
    for (const match of text.matchAll(/\/subscriptions\/([0-9a-f-]{36})/gi)) {
      assert.equal(match[1].toLowerCase(), ZERO_GUID, file + ": real-looking Azure subscription id");
    }
  }
});

test("terraform (real): the renderer's output is exactly what real `terraform fmt -check` accepted", () => {
  const proposal = JSON.stringify({ action: "ADD", resourceType: "aws_cloudwatch_log_group",
    name: "/alz/preview/brownfield-audit", retentionDays: 30, ownership: "NEW_RESOURCE_ONLY",
    evidenceRefs: ["aws.identity"] });
  const reviewed = reviewAwsTerraformProposals(proposal, proposal, ["aws.identity"]);
  const tags = provenanceTags({ unitId: deletionUnitId(BUILD_ID, STATE), buildId: BUILD_ID, expires: "2026-12-31" });
  assert.equal(renderAwsTerraformCandidate(reviewed), TF("aws-log-group.default.main.tf"));
  assert.equal(renderAwsTerraformCandidate(reviewed, tags), TF("aws-log-group.tagged.main.tf"));
});

test("terraform (real): the tags the renderer stamps are the tags real Terraform plans, end to end", () => {
  const defaultPlan = TF("aws-log-group.default.create.plan.json");
  const taggedPlan = TF("aws-log-group.tagged.create.plan.json");
  const defaultTagsPlan = TF("aws-log-group.tagged-default-tags.create.plan.json");

  // The unit is recorded from the plain create plan, as a build would.
  const create = normalizeTerraformPlan(defaultPlan);
  assert.deepEqual(create.resources, [{ address: LOG_GROUP, type: "aws_cloudwatch_log_group", operation: "CREATE" }]);
  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: STATE,
    designHash: DESIGN_HASH, createPlan: create, expires: "2026-12-31" });

  // Real Terraform reports tags_all (known at plan time) and lists neither tag attribute as unknown.
  assert.deepEqual(readTerraformPlanTags(defaultPlan).get(LOG_GROUP),
    { kind: "TAGGED", tags: { ManagedBy: "ALZ-preview-candidate" } });
  const blocked = checkCreateTraceability(unit, create, readTerraformPlanTags(defaultPlan));
  assert.equal(blocked.verdict, "BLOCKED");
  assert.match(blocked.reasons.join("\n"), /UNTAGGED_CREATE: aws_cloudwatch_log_group.alz_audit/);

  const traceable = checkCreateTraceability(unit, normalizeTerraformPlan(taggedPlan), readTerraformPlanTags(taggedPlan));
  assert.equal(traceable.verdict, "TRACEABLE", traceable.reasons.join("; "));
  assert.deepEqual(traceable.tagged, [LOG_GROUP]);

  // Provider default_tags merge into tags_all; extra tags never hide the unit's.
  const merged = readTerraformPlanTags(defaultTagsPlan).get(LOG_GROUP);
  assert.ok(merged?.kind === "TAGGED" && merged.tags.Org === "example-org");
  const withDefaults = checkCreateTraceability(unit, normalizeTerraformPlan(defaultTagsPlan),
    readTerraformPlanTags(defaultTagsPlan));
  assert.equal(withDefaults.verdict, "TRACEABLE", withDefaults.reasons.join("; "));
});

test("terraform (real): create, update, replace, no-op and destroy map as the gates assume", () => {
  const mixed = normalizeTerraformPlan(TF("lifecycle.mixed.plan.json"));
  const operations = Object.fromEntries(mixed.resources.map((r) => [r.address, r.operation]));
  assert.deepEqual(operations, {
    "terraform_data.audit": "UPDATE",
    "terraform_data.bucket": "REPLACE", // real order is ["delete","create"]
    "terraform_data.extra": "CREATE",
    "terraform_data.queue": "SAME",
  });
  assert.equal(mixed.destructive, true);
  // Only a pure create is read for tags; types with no tags attribute are untaggable, not guessed.
  assert.deepEqual([...readTerraformPlanTags(TF("lifecycle.mixed.plan.json"))],
    [["terraform_data.extra", { kind: "UNTAGGABLE" }]]);
  // A unit can only ever be recorded from an additive plan, including a real one.
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: STATE,
    designHash: DESIGN_HASH, createPlan: mixed }), /NON_ADDITIVE_PLAN/);

  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: STATE,
    designHash: DESIGN_HASH, createPlan: normalizeTerraformPlan(TF("lifecycle.create.plan.json")) });
  assert.deepEqual(unit.plannedCreates, ["terraform_data.audit", "terraform_data.bucket", "terraform_data.queue"]);

  const destroy = evaluateDestroyPreview(unit, normalizeTerraformPlan(TF("lifecycle.destroy.plan.json")));
  assert.equal(destroy.verdict, "READY_FOR_AUTHORIZATION", destroy.reasons.join("; "));
  assert.deepEqual(destroy.deletes, unit.plannedCreates);
  // A real update/replace/create plan is never mistaken for a destroy plan.
  const notDestroy = evaluateDestroyPreview(unit, mixed);
  assert.equal(notDestroy.verdict, "BLOCKED");
  assert.match(notDestroy.reasons.join("\n"), /NON_DELETE_IN_DESTROY_PLAN/);
});

// Captures dropped into these directories (README.md) are smoke-tested
// automatically, so a reader that cannot parse real output fails here.
const SMOKE: Array<[RegExp, string, (json: string) => unknown]> = [
  [/^pulumi\/.+\.preview\.json$/, "pulumi preview", (json) => {
    assert.ok(normalizePulumiPreview(json).resources.length > 0);
    readPulumiPreviewTags(json);
  }],
  [/^aws\/.+\.change-set\.json$/, "cloudformation change set", (json) => {
    assert.ok(normalizeCloudFormationChangeSet(json).resources.length > 0);
    readCloudFormationChangeSetTags(json);
  }],
  [/^aws\/.+\.tagging-get-resources\.json$/, "aws tagged inventory", (json) => {
    assert.ok(parseAwsTaggedResources(json).resources.length > 0);
  }],
  [/^azure\/.+\.what-if\.json$/, "bicep what-if", (json) => {
    assert.ok(normalizeBicepWhatIf(json).resources.length > 0);
    readBicepWhatIfTags(json);
  }],
  [/^azure\/.+\.resource-list\.json$/, "azure resource list", (json) => {
    assert.ok(parseAzureTaggedResources(json).resources.length > 0);
  }],
];

test("any captured pulumi, cloudformation, aws or azure output parses with the real readers", () => {
  for (const file of fixtures()) {
    for (const [pattern, label, parse] of SMOKE) {
      if (pattern.test(file)) {
        assert.doesNotThrow(() => parse(readFileSync(join(ROOT, file), "utf8")), label + ": " + file);
      }
    }
  }
});
