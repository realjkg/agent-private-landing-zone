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

// --- Terraform audit: nested modules, for_each, null/empty tags, inheritance, deferred reads ---

test("terraform (real): modules, for_each, null tags, inherited default_tags and a deferred read", () => {
  const json = TF("audit-modules-foreach.plan.json");
  const plan = normalizeTerraformPlan(json);
  const operations = Object.fromEntries(plan.resources.map((r) => [r.address, r.operation]));
  assert.deepEqual(operations, {
    // A data read deferred to apply is a READ, never a create.
    "data.aws_cloudwatch_log_group.deferred": "READ",
    'aws_cloudwatch_log_group.each["a"]': "CREATE",
    'aws_cloudwatch_log_group.each["b"]': "CREATE",
    "aws_cloudwatch_log_group.null_tags": "CREATE",
    "module.tagged.aws_cloudwatch_log_group.this": "CREATE",
    "module.untagged.aws_cloudwatch_log_group.this": "CREATE",
  });
  const tags = readTerraformPlanTags(json);
  assert.equal(tags.has("data.aws_cloudwatch_log_group.deferred"), false);
  const tagsOf = (address: string) => {
    const planned = tags.get(address);
    assert.ok(planned?.kind === "TAGGED", address);
    return planned.tags;
  };
  const unitTags = { "alz-managed-by": "alz", "alz-unit": "alzu-example" };
  // Tags passed through a module merge with the provider's default_tags in tags_all.
  assert.deepEqual(tagsOf("module.tagged.aws_cloudwatch_log_group.this"), { Org: "example-org", ...unitTags });
  assert.deepEqual(tagsOf('aws_cloudwatch_log_group.each["a"]'), { Org: "example-org", ...unitTags });
  assert.deepEqual(tagsOf('aws_cloudwatch_log_group.each["b"]'), { Org: "example-org", ...unitTags });
  // No tags given (module default {} or an explicit null): only the provider default reaches the resource.
  assert.deepEqual(tagsOf("module.untagged.aws_cloudwatch_log_group.this"), { Org: "example-org" });
  assert.deepEqual(tagsOf("aws_cloudwatch_log_group.null_tags"), { Org: "example-org" });

  // So an untagged module cannot pass the gate by inheriting someone else's default tags.
  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: STATE,
    designHash: DESIGN_HASH, createPlan: plan });
  assert.ok(!unit.plannedCreates.includes("data.aws_cloudwatch_log_group.deferred"));
  assert.equal(unit.plannedCreates.length, 5);
  const report = checkCreateTraceability(unit, plan, tags);
  assert.equal(report.verdict, "BLOCKED");
  const untagged = report.reasons.filter((reason) => reason.startsWith("UNTAGGED_CREATE"));
  assert.equal(untagged.length, 5, "none of the five carry THIS unit's tags");
  assert.match(untagged.find((reason) => reason.includes("module.untagged"))!,
    /missing or wrong alz-managed-by, alz-unit, alz-build/);
  // Where the module did pass alz-managed-by, only the unit-specific keys are reported missing.
  assert.match(untagged.find((reason) => reason.includes("module.tagged"))!, /missing or wrong alz-unit, alz-build$/);
});

test("terraform (real): create_before_destroy replaces are ['create','delete'] and still never additive", () => {
  const json = TF("lifecycle.create-before-destroy.plan.json");
  const plan = normalizeTerraformPlan(json);
  assert.equal(plan.resources.find((r) => r.address === "terraform_data.bucket")?.operation, "REPLACE");
  assert.equal(plan.destructive, true);
  assert.equal(readTerraformPlanTags(json).has("terraform_data.bucket"), false);
  assert.throws(() => recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: STATE,
    designHash: DESIGN_HASH, createPlan: plan }), /NON_ADDITIVE_PLAN/);
});

// --- AWS CDK: real `cdk synth` output ---

type CfnTemplate = {
  Conditions?: Record<string, unknown>;
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown>; Condition?: string }>;
};
const CDK = (name: string) => JSON.parse(readFileSync(join(ROOT, "aws", "cdk", name), "utf8")) as CfnTemplate;
const CDK_STATE: DeletionUnitStateRef = { engine: "AWS_CDK", region: "eu-west-1", stackName: "AlzTagged" };

/**
 * A change set built from a REAL synthesized template: every resource an Add,
 * with its real Properties as AfterContext. The Properties (and so the Tags
 * shapes) are real tool output; the AfterContext wrapper around them is
 * still an assumption until a real describe-change-set is captured (see
 * "stillNeeded" in MANIFEST.json). It is built here, never committed as a fixture.
 */
function changeSetFromTemplate(template: CfnTemplate): string {
  return JSON.stringify({ Changes: Object.entries(template.Resources).map(([id, resource]) => ({
    Type: "Resource",
    ResourceChange: {
      Action: "Add", LogicalResourceId: id, ResourceType: resource.Type,
      AfterContext: JSON.stringify({ Properties: resource.Properties ?? {} }),
    },
  })) });
}

