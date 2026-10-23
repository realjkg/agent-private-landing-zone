import assert from "node:assert/strict";
import test from "node:test";
import { AWS_DEV_OU, AWS_BASELINE, AWS_MANAGEMENT, awsRead, checkDevAccount, validatedAccountRequest } from "../src/cli/act-dev1-admin.js";

const ACCOUNT="111111111111";
const OU_ARN="arn:aws:organizations::973471129135:ou/o-sample/"+AWS_DEV_OU;
function fake(over: Record<string,unknown> = {}) {
  const calls: string[][]=[];
  const read=async (args:readonly string[]) => {
    calls.push([...args]);
    const cmd=args.slice(0,2).join(" ");
    if(cmd==="sts get-caller-identity") return {Account:AWS_MANAGEMENT};
    if(cmd==="organizations describe-account") return {Account:{Id:ACCOUNT,State: "ACTIVE",...over.account as object}};
    if(cmd==="organizations list-parents") return {Parents:over.parents??[{Id:AWS_DEV_OU,Type:"ORGANIZATIONAL_UNIT"}]};
    if(cmd==="organizations describe-organizational-unit") return {OrganizationalUnit:{Arn:OU_ARN}};
    if(cmd==="controltower list-enabled-baselines") return {enabledBaselines:over.baselines??[{
      baselineIdentifier:AWS_BASELINE,targetIdentifier:OU_ARN,statusSummary:{status:"SUCCEEDED"}
    }]};
    throw Error("UNEXPECTED_AWS_CALL");
  };
  return {read,calls};
}
test("only exact saved profile and member account can be checked", () => {
  assert.deepEqual(validatedAccountRequest({account:ACCOUNT,profile:"adaptcloud-admin"}),{account:ACCOUNT,profile:"adaptcloud-admin"});
  for (const value of [
    {account:AWS_MANAGEMENT,profile:"good"},{account:ACCOUNT,profile:"bad;touch /tmp/x"},
    {account:ACCOUNT,profile:"good",role:"APPLY"},{account:"111",profile:"good"},
  ]) assert.throws(()=>validatedAccountRequest(value));
});
test("verified DEV account is not ACT authorization", async () => {
  const {read,calls}=fake();
  const result=await checkDevAccount({account:ACCOUNT,profile:"adaptcloud-admin"},read);
  assert.equal(result.status,"ACCOUNT_VERIFIED");
  assert.equal(result.actEnabled,false);
  assert.equal(result.action,"NONE");
  assert.deepEqual(result.checks.map(c=>c.status),["VERIFIED","VERIFIED","VERIFIED"]);
  assert.deepEqual(calls.map(c=>c.slice(0,2).join(" ")),[
    "sts get-caller-identity","organizations describe-account","organizations list-parents",
    "organizations describe-organizational-unit","controltower list-enabled-baselines"
  ]);
  assert.ok(calls.every(c=>c.includes("--profile") && c.includes("--output")));
  assert.equal(JSON.stringify(calls).includes("apply"),false);
});
test("wrong OU and missing governance fail closed", async () => {
  const target={account:ACCOUNT,profile:"adaptcloud-admin"};
  await assert.rejects(checkDevAccount(target,fake({parents:[]}).read),/ACCOUNT_NOT_IN_WORKLOADS/);
  await assert.rejects(checkDevAccount(target,fake({baselines:[]}).read),/BASELINE_NOT_VERIFIED/);
  await assert.rejects(checkDevAccount(target,fake({account:{State:"SUSPENDED"}}).read),/ACCOUNT_NOT_ACTIVE/);
  await assert.rejects(checkDevAccount({account:AWS_MANAGEMENT,profile:"adaptcloud-admin"},fake().read),/DEDICATED_DEV_ACCOUNT/);
});
