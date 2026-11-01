import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertCanary, assertLimits, assertProvisioning, canaryRefusal, familyOf, RESOURCE_NOT_IN_LIMITS, TERRAFORM_SIZE_ATTRIBUTES, type CanaryEntry } from "../src/apply/canary.js";
import { checkDraftContract, contractCheckLines } from "../src/apply/contract-check.js";
import { authorizeContract, inspectPilotContract, pilotTargetSha256, repoPaths } from "../src/apply/contract.js";
import { codeOf, reasonOf } from "../src/apply/engine.js";
import { CROSS_REGION_ATTRIBUTES, isGlobalAwsType } from "../src/apply/engines/terraform.js";
import type { PilotContract, PilotLimits, PilotTarget } from "../src/apply/types.js";
import { CODE_COPY } from "../src/operator-ui/app/pilot/pilot-copy.js";
import { AWS_REGION, awsContractJson } from "./helpers/apply-fixtures.js";

/**
 * Provisioning limits (owner direction 6536926009, plan item 3): the canary allowlist's general form. SYNTHETIC: every case here is a
 * fixture judged in process; nothing reaches a cloud, and none of it is provider qualification.
 */

const KILL = "/tmp/never-used-kill-switch";
const CONFIG = join(repoPaths().root, "config");
const pem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

/** The AWS Terraform fixture contract with DEV's canary replaced by `limits` (undefined keeps the canary). */
const awsWithLimits = (limits: unknown, devExtra: Record<string, unknown> = {}): Record<string, unknown> => {
  const c = awsContractJson(KILL) as { targets: Record<string, Record<string, unknown>> };
  const dev = { ...c.targets.DEV, ...devExtra };
  if (limits !== undefined) { delete dev.canary; dev.limits = limits; }
  return { ...c, targets: { ...c.targets, DEV: dev } };
};
const reasonOfShape = (raw: unknown): string => { const shape = inspectPilotContract(raw); assert.equal(shape.ok, false, "expected a refusal"); return (shape as { reason: string }).reason; };
const loaded = (raw: unknown): PilotContract => { const shape = inspectPilotContract(raw); assert.ok(shape.ok, shape.ok ? "" : shape.reason); return (shape as { contract: PilotContract }).contract; };

const create = (address: string, more: Partial<CanaryEntry> = {}): CanaryEntry => ({ address, type: address.split(".")[0]!, action: "[\"create\"]", creates: true, ...more });
const limitsStop = (limits: PilotLimits, entries: CanaryEntry[], said: RegExp, label: string) => {
  assert.throws(() => assertLimits(limits, entries, "plan"), (error: unknown) => codeOf(error) === RESOURCE_NOT_IN_LIMITS && said.test(reasonOf(error) ?? ""), label);
};

// --- the judge ----------------------------------------------------------------------------------------------------

const BASELINE: PilotLimits = {
  regions: ["us-east-2", "us-east-1"],
  resources: [
    { type: "aws_budgets_budget", max: 2 },
    { type: "aws_sns_topic", max: 1 },
    { type: "aws_instance", max: 2, sizes: ["m7g.large"], families: ["t3", "t4g"] },
  ],
};

test("limits allow: each listed type up to its maximum (fewer and none are within it), in an allowed region, a global type with no region, and an allowed size or family", () => {
  assertLimits(BASELINE, [
    create("aws_budgets_budget.monthly"), create("aws_budgets_budget.forecast"),
    create("aws_sns_topic.alerts", { region: "us-east-2" }),
    create("aws_instance.a", { region: "US-EAST-1", sizes: ["t3.micro"] }), create("aws_instance.b", { region: "us-east-2", sizes: ["m7g.large"] }),
  ], "plan");
  assertLimits(BASELINE, [create("aws_budgets_budget.monthly")], "plan");
  assertLimits(BASELINE, [], "plan");
  // No `regions`: any region the target and its provider allow; a type with no sizes named is not judged by size.
  assertLimits({ resources: [{ type: "aws_instance", max: 1 }] }, [create("aws_instance.a", { region: "eu-west-1", sizes: null })], "plan");
});

