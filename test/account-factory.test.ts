import assert from "node:assert/strict";
import test from "node:test";
import { run as runAccountFactoryCli } from "../src/cli/account-factory.js";
import {prepare,submit,status,verifyAdministrator,verifyProposal,verifyProvisionedAccount, type AwsCall, type Intake, MANAGEMENT_ACCOUNT, WORKLOADS_OU} from "../src/account-factory/flow.js";
const arn="arn:aws:sts::973471129135:assumed-role/AWSReservedSSO_AWSAdministratorAccess_7b52a7ec08abfa76/jkristian";
const ou="arn:aws:organizations::973471129135:ou/o-0u6mts6li3/"+WORKLOADS_OU;
const intake:Intake={profile:"adaptcloud-admin",practiceRole:"MODERN_PLATFORMS_DELIVERY",name:"ALZ-DEV-01",email:"newdev@example.org",ownerEmail:"owner@example.org",ownerFirst:"Test",ownerLast:"Owner"};
function fixture(changes:Record<string,unknown>={}){
  const calls:string[][]=[];
  const responses:Record<string,Record<string,unknown>>={
    "sts get-caller-identity":{Account:MANAGEMENT_ACCOUNT,Arn:arn},
    "organizations describe-organization":{Organization:{Id:"o-0u6mts6li3",ManagementAccountId:MANAGEMENT_ACCOUNT}},
    "organizations list-accounts":{Accounts:[{Name:"Adapt Cloud",Email:"root@example.org"}]},
    "organizations describe-organizational-unit":{OrganizationalUnit:{Id:WORKLOADS_OU,Name:"Workloads",Arn:ou}},
    "controltower list-landing-zones":{landingZones:[{arn:"arn:aws:controltower:us-east-2:973471129135:landingzone/253WW1B5S01IEWOT"}]},
    "controltower get-landing-zone":{landingZone:{status:"ACTIVE",driftStatus:{status:"IN_SYNC"}}},
    "controltower list-enabled-baselines":{enabledBaselines:[{targetIdentifier:ou,baselineIdentifier:"arn:aws:controltower:us-east-2::baseline/17BSJV3IGJ2QSGA2",statusSummary:{status:"SUCCEEDED"}}]},
    "servicecatalog search-products-as-admin":{ProductViewDetails:[{ProductViewSummary:{Name:"AWS Control Tower Account Factory",ProductId:"prod-abc123"}}]},
    "servicecatalog describe-product-as-admin":{ProvisioningArtifactSummaries:[{Active:true,Id:"pa-abc123"}]},
    "servicecatalog list-launch-paths":{LaunchPathSummaries:[{Id:"lp-abc123"}]},
    "servicecatalog describe-provisioning-parameters":{ProvisioningArtifactParameters:["AccountName","AccountEmail","SSOUserEmail","SSOUserFirstName","SSOUserLastName","ManagedOrganizationalUnit"].map(ParameterKey=>({Parameter:{ParameterKey}}))},
    "servicecatalog provision-product":{RecordDetail:{RecordId:"rec-abc123",ProvisionedProductId:"pp-abc123"}},
    "servicecatalog describe-record":{RecordDetail:{RecordId:"rec-abc123",Status:"SUCCEEDED",RecordType:"PROVISION_PRODUCT"}}
  };
  const call:AwsCall=async (_profile,args)=>{
    calls.push([...args]);const k=args.slice(0,2).join(" ");
    const v=Object.hasOwn(changes,k)?changes[k]:responses[k];
    if(!v)throw Error("UNEXPECTED_API:"+k);
    return v as Record<string,any>;
  };
  return {call,calls};
}
test("existing approved non-root administrator session is required",async()=>{
  assert.equal((await verifyAdministrator("adaptcloud-admin",fixture().call)).Arn,arn);
  await assert.rejects(verifyAdministrator("adaptcloud-admin",fixture({"sts get-caller-identity":{Account:MANAGEMENT_ACCOUNT,Arn:"arn:aws:iam::973471129135:root"}}).call),/MANAGEMENT_SSO_ADMIN_REQUIRED/);
  await assert.rejects(verifyAdministrator("adaptcloud-admin",fixture({"sts get-caller-identity":{Account:"111111111111",Arn:arn}}).call),/MANAGEMENT_SSO_ADMIN_REQUIRED/);
});
test("discovery builds a short-lived review-only immutable proposal",async()=>{
  const mock=fixture();const p=await prepare(intake,mock.call);
  assert.equal(p.ouId,WORKLOADS_OU);assert.equal(p.requesterPracticeRole,"MODERN_PLATFORMS_DELIVERY");assert.equal(p.status,"AWAITING_OWNER_AND_FINANCE_APPROVAL");
  assert.equal(p.infrastructureAct,"DISABLED");assert.equal(p.financialEvidence,"UNVERIFIED");
  assert.ok(mock.calls.every(x=>x[1]!=="provision-product"));
  assert.equal(p.parameters.find(x=>x.Key==="ManagedOrganizationalUnit")?.Value,"Workloads ("+WORKLOADS_OU+")");
  verifyProposal(p);
  assert.throws(()=>verifyProposal({...p,accountName:"Modified"}),/PROPOSAL_TAMPERED/);
  assert.throws(()=>verifyProposal(p,new Date(Date.now()+16*60_000)),/PROPOSAL_EXPIRED/);
});
test("governance and uniqueness denials never call provision-product",async()=>{
  for(const overrides of [
    {"organizations list-accounts":{Accounts:[{Name:intake.name,Email:intake.email}]}},
    {"controltower list-enabled-baselines":{enabledBaselines:[]}},
    {"servicecatalog search-products-as-admin":{ProductViewDetails:[]}},
  ]){
    const mock=fixture(overrides);
    await assert.rejects(prepare(intake,mock.call));
    assert.ok(mock.calls.every(x=>x[1]!=="provision-product"));
  }
});
test("approval is required and is bound to exact proposal hash",async()=>{
  const p=await prepare(intake,fixture().call);
  const mock=fixture();
  await assert.rejects(submit(p,intake.profile,p.proposalHash,false,mock.call),/OWNER_AND_FINANCE_APPROVAL_REQUIRED/);
  await assert.rejects(submit(p,intake.profile,"wrong",true,mock.call),/OWNER_AND_FINANCE_APPROVAL_REQUIRED/);
  assert.equal(mock.calls.length,0);
  const accepted=await submit(p,intake.profile,p.proposalHash,true,mock.call);
  assert.equal(accepted.status,"SUBMITTED");
  assert.equal(mock.calls.filter(x=>x[1]==="provision-product").length,1);
});
test("identity changes and duplicate names deny submission",async()=>{
  const p=await prepare(intake,fixture().call);
  const changed=fixture({"sts get-caller-identity":{Account:MANAGEMENT_ACCOUNT,Arn:arn.replace("jkristian","other")}});
  await assert.rejects(submit(p,intake.profile,p.proposalHash,true,changed.call),/ADMIN_SESSION_CHANGED/);
  const dupe=fixture({"organizations list-accounts":{Accounts:[{Name:intake.name,Email:intake.email}]}});
  await assert.rejects(submit(p,intake.profile,p.proposalHash,true,dupe.call),/ACCOUNT_ALREADY_EXISTS/);
});
test("successful Service Catalog record does not establish independent account verification",async()=>{
  const s=await status(intake.profile,"rec-abc123",fixture().call);
  assert.equal(s.providerStatus,"SUCCEEDED");assert.equal(s.verified,false);
  await assert.rejects(status(intake.profile,"bad",fixture().call),/RECORD_ID_INVALID/);
});

