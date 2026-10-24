import assert from "node:assert/strict";
import test from "node:test";
import { run as runCli } from "../src/cli/account-factory.js";
import {
  prepare, submit, status, verifyAdministrator, verifyProposal, verifyProvisionedAccount,
  type AwsCall, type Intake,
} from "../src/account-factory/flow.js";

const originalManagement = "973471129135";
const originalOrg = "o-0u6mts6li3";
const targetId = "ou-dnkl-3tbf48bv";
const role = "AWSReservedSSO_AWSAdministratorAccess_7b52a7ec08abfa76";
const intake: Intake = {
  profile: "adaptcloud-admin", practiceRole: "MODERN_PLATFORMS_DELIVERY",
  environment: "DEV", name: "ALZ-DEV-01", email: "dev@example.org",
  ownerEmail: "owner@example.org", ownerFirst: "Example", ownerLast: "Operator",
};
function fixture(opts: {
  management?: string; orgId?: string; changes?: Record<string, unknown>;
} = {}) {
  const management = opts.management ?? originalManagement;
  const orgId = opts.orgId ?? originalOrg;
  const arn = "arn:aws:sts::" + management + ":assumed-role/" + role + "/jkristian";
  const ouArn = "arn:aws:organizations::" + management + ":ou/" + orgId + "/" + targetId;
  const zoneArn = "arn:aws:controltower:us-east-2:" + management + ":landingzone/253WW1B5S01IEWOT";
  const baselineArn = "arn:aws:controltower:us-east-2::baseline/17BSJV3IGJ2QSGA2";
  const responses: Record<string, Record<string, any>> = {
    "sts get-caller-identity": { Account: management, Arn: arn },
    "organizations describe-organization": { Organization: { Id: orgId, ManagementAccountId: management } },
    "organizations list-accounts": { Accounts: [{ Name: "Management", Email: "mgmt@example.org" }] },
    "organizations list-roots": { Roots: [{ Id: "r-dnkl" }] },
    "organizations list-organizational-units-for-parent": {
      OrganizationalUnits: [{ Id: targetId, Name: "Workloads", Arn: ouArn }],
    },
    "organizations describe-organizational-unit": {
      OrganizationalUnit: { Id: targetId, Name: "Workloads", Arn: ouArn },
    },
    "organizations list-parents": { Parents: [{ Id: targetId, Type: "ORGANIZATIONAL_UNIT" }] },
    "controltower list-landing-zones": { landingZones: [{ arn: zoneArn }] },
    "controltower get-landing-zone": {
      landingZone: { arn: zoneArn, status: "ACTIVE", driftStatus: { status: "IN_SYNC" } },
    },
    "controltower list-enabled-baselines": {
      enabledBaselines: [{
        targetIdentifier: ouArn, baselineIdentifier: baselineArn,
        statusSummary: { status: "SUCCEEDED" },
      }],
    },
    "controltower get-baseline": { arn: baselineArn, name: "AWSControlTowerBaseline" },
    "servicecatalog search-products-as-admin": {
      ProductViewDetails: [{
        ProductViewSummary: { Name: "AWS Control Tower Account Factory", ProductId: "prod-abc123" },
      }],
    },
    "servicecatalog describe-product-as-admin": {
      ProvisioningArtifactSummaries: [{ Id: "pa-abc123", Active: true }],
    },
    "servicecatalog list-launch-paths": { LaunchPathSummaries: [{ Id: "lpv3-abc123" }] },
    "servicecatalog describe-provisioning-parameters": {
      ProvisioningArtifactParameters: [
        "AccountName", "AccountEmail", "SSOUserEmail", "SSOUserFirstName",
        "SSOUserLastName", "ManagedOrganizationalUnit",
      ].map(ParameterKey => ({ Parameter: { ParameterKey } })),
    },
    "servicecatalog provision-product": {
      RecordDetail: { RecordId: "rec-abc123", ProvisionedProductId: "pp-abc123" },
    },
    "servicecatalog describe-record": {
      RecordDetail: { RecordId: "rec-abc123", Status: "SUCCEEDED", RecordType: "PROVISION_PRODUCT" },
    },
  };
  const calls: string[][] = [];
  const call: AwsCall = async (_profile, args) => {
    calls.push([...args]);
    const key = args.slice(0, 2).join(" ");
    const response = Object.hasOwn(opts.changes ?? {}, key) ? opts.changes![key] : responses[key];
    if (!response) throw Error("UNEXPECTED_API:" + key);
    return response as Record<string, any>;
  };
  return { call, calls, arn, zoneArn, ouArn };
}
test("read existing authenticated AWS role; root and wrong management org are rejected", async () => {
  const x = fixture();
  assert.deepEqual(await verifyAdministrator(intake.profile, x.call),
    { Account: originalManagement, Arn: x.arn });
  await assert.rejects(verifyAdministrator(intake.profile, fixture({
    changes: { "sts get-caller-identity": {
      Account: originalManagement, Arn: "arn:aws:iam::" + originalManagement + ":root",
    }},
  }).call), /ASSUMED_ROLE_SESSION_REQUIRED/);
  await assert.rejects(prepare(intake, fixture({
    changes: { "organizations describe-organization": {
      Organization: { Id: originalOrg, ManagementAccountId: "111111111111" },
    }},
  }).call), /MANAGEMENT_ORGANIZATION_MISMATCH/);
});
test("discover organization, OU, baseline and modern launch path; proposal makes no write", async () => {
  const f = fixture();
  const p = await prepare(intake, f.call);
  assert.equal(p.orgId, originalOrg);
  assert.equal(p.managementAccount, originalManagement);
  assert.equal(p.ouId, targetId);
  assert.equal(p.landingZoneArn, f.zoneArn);
  assert.equal(p.environment, "DEV");
  assert.equal(p.pathId, "lpv3-abc123");
  assert.equal(p.status, "READY_FOR_CONFIRMATION");
  assert.equal(p.infrastructureAct, "DISABLED");
  assert.ok(f.calls.every(x => x[1] !== "provision-product"));
  assert.equal(p.parameters.find(x => x.Key === "ManagedOrganizationalUnit")!.Value,
    "Workloads (" + targetId + ")");
  verifyProposal(p);
  assert.throws(() => verifyProposal({ ...p, accountName: "Altered" }), /PROPOSAL_TAMPERED/);
  assert.throws(() => verifyProposal(p, new Date(Date.now() + 3 * 60 * 60_000)), /PROPOSAL_EXPIRED/);
});
test("different management accounts and organizations are discovered rather than hardcoded", async () => {
  const other = fixture({ management: "111122223333", orgId: "o-abcd1234567" });
  const p = await prepare({ ...intake, name: "Customer-DEV-01" }, other.call);
  assert.equal(p.managementAccount, "111122223333");
  assert.equal(p.orgId, "o-abcd1234567");
  assert.equal(p.landingZoneArn, other.zoneArn);
  verifyProposal(p);
});
test("four practices and DEV QA STAGING PROD all use the same supported workflow", async () => {
  const roles = ["MODERN_PLATFORMS_PRESALES", "MODERN_PLATFORMS_DELIVERY",
    "DIGITAL_PRESALES", "DIGITAL_DELIVERY"] as const;
  const envs = ["DEV", "QA", "STAGING", "PROD"] as const;
  for (const practiceRole of roles) {
    for (const environment of envs) {
      const p = await prepare({ ...intake, practiceRole, environment }, fixture().call);
      assert.equal(p.requesterPracticeRole, practiceRole);
      assert.equal(p.environment, environment);
      assert.equal(p.roleClassification, "DECLARED_NOT_AUTHORIZING");
    }
  }
  await assert.rejects(prepare({ ...intake, environment: "ROOT" as never }, fixture().call),
    /ENVIRONMENT_INVALID/);
});
test("unhealthy landing zones, ambiguous OU, missing baseline or product block creation", async () => {
  const cases = [
    { "organizations list-organizational-units-for-parent": { OrganizationalUnits: [] } },
    { "controltower list-landing-zones": { landingZones: [] } },
    { "controltower list-enabled-baselines": { enabledBaselines: [] } },
    { "controltower get-baseline": { name: "AuditBaseline" } },
    { "servicecatalog search-products-as-admin": { ProductViewDetails: [] } },
    { "organizations list-accounts": { Accounts: [{ Name: intake.name, Email: intake.email }] } },
  ];
  for (const changes of cases) {
    const f = fixture({ changes });
    await assert.rejects(prepare(intake, f.call));
    assert.ok(!f.calls.some(x => x[1] === "provision-product"));
  }
});
test("AWS SSO identity and unique member account rechecked before one submission", async () => {
  const p = await prepare(intake, fixture().call);
  const f = fixture();
  const submitted = await submit(p, intake.profile, f.call);
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(f.calls.filter(x => x[1] === "provision-product").length, 1);
  assert.ok(f.calls.find(x => x[1] === "provision-product")!.includes("--provision-token"));
  await assert.rejects(submit(p, intake.profile, fixture({
    changes: { "sts get-caller-identity": {
      Account: originalManagement, Arn: fixture().arn.replace("jkristian", "different"),
    }},
  }).call), /AWS_IDENTITY_CHANGED/);
  await assert.rejects(submit(p, intake.profile, fixture({
    changes: { "organizations list-accounts": { Accounts: [{ Name: intake.name, Email: intake.email }] } },
  }).call), /ACCOUNT_ALREADY_EXISTS/);
});
test("Service Catalog progress never overstates account enrollment", async () => {
  const s = await status(intake.profile, "rec-abc123", fixture().call);
  assert.equal(s.providerStatus, "SUCCEEDED");
  assert.equal(s.verified, false);
  await assert.rejects(status(intake.profile, "wrong", fixture().call), /RECORD_ID_INVALID/);
});
test("independent post-provision readback confirms member/OU but not unobserved enrollment", async () => {
  const member = "111111111111";
  const good = fixture({ changes: { "organizations list-accounts": {
    Accounts: [{ Id: member, Name: intake.name, Email: intake.email, State: "ACTIVE" }],
  } } });
  const result = await verifyProvisionedAccount(intake.profile, intake.name, intake.email, good.call);
  assert.equal(result.accountId, member);
  assert.equal(result.targetOuId, targetId);
  assert.equal(result.controlTowerAccountEnrollment, "NOT_INDEPENDENTLY_CONFIRMED");
  await assert.rejects(verifyProvisionedAccount(intake.profile, intake.name, intake.email,
    fixture({ changes: { "organizations list-parents": { Parents: [] },
      "organizations list-accounts": {
        Accounts: [{ Id: member, Name: intake.name, Email: intake.email, State: "ACTIVE" }],
      } } }).call), /ACCOUNT_NOT_IN_MANAGED_OU/);
});
test("Account Factory CLI advertises guided workflow without invoking the cloud", async () => {
  await runCli(["--help"]);
  assert.equal(process.exitCode ?? 0, 0);
});