test("limits refuse: a type not listed, a count over its maximum, a region not allowed or not shown, a size or family not allowed or not shown, and anything but a create", () => {
  limitsStop(BASELINE, [create("aws_iam_role.app")], /aws_iam_role\.app: type aws_iam_role is not in the provisioning limits/, "type not allowed");
  limitsStop(BASELINE, [create("aws_budgets_budget.a"), create("aws_budgets_budget.b"), create("aws_budgets_budget.c")], /aws_budgets_budget: the plan creates 3, the provisioning limits allow at most 2/, "count over max");
  limitsStop(BASELINE, [create("aws_sns_topic.alerts", { region: "eu-west-1" })], /aws_sns_topic\.alerts \(aws_sns_topic\): region eu-west-1 is not in the allowed regions \(us-east-2, us-east-1\)/, "region not allowed");
  limitsStop(BASELINE, [create("aws_sns_topic.alerts", { region: null })], /does not show its region/, "region unknown until apply");
  limitsStop(BASELINE, [create("aws_instance.big", { region: "us-east-2", sizes: ["m7g.4xlarge"] })], /aws_instance\.big \(aws_instance\): size m7g\.4xlarge is not one of the allowed sizes or families/, "size not allowed");
  limitsStop(BASELINE, [create("aws_instance.big", { region: "us-east-2", sizes: ["c7i.large"] })], /size c7i\.large is not one of the allowed sizes or families/, "family not allowed");
  limitsStop(BASELINE, [create("aws_instance.unsized", { region: "us-east-2", sizes: null })], /does not show its size/, "size unknown until apply");
  limitsStop(BASELINE, [create("aws_instance.unsized", { region: "us-east-2" })], /does not show its size/, "size not read");
  limitsStop(BASELINE, [create("aws_instance.list", { region: "us-east-2", sizes: ["t3.micro", "x2idn.32xlarge"] })], /size x2idn\.32xlarge/, "every value of a list attribute is judged");
  limitsStop(BASELINE, [{ ...create("aws_sns_topic.alerts", { region: "us-east-2" }), action: "[\"update\"]", creates: false }], /would \["update"\] it; the limits allow create only/, "update");
  limitsStop(BASELINE, [{ ...create("aws_sns_topic.alerts"), action: "[\"delete\",\"create\"]", creates: false }], /allow create only/, "replace");
  // A value that is not a plain short name is described, never echoed.
  limitsStop(BASELINE, [create("aws_sns_topic.alerts", { region: "secret value with spaces" })], /region \(a value that is not a plain name\) is not in the allowed regions/, "unusual region");
});

test("a size's family is everything before its last dot; a size with no dot has no family and is allowed only by name", () => {
  assert.equal(familyOf("t3.micro"), "t3");
  assert.equal(familyOf("db.r6g.large"), "db.r6g");
  assert.equal(familyOf("Standard_B2s"), undefined);
  assert.equal(familyOf("e2-medium"), undefined);
  assert.equal(familyOf(".hidden"), undefined);
  limitsStop({ resources: [{ type: "azurerm_linux_virtual_machine", max: 1, families: ["Standard"] }] }, [create("azurerm_linux_virtual_machine.vm", { sizes: ["Standard_B2s"] })], /size Standard_B2s/, "no family");
  assertLimits({ resources: [{ type: "azurerm_linux_virtual_machine", max: 1, sizes: ["Standard_B2s"] }] }, [create("azurerm_linux_virtual_machine.vm", { sizes: ["Standard_B2s"] })], "plan");
});