test("cdk (real synth): what CDK actually emits for tags, metadata and untaggable types", () => {
  const tagged = CDK("AlzTagged.template.json");
  const types = Object.fromEntries(Object.entries(tagged.Resources).map(([id, r]) => [id, r.Type]));
  assert.deepEqual(Object.values(types).sort(), [
    "AWS::CDK::Metadata", "AWS::IAM::Policy", "AWS::IAM::Role", "AWS::Logs::LogGroup",
    "AWS::S3::Bucket", "AWS::SQS::Queue", "AWS::SSM::Parameter",
  ]);
  // The CLI adds CDKMetadata to every stack: region-conditional, only an Analytics property, no tags.
  assert.equal(tagged.Resources.CDKMetadata.Condition, "CDKMetadataAvailable");
  assert.deepEqual(Object.keys(tagged.Resources.CDKMetadata.Properties ?? {}), ["Analytics"]);
  assert.ok(tagged.Conditions && "CDKMetadataAvailable" in tagged.Conditions);
  // Most types store Tags as a sorted [{Key,Value}] list; SSM Parameter stores a map; Policy has none.
  const tagsOf = (id: string) => tagged.Resources[id].Properties?.Tags;
  assert.ok(Array.isArray(tagsOf("Audit3D8ADE0A")));
  assert.deepEqual((tagsOf("Audit3D8ADE0A") as Array<{ Key: string }>).map((t) => t.Key),
    ["alz-build", "alz-managed-by", "alz-unit"]);
  assert.ok(tagsOf("Marker55B6240B") && !Array.isArray(tagsOf("Marker55B6240B")));
  assert.equal(tagsOf("WriterDefaultPolicyDC585BCE"), undefined, "a tagged stack does not tag IAM::Policy");
  // Stack-level tags are recorded separately in the assembly manifest, not per resource.
  const manifest = JSON.parse(readFileSync(join(ROOT, "aws", "cdk", "AlzTagged.cdk-manifest.json"), "utf8")) as {
    artifacts: Record<string, { properties?: { tags?: Record<string, string> } }>;
  };
  assert.deepEqual(Object.keys(manifest.artifacts.AlzTagged.properties?.tags ?? {}).sort(),
    ["alz-build", "alz-managed-by", "alz-unit"]);
  // The untagged stack has no Tags on any resource.
  assert.ok(Object.values(CDK("AlzUntagged.template.json").Resources).every((r) => r.Properties?.Tags === undefined));
});

test("cdk (real synth): the CloudFormation reader and gates handle every real tag shape and the metadata node", () => {
  const taggedJson = changeSetFromTemplate(CDK("AlzTagged.template.json"));
  const untaggedJson = changeSetFromTemplate(CDK("AlzUntagged.template.json"));

  const tags = readCloudFormationChangeSetTags(taggedJson);
  // Built in: the CDK metadata node and IAM::Policy have no tags, so they are not read as "untagged".
  assert.deepEqual(tags.get("CDKMetadata"), { kind: "UNTAGGABLE" });
  assert.deepEqual(tags.get("WriterDefaultPolicyDC585BCE"), { kind: "UNTAGGABLE" });
  // List and map shapes both come out as the same tags.
  const log = tags.get("Audit3D8ADE0A");
  const map = tags.get("Marker55B6240B");
  assert.ok(log?.kind === "TAGGED" && map?.kind === "TAGGED");
  assert.deepEqual(log.tags, map.tags);

  // A CDK unit is checked against a CloudFormation change set (CDK deploys through CloudFormation).
  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: CDK_STATE, designHash: DESIGN_HASH,
    createPlan: normalizeCloudFormationChangeSet(untaggedJson) });
  assert.equal(unit.engine, "AWS_CDK");
  assert.deepEqual(unit.tags, log.tags, "the unit's derived tags are exactly what CDK stamped");
  assert.equal(unit.plannedCreates.length, 7);

  const ok = checkCreateTraceability(unit, normalizeCloudFormationChangeSet(taggedJson), tags);
  assert.equal(ok.verdict, "TRACEABLE", ok.reasons.join("; "));
  assert.deepEqual(ok.stateOnly, ["CDKMetadata", "WriterDefaultPolicyDC585BCE"]);
  assert.equal(ok.tagged.length, 5);

  // Untagged stack: every taggable resource blocks, the metadata node and Policy do not.
  const bad = checkCreateTraceability(unit, normalizeCloudFormationChangeSet(untaggedJson),
    readCloudFormationChangeSetTags(untaggedJson));
  assert.equal(bad.verdict, "BLOCKED");
  const blocked = bad.reasons.filter((reason) => reason.startsWith("UNTAGGED_CREATE")).map((r) => r.split(" ")[1]);
  assert.deepEqual(blocked.sort(), ["Audit3D8ADE0A", "Evidence4CC26D68", "EventsD32975C2", "Marker55B6240B", "Writer3ED51D24"].sort());
});

test("cdk (real synth): a template with a conditional metadata node that is absent still passes", () => {
  // CDKMetadata is conditional on the region; if the change set omits it the unit's record has an extra create.
  const unit = recordDeletionUnit({ buildId: BUILD_ID, provider: "AWS", stateRef: CDK_STATE, designHash: DESIGN_HASH,
    createPlan: normalizeCloudFormationChangeSet(changeSetFromTemplate(CDK("AlzUntagged.template.json"))) });
  const tagged = CDK("AlzTagged.template.json");
  delete tagged.Resources.CDKMetadata;
  const json = changeSetFromTemplate(tagged);
  const report = checkCreateTraceability(unit, normalizeCloudFormationChangeSet(json), readCloudFormationChangeSetTags(json));
  assert.equal(report.verdict, "BLOCKED");
  assert.deepEqual(report.reasons, ["PLANNED_CREATE_ABSENT: CDKMetadata"],
    "fails closed and says exactly which node is missing, so it can be reviewed");
});

// Templates dropped under aws/cdk are parsed by the readers automatically.
test("any captured cdk template parses with the CloudFormation reader", () => {
  for (const file of fixtures().filter((path) => /^aws\/cdk\/.+\.template\.json$/.test(path))) {
    const json = changeSetFromTemplate(JSON.parse(readFileSync(join(ROOT, file), "utf8")) as CfnTemplate);
    assert.doesNotThrow(() => readCloudFormationChangeSetTags(json), file);
    assert.ok(normalizeCloudFormationChangeSet(json).resources.length > 0, file);
  }
});