test("operator CLI exposes the guarded Account Factory help without cloud calls",async()=>{
  await runAccountFactoryCli(["--help"]);
  assert.equal(process.exitCode ?? 0,0);
});

test("independent account readback requires active member account and correct OU",async()=>{
  const member="111111111111";
  const ok=fixture({
    "organizations list-accounts":{Accounts:[{Id:member,Name:intake.name,Email:intake.email,State:"ACTIVE"}]},
    "organizations list-parents":{Parents:[{Id:WORKLOADS_OU,Type:"ORGANIZATIONAL_UNIT"}]}
  });
  const value=await verifyProvisionedAccount(intake.profile,intake.name,intake.email,ok.call);
  assert.equal(value.accountId,member);
  assert.equal(value.controlTowerAccountEnrollment,"NOT_INDEPENDENTLY_CONFIRMED");
  for(const [key,override] of [
    ["organizations list-parents",{Parents:[]}],
    ["organizations list-accounts",{Accounts:[{Id:member,Name:intake.name,Email:intake.email,State:"SUSPENDED"}]}]
  ] as const){
    const broken=fixture({
      "organizations list-accounts":{Accounts:[{Id:member,Name:intake.name,Email:intake.email,State:"ACTIVE"}]},
      "organizations list-parents":{Parents:[{Id:WORKLOADS_OU,Type:"ORGANIZATIONAL_UNIT"}]},
      [key]:override,
    });
    await assert.rejects(verifyProvisionedAccount(intake.profile,intake.name,intake.email,broken.call));
  }
});

test("all four practice roles can prepare governed DEV proposals but role claim alone grants no authority",async()=>{
  for(const practiceRole of ["MODERN_PLATFORMS_PRESALES","MODERN_PLATFORMS_DELIVERY","DIGITAL_PRESALES","DIGITAL_DELIVERY"] as const){
    const next=await prepare({...intake,practiceRole},fixture().call);
    assert.equal(next.requesterPracticeRole,practiceRole);
    assert.equal(next.roleClassification,"DECLARED_NOT_AUTHORIZING");
    assert.equal(next.financialEvidence,"UNVERIFIED");
    await assert.rejects(submit(next,intake.profile,next.proposalHash,false,fixture().call),/OWNER_AND_FINANCE_APPROVAL_REQUIRED/);
  }
  await assert.rejects(prepare({...intake,practiceRole:"UNTRUSTED" as never},fixture().call),/PRACTICE_ROLE_INVALID/);
});