test("assertProvisioning: a target with limits is judged by them; a canary target is judged exactly as before; a target with neither is CANARY_ALLOWLIST_MISSING", () => {
  const target = (more: Partial<PilotTarget>): PilotTarget => ({ accountId: "111111111111", region: "us-east-2", backend: "b/k", workspace: "default", ...more } as PilotTarget);
  const canary = { resources: [{ type: "aws_cloudwatch_log_group", count: 1 }] };
  // The legacy canary is exact: one is allowed, none or two are refused, unlike a maximum.
  assertProvisioning(target({ canary }), [create("aws_cloudwatch_log_group.a")], "plan");
  for (const entries of [[], [create("aws_cloudwatch_log_group.a"), create("aws_cloudwatch_log_group.b")]]) {
    assert.throws(() => assertProvisioning(target({ canary }), entries, "plan"), (e: unknown) => codeOf(e) === "RESOURCE_NOT_IN_CANARY");
    assert.throws(() => assertCanary(canary, entries, "plan"), (e: unknown) => codeOf(e) === "RESOURCE_NOT_IN_CANARY");
  }
  // The canary judge ignores region and size, as it always has.
  assertProvisioning(target({ canary }), [create("aws_cloudwatch_log_group.a", { region: "eu-west-1", sizes: null })], "plan");
  const limits = { resources: [{ type: "aws_cloudwatch_log_group", max: 2 }] };
  assertProvisioning(target({ limits }), [], "plan");
  assertProvisioning(target({ limits }), [create("aws_cloudwatch_log_group.a"), create("aws_cloudwatch_log_group.b")], "plan");
  assert.throws(() => assertProvisioning(target({ limits }), [create("aws_iam_role.x")], "plan"), (e: unknown) => codeOf(e) === RESOURCE_NOT_IN_LIMITS);
  assert.throws(() => assertProvisioning(target({}), [create("aws_cloudwatch_log_group.a")], "plan"), (e: unknown) => codeOf(e) === "CANARY_ALLOWLIST_MISSING");
});

test("the limits refusal names what to do, and the console has plain words for it", () => {
  let error: unknown;
  try { assertLimits(BASELINE, [create("aws_iam_role.app")], "plan"); } catch (caught) { error = caught; }
  const refusal = canaryRefusal(error, "Nothing was sealed.");
  assert.equal(refusal?.code, "RESOURCE_NOT_IN_LIMITS");
  assert.match(refusal!.message, /provisioning limits do not allow: aws_iam_role\.app: type aws_iam_role is not in the provisioning limits\. Nothing was sealed\..*reviewed commit/);
  assert.ok(CODE_COPY.RESOURCE_NOT_IN_LIMITS!.why.length > 0 && CODE_COPY.RESOURCE_NOT_IN_LIMITS!.next.length > 0);
  assert.equal(canaryRefusal(new Error("other"), "x"), undefined);
});

// --- the contract -------------------------------------------------------------------------------------------------

