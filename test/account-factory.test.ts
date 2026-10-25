import assert from "node:assert/strict";
import test from "node:test";
import { run as runCli } from "../src/cli/account-factory.js";
import {
  prepare, submit, follow, status, verifyAdministrator, verifyProposal, verifyProvisionedAccount,
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
      ].map(ParameterKey => ({ ParameterKey, ParameterType: "String", IsNoEcho: false })),
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
    const override = Object.hasOwn(opts.changes ?? {}, key);
    if (key === "organizations list-organizational-units-for-parent" && !override && args.includes(targetId))
      return { OrganizationalUnits: [] };
    if (key === "controltower list-enabled-baselines" && !override && args.includes("--include-children"))
      return { enabledBaselines: [{
        arn: "arn:aws:controltower:us-east-2:" + management + ":enabledbaseline/XABCDEFGH12345678",
        baselineIdentifier: baselineArn,
        targetIdentifier: "arn:aws:organizations::" + management +
          ":account/" + orgId + "/111111111111",
        parentIdentifier: "arn:aws:controltower:us-east-2:" + management +
          ":enabledbaseline/XOUABCDEFG123456",
        statusSummary: { status: "SUCCEEDED" },
        driftStatusSummary: { types: { inheritance: { status: "IN_SYNC" } } },
      }] };
    const response = override ? opts.changes![key] : responses[key];
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
  assert.equal(p.provisionedProductName, intake.name);
  assert.equal(p.infrastructureAct, "DISABLED");
  assert.ok(f.calls.every(x => x[1] !== "provision-product"));
  assert.equal(p.parameters.find(x => x.Key === "ManagedOrganizationalUnit")!.Value,
    "Workloads (" + targetId + ")");
  verifyProposal(p);
  assert.throws(() => verifyProposal({ ...p, accountName: "Altered" }), /PROPOSAL_TAMPERED/);
  assert.throws(() => verifyProposal({ ...p, status: "READY" as never }), /PROPOSAL_TAMPERED/);
  assert.throws(() => verifyProposal({ ...p, infrastructureAct: "ENABLED" as never }), /PROPOSAL_TAMPERED/);
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
test("AWS-shaped ParameterKey entries and account display names with spaces are handled correctly", async () => {
  const values = ["AccountName", "AccountEmail", "SSOUserEmail", "SSOUserFirstName",
    "SSOUserLastName", "ManagedOrganizationalUnit"].map(ParameterKey =>
    ({ ParameterKey, ParameterType: "String", ParameterConstraints: ParameterKey ===
      "ManagedOrganizationalUnit" ? { AllowedValues: ["Workloads (" + targetId + ")"] } : {} }));
  const f = fixture({ changes: { "servicecatalog describe-provisioning-parameters": {
    ProvisioningArtifactParameters: values,
  } } });
  const display = "Customer Dev Space";
  const p = await prepare({ ...intake, name: display }, f.call);
  assert.equal(p.accountName, display);
  assert.match(p.provisionedProductName, /^Customer-Dev-Space-[a-f0-9]{8}$/);
  assert.equal(p.parameters.find(x => x.Key === "AccountName")?.Value, display);
  const provision = fixture();
  await submit(p, intake.profile, provision.call);
  const call = provision.calls.find(x => x[1] === "provision-product")!;
  assert.equal(call[call.indexOf("--provisioned-product-name") + 1], p.provisionedProductName);
  assert.doesNotMatch(p.provisionedProductName, / /);
});
test("Account Factory refuses AWS product schemas missing real parameters or target OU offerings", async () => {
  const missing = fixture({ changes: { "servicecatalog describe-provisioning-parameters": {
    ProvisioningArtifactParameters: [
      { ParameterKey: "AccountName" }, { ParameterKey: "AccountEmail" },
    ],
  } } });
  await assert.rejects(prepare(intake, missing.call), /ACCOUNT_FACTORY_SCHEMA_UNEXPECTED/);
  const extra = fixture({ changes: { "servicecatalog describe-provisioning-parameters": {
    ProvisioningArtifactParameters: ["AccountName", "AccountEmail", "SSOUserEmail",
      "SSOUserFirstName", "SSOUserLastName", "ManagedOrganizationalUnit",
      "CustomerMandatoryField"].map(ParameterKey => ({ ParameterKey })),
  } } });
  await assert.rejects(prepare(intake, extra.call), /ACCOUNT_FACTORY_ADDITIONAL_REQUIRED_PARAMETER/);
  const noOu = fixture({ changes: { "servicecatalog describe-provisioning-parameters": {
    ProvisioningArtifactParameters: ["AccountName", "AccountEmail", "SSOUserEmail",
      "SSOUserFirstName", "SSOUserLastName", "ManagedOrganizationalUnit"].map(ParameterKey =>
        ({ ParameterKey, ParameterConstraints: ParameterKey === "ManagedOrganizationalUnit" ?
          { AllowedValues: ["Sandbox (ou-zzzz-abcdef12)"] } : {} })),
  } } });
  await assert.rejects(prepare(intake, noOu.call), /TARGET_OU_NOT_OFFERED_BY_ACCOUNT_FACTORY/);
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
  assert.equal(result.controlTowerAccountEnrollment, "CHILD_BASELINE_SUCCEEDED");
  assert.equal(result.childBaselineStatus, "SUCCEEDED");
  await assert.rejects(verifyProvisionedAccount(intake.profile, intake.name, intake.email,
    fixture({ changes: { "organizations list-parents": { Parents: [] },
      "organizations list-accounts": {
        Accounts: [{ Id: member, Name: intake.name, Email: intake.email, State: "ACTIVE" }],
      } } }).call), /ACCOUNT_NOT_IN_MANAGED_OU/);
});
test("account baseline is not marked complete when Control Tower child inheritance is absent or drifted", async () => {
  const member = "111111111111";
  const account = { "organizations list-accounts": {
    Accounts: [{ Id: member, Name: intake.name, Email: intake.email, State: "ACTIVE" }],
  } };
  const absent = fixture({ changes: {
    ...account,
    "controltower list-enabled-baselines": { enabledBaselines: [
      { targetIdentifier: "arn:aws:organizations::" + originalManagement +
          ":ou/" + originalOrg + "/" + targetId,
        baselineIdentifier: "arn:aws:controltower:us-east-2::baseline/17BSJV3IGJ2QSGA2",
        statusSummary: { status: "SUCCEEDED" },
      },
    ] },
  } });
  const result = await verifyProvisionedAccount(intake.profile, intake.name, intake.email, absent.call);
  assert.equal(result.controlTowerAccountEnrollment, "NOT_INDEPENDENTLY_CONFIRMED");
  const proposal = await prepare(intake, fixture().call);
  const receipt = await submit(proposal, intake.profile, fixture().call);
  const tracked = await follow(intake.profile, proposal, receipt, absent.call,
    { maxPolls: 1, intervalMs: 0, pause: async () => {} });
  assert.equal(tracked.status, "ACCOUNT_BASELINE_PENDING");
  assert.equal(tracked.verified, false);
  assert.equal(tracked.accountId, member);
});
test("Account Factory CLI advertises guided workflow without invoking the cloud", async () => {
  await runCli(["--help"]);
  assert.equal(process.exitCode ?? 0, 0);
});