test("the contract reads limits: types once each with a maximum, regions in the provider's form including the target's own, sizes and families only where the engine reads them", () => {
  const limits = { regions: [AWS_REGION, "us-west-2"], resources: [{ type: "aws_budgets_budget", max: 1 }, { type: "aws_instance", max: 3, sizes: ["t3.micro"], families: ["t4g"] }] };
  const contract = loaded(awsWithLimits(limits));
  assert.deepEqual(contract.targets.DEV.limits, limits);
  assert.equal(contract.targets.DEV.canary, undefined);
  assert.ok(authorizeContract(contract, "DEV", "APPLY").ok, "limits satisfy the APPLY rule the canary did");
  // Absent `regions` stays absent.
  assert.deepEqual(loaded(awsWithLimits({ resources: [{ type: "aws_budgets_budget", max: 1 }] })).targets.DEV.limits, { resources: [{ type: "aws_budgets_budget", max: 1 }] });
  for (const [label, value, said] of [
    ["both forms", { resources: [{ type: "aws_budgets_budget", max: 1 }] }, /DEV\.limits: a target names either a canary allowlist or provisioning limits, not both/],
  ] as const) assert.match(reasonOfShape(awsWithLimits(undefined, { limits: value })), said, label);
  for (const [label, value, said] of [
    ["a repeated type", { resources: [{ type: "aws_sns_topic", max: 1 }, { type: "aws_sns_topic", max: 2 }] }, /DEV\.limits\.resources\[1\]\.type: aws_sns_topic is listed twice/],
    ["a wildcard", { resources: [{ type: "aws_*", max: 1 }] }, /DEV\.limits\.resources\[0\]\.type: invalid/],
    ["a CloudFormation type in a Terraform contract", { resources: [{ type: "AWS::SNS::Topic", max: 1 }] }, /DEV\.limits\.resources\[0\]\.type: invalid/],
    ["a max of 0", { resources: [{ type: "aws_sns_topic", max: 0 }] }, /DEV\.limits\.resources\[0\]\.max: expected an integer from 1/],
    ["a max written as text", { resources: [{ type: "aws_sns_topic", max: "1" }] }, /DEV\.limits\.resources\[0\]\.max/],
    ["a count instead of a max", { resources: [{ type: "aws_sns_topic", count: 1 }] }, /DEV\.limits\.resources\[0\]\.count: unknown field/],
    ["retain, which stays canary-only", { resources: [{ type: "aws_sns_topic", max: 1, retain: true }] }, /DEV\.limits\.resources\[0\]\.retain: unknown field/],
    ["an unknown key", { resources: [{ type: "aws_sns_topic", max: 1 }], budget: 10 }, /DEV\.limits\.budget: unknown field/],
    ["an empty list", { resources: [] }, /DEV\.limits\.resources: expected a list of 1 to 50/],
    ["no list", { regions: [AWS_REGION] }, /DEV\.limits\.resources: missing/],
    ["sizes for a type whose size the plan is not read for", { resources: [{ type: "aws_sns_topic", max: 1, sizes: ["small"] }] }, /does not read the size of aws_sns_topic/],
    ["a size pattern", { resources: [{ type: "aws_instance", max: 1, sizes: ["t3.*"] }] }, /DEV\.limits\.resources\[0\]\.sizes\[0\]: invalid/],
    ["a repeated family", { resources: [{ type: "aws_instance", max: 1, families: ["t3", "t3"] }] }, /DEV\.limits\.resources\[0\]\.families: a name is listed twice/],
    ["empty regions", { regions: [], resources: [{ type: "aws_sns_topic", max: 1 }] }, /DEV\.limits\.regions: expected a list of 1 to 50 names/],
    ["a region that is not a region", { regions: [AWS_REGION, "Mars-1"], resources: [{ type: "aws_sns_topic", max: 1 }] }, /DEV\.limits\.regions\[1\]: invalid/],
    ["regions without the target's own", { regions: ["us-west-2"], resources: [{ type: "aws_sns_topic", max: 1 }] }, /DEV\.limits\.regions: the target's own region \(us-east-1\) is not in the allowed regions/],
  ] as const) assert.match(reasonOfShape(awsWithLimits(value)), said, label);
});

test("an engine that reads no sizes takes types, counts and regions but no sizes (CDK); a target without its own location cannot limit regions (Azure)", () => {
  const cdk = JSON.parse(readFileSync(join(CONFIG, "act-pilot-contract.aws-cdk-dev.example.json"), "utf8")) as { targets: { DEV: Record<string, unknown> }; approvers: unknown; policyVersion: string };
  delete cdk.targets.DEV.canary;
  delete (cdk as Record<string, unknown>).EXAMPLE;
  const filled = { ...cdk, approvers: [{ id: "pilot-owner", publicKeyPem: pem(), environments: ["DEV"] }] };
  const region = String(cdk.targets.DEV.region);
  cdk.targets.DEV.limits = { regions: [region], resources: [{ type: "AWS::Logs::LogGroup", max: 2 }] };
  assert.deepEqual(loaded(filled).targets.DEV.limits, { regions: [region], resources: [{ type: "AWS::Logs::LogGroup", max: 2 }] });
  cdk.targets.DEV.limits = { resources: [{ type: "AWS::EC2::Instance", max: 1, sizes: ["t3.micro"] }] };
  assert.match(reasonOfShape(filled), /the CDK engine does not read the size of AWS::EC2::Instance/);
  assert.equal(TERRAFORM_SIZE_ATTRIBUTES.aws_instance, "instance_type");

  const azure = JSON.parse(readFileSync(join(CONFIG, "act-pilot-contract.azure-dev.example.json"), "utf8")) as { targets: { DEV: Record<string, unknown> } };
  const location = "westeurope";
  delete azure.targets.DEV.canary;
  delete (azure as Record<string, unknown>).EXAMPLE;
  Object.assign(azure.targets.DEV, { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", location });
  const azureFilled = { ...azure, approvers: [{ id: "pilot-owner", publicKeyPem: pem(), environments: ["DEV"] }], policyVersion: "2026-10-11.1" };
  azure.targets.DEV.limits = { regions: [location], resources: [{ type: "azurerm_virtual_network", max: 1 }] };
  assert.deepEqual(loaded(azureFilled).targets.DEV.limits, { regions: [location], resources: [{ type: "azurerm_virtual_network", max: 1 }] });
  delete azure.targets.DEV.location;
  assert.match(reasonOfShape(azureFilled), /DEV\.limits\.regions: the target names no location, so the allowed regions cannot include it/);
});

test("limits are part of the target hash, so every seal, approval and evidence record binds them; a canary target hashes exactly as before", () => {
  const canary = loaded(awsContractJson(KILL));
  const one = loaded(awsWithLimits({ resources: [{ type: "aws_cloudwatch_log_group", max: 1 }] }));
  const two = loaded(awsWithLimits({ resources: [{ type: "aws_cloudwatch_log_group", max: 2 }] }));
  const regional = loaded(awsWithLimits({ regions: [AWS_REGION], resources: [{ type: "aws_cloudwatch_log_group", max: 1 }] }));
  const hashes = [canary, one, two, regional].map((c) => pilotTargetSha256(c, "DEV"));
  assert.equal(new Set(hashes).size, 4, "a changed maximum or region list is a target change");
  assert.equal(pilotTargetSha256(canary, "QA"), pilotTargetSha256(one, "QA"), "each environment's limits are its own");
  // The canary target's hash does not move: the same contract loaded twice gives the same hash, and the field is absent from a canary target.
  assert.equal(pilotTargetSha256(loaded(awsContractJson(KILL)), "DEV"), hashes[0]);
  assert.ok(!("limits" in canary.targets.DEV));
});

test("the shipped limits example is the AWS Terraform cost baseline, create only, and loads but for its placeholders", () => {
  const raw = JSON.parse(readFileSync(join(CONFIG, "act-pilot-contract.aws-dev-limits.example.json"), "utf8")) as { targets: { DEV: { limits: PilotLimits; region: string } } };
  const types = raw.targets.DEV.limits.resources.map((r) => r.type);
  for (const type of ["aws_budgets_budget", "aws_sns_topic", "aws_sns_topic_subscription", "aws_s3_bucket", "aws_s3_bucket_policy", "aws_bcmdataexports_export", "aws_ce_cost_allocation_tag"]) assert.ok(types.includes(type), type);
  assert.ok(raw.targets.DEV.limits.regions!.includes(raw.targets.DEV.region));
  const filled = { ...raw, policyVersion: "2026-10-11.1", approvers: [{ id: "pilot-owner", publicKeyPem: pem(), environments: ["DEV"] }] };
  assert.deepEqual(loaded(filled).targets.DEV.limits, raw.targets.DEV.limits);
  assert.equal((raw as Record<string, unknown>).authorize, undefined, "the example authorizes nothing");
});

// --- contract-check -----------------------------------------------------------------------------------------------

test("contract-check reports each target's limits or canary as one owner input, MISSING when it names neither, and attaches a limits refusal to it", () => {
  const draft = (dev: Record<string, unknown>) => ({
    schemaVersion: 1, enabled: false, provider: "AWS", engine: "TERRAFORM", policyVersion: "2026-10-11.1", enabledEnvironments: ["DEV"], embedStateWrite: true,
    targets: { DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev", ...dev } },
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 30, approvers: [{ id: "pilot-owner", publicKeyPem: pem(), environments: ["DEV"] }], killSwitchPath: ".runs/apply/STOP-DEV",
  });
  const limited = checkDraftContract(draft({ limits: { regions: ["eu-central-1"], resources: [{ type: "aws_budgets_budget", max: 1 }, { type: "aws_instance", max: 2, sizes: ["t3.micro"], families: ["t4g"] }] } }));
  assert.equal(limited.complete, true, JSON.stringify(limited.inputs.filter((x) => x.status !== "PRESENT")));
  const item = limited.inputs.find((x) => x.field === "targets.DEV.limits");
  assert.equal(item?.status, "PRESENT");
  assert.equal(item?.detail, "limits: aws_budgets_budget at most 1; aws_instance at most 2, sizes t3.micro, families t4g; regions eu-central-1; create only");
  assert.ok(contractCheckLines(limited, "draft.json").some((line) => line.includes("PRESENT     targets.DEV.limits: what an APPLY in DEV may create") && line.includes("aws_instance at most 2")));

  const canary = checkDraftContract(draft({ canary: { resources: [{ type: "aws_cloudwatch_log_group", count: 1 }] } }));
  assert.equal(canary.complete, true);
  assert.equal(canary.inputs.find((x) => x.field === "targets.DEV.canary")?.detail, "canary allowlist: aws_cloudwatch_log_group exactly 1; create only");

  const neither = checkDraftContract(draft({}));
  assert.equal(neither.complete, false);
  assert.equal(neither.inputs.find((x) => x.field === "targets.DEV.limits")?.status, "MISSING");
  assert.match(neither.inputs.find((x) => x.field === "targets.DEV.limits")!.detail!, /CANARY_ALLOWLIST_MISSING/);

  const over = checkDraftContract(draft({ limits: { resources: [{ type: "aws_budgets_budget", max: 0 }] } }));
  assert.equal(over.complete, false);
  const invalid = over.inputs.find((x) => x.field === "targets.DEV.limits");
  assert.equal(invalid?.status, "INVALID");
  assert.match(invalid!.detail!, /targets\.DEV\.limits\.resources\[0\]\.max: expected an integer from 1/);
});

test("the reviewed global AWS types carry no region of their own; a regional family under a global prefix, and every other aws_ type, is regional (review 6537650100, N2)", () => {
  for (const type of ["aws_budgets_budget", "aws_budgets_budget_action", "aws_ce_cost_allocation_tag", "aws_bcmdataexports_export", "aws_iam_role", "aws_organizations_policy", "aws_route53_zone", "aws_cloudfront_distribution"]) {
    assert.ok(isGlobalAwsType(type), type);
  }
  for (const type of ["aws_route53_resolver_endpoint", "aws_cloudwatch_log_group", "aws_s3_bucket", "aws_sns_topic", "aws_wafv2_web_acl", "aws_iamx_thing", "azurerm_virtual_network"]) {
    assert.ok(!isGlobalAwsType(type), type);
  }
  // The arguments that reach another region are a reviewed table; S3 replication (a bucket ARN names no region) is not in it, and documented as not judged.
  assert.deepEqual(Object.keys(CROSS_REGION_ATTRIBUTES).sort(), ["aws_cloudformation_stack_set_instance", "aws_dynamodb_table", "aws_ec2_transit_gateway_peering_attachment", "aws_vpc_peering_connection"]);
  limitsStop({ regions: ["us-east-1"], resources: [{ type: "aws_dynamodb_table", max: 1 }] }, [create("aws_dynamodb_table.t", { region: "us-east-1", otherRegions: ["eu-west-1"] })], /it reaches region eu-west-1/, "other region");
  limitsStop({ regions: ["us-east-1"], resources: [{ type: "aws_dynamodb_table", max: 1 }] }, [create("aws_dynamodb_table.t", { region: "us-east-1", otherRegions: [null] })], /does not show a region it reaches/, "unknown other region");
  assertLimits({ resources: [{ type: "aws_dynamodb_table", max: 1 }] }, [create("aws_dynamodb_table.t", { region: "us-east-1", otherRegions: ["eu-west-1", null] })], "plan");
});