test("resumable tracking returns member-account readback without another submission", async () => {
  const proposal = await prepare(intake, fixture().call);
  const receipt = await submit(proposal, intake.profile, fixture().call);
  const member = "111111111111";
  const f = fixture({ changes: { "organizations list-accounts": {
    Accounts: [{ Id: member, Name: intake.name, Email: intake.email, State: "ACTIVE" }],
  } } });
  const completed = await follow(intake.profile, proposal, receipt, f.call,
    { maxPolls: 1, intervalMs: 0, pause: async () => {} });
  assert.equal(completed.status, "MEMBER_ACCOUNT_VERIFIED");
  assert.equal(completed.accountId, member);
  assert.ok(f.calls.every(x => x[1] !== "provision-product"));
});
test("tracking is bounded and remains in progress without claiming success", async () => {
  const p = await prepare(intake, fixture().call);
  const receipt = await submit(p, intake.profile, fixture().call);
  const f = fixture({ changes: {
    "servicecatalog describe-record": {
      RecordDetail: { RecordId: receipt.recordId, Status: "IN_PROGRESS" },
    },
  } });
  const result = await follow(intake.profile, p, receipt, f.call,
    { maxPolls: 2, intervalMs: 0, pause: async () => {} });
  assert.equal(result.status, "PROVISIONING_IN_PROGRESS");
  assert.equal(result.verified, false);
  await assert.rejects(follow(intake.profile, p, { ...receipt, requestHash: "wrong" },
    fixture().call, { maxPolls: 1, intervalMs: 0 }), /REQUEST_RECEIPT_MISMATCH/);
  const foreign = fixture({ management: "111122223333", orgId: "o-abcd1234567" });
  await assert.rejects(follow(intake.profile, p, receipt, foreign.call,
    { maxPolls: 1, intervalMs: 0 }), /TRACKING_ORGANIZATION_CHANGED/);
});
