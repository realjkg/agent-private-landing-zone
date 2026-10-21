import assert from "node:assert/strict";
import test from "node:test";
import {
  executeScopedAwsOperation,
  type AwsBrokerRequest,
  type VerifiedAwsSession,
} from "../src/tools/aws-session-broker.js";

const now = 1_800_000_000_000;
const account = "123456789012";
const roleArn = "arn:aws:iam::123456789012:role/alz-discovery";
const request: AwsBrokerRequest = {
  requestId:"test-001", operatorId:"operator-01", stage:"DEV",
  accountId:account,region:"us-east-1",roleArn,engine:"TERRAFORM",
  capability:"DISCOVERY_READ",
};
function fixture(overrides: Partial<VerifiedAwsSession> = {}): VerifiedAwsSession {
  return {
    trust:"STS_VERIFIED_BY_HOST",kind:"WORKLOAD_OIDC",
    accountId:account,region:"us-east-1",roleArn,stage:"DEV",
    operatorId:"operator-01",expiresAtEpochMs:now+3_600_000,
    capabilities:["DISCOVERY_READ"],
    invoke:async()=>({status:"OK",evidenceRef:"evidence://aws/dev-001"}),
    ...overrides,
  };
}
async function run(
  session: VerifiedAwsSession|null, req: AwsBrokerRequest=request,
  resolve = async()=>session,
) {
  return executeScopedAwsOperation(req,{resolve},{now:()=>now});
}
test("valid scoped workload identity invokes selected adapter once without returning credentials",async()=>{
  let invoked=0;
  const result=await run(fixture({invoke:async(capability,engine)=>{
    invoked++;
    assert.equal(capability,"DISCOVERY_READ");
    assert.equal(engine,"TERRAFORM");
    return {status:"OK",evidenceRef:"evidence://aws/dev-001"};
  }}));
  assert.deepEqual(result,{allowed:true,requestId:"test-001",capability:"DISCOVERY_READ",status:"OK",evidenceRef:"evidence://aws/dev-001"});
  assert.equal(invoked,1);
  assert.ok(!JSON.stringify(result).includes("accessKey"));
});
test("SSO and CDK preview are allowed only with correct exact permission",async()=>{
  const req={...request,engine:"CDK" as const,capability:"CHANGESET_PREVIEW" as const};
  const result=await run(fixture({kind:"SSO",capabilities:["CHANGESET_PREVIEW"]}),req);
  assert.equal(result.allowed,true);
});
test("invalid and mismatched IAM role or malformed target fail without resolver invocation",async()=>{
  for(const req of [
    {...request,accountId:"123456789013"},
    {...request,roleArn:"arn:aws:iam::123456789013:role/alz-discovery"},
    {...request,region:"invalid"},
    {...request,roleArn:"arn:aws:iam::123456789012:root"},
    {...request,requestId:"bad\nid"},
  ]){
    let calls=0;
    const result=await run(fixture(),req,async()=>{calls++;return fixture();});
    assert.equal(result.allowed,false);
    assert.equal(calls,0);
  }
});
test("untrusted, expired, excessively long-lived and missing session denied before invocation",async()=>{
  let invoked=0;
  const base=fixture({invoke:async()=>{invoked++;return {status:"OK",evidenceRef:"evidence://aws/yes"};}});
  for(const session of [
    null,
    {...base,trust:"SELF_ASSERTED" as never},
    {...base,kind:"UNKNOWN" as never},
    {...base,expiresAtEpochMs:now-1},
    {...base,expiresAtEpochMs:now+29_999},
    {...base,expiresAtEpochMs:now+13*3600_000},
  ]){
    const result=await run(session);
    assert.equal(result.allowed,false);
  }
  assert.equal(invoked,0);
});
test("cross account, region, role, stage and operator identity are independent denials",async()=>{
  const variations:[Partial<VerifiedAwsSession>,string][]=[
    [{accountId:"123456789013"},"ACCOUNT_MISMATCH"],
    [{region:"us-west-2"},"REGION_MISMATCH"],
    [{roleArn:"arn:aws:iam::123456789012:role/other"},"ROLE_MISMATCH"],
    [{stage:"PROD"},"STAGE_MISMATCH"],
    [{operatorId:"different"},"OPERATOR_MISMATCH"],
  ];
  for(const [override,code] of variations){
    const result=await run(fixture(override));
    assert.deepEqual(result,{allowed:false,code,requestId:request.requestId});
  }
});
test("capabilities do not imply one another and engine cannot be switched",async()=>{
  assert.deepEqual(await run(fixture({capabilities:[]})),
    {allowed:false,code:"CAPABILITY_DENIED",requestId:request.requestId});
  const mismatch=await run(fixture(),{...request,capability:"CHANGESET_PREVIEW"});
  assert.deepEqual(mismatch,{allowed:false,code:"ENGINE_CAPABILITY_MISMATCH",requestId:request.requestId});
  const cdk=await run(fixture(),{...request,engine:"CDK",capability:"IAC_PLAN"});
  assert.equal(cdk.allowed,false);
  assert.equal(await run(fixture({capabilities:["APPLY" as never]})).then(r=>r.allowed),false);
});
test("resolver failure and adapter errors fail closed without exception or secret echo",async()=>{
  const privateToken="aws-session-token-top-secret";
  const resolverFailure=await executeScopedAwsOperation(request,{
    resolve:async()=>{throw new Error(privateToken);}
  },{now:()=>now});
  assert.deepEqual(resolverFailure,{allowed:false,code:"SESSION_UNAVAILABLE",requestId:request.requestId});
  const invokeFailure=await run(fixture({invoke:async()=>{throw new Error(privateToken);}}));
  assert.deepEqual(invokeFailure,{allowed:false,code:"ADAPTER_FAILED",requestId:request.requestId});
  for(const evidenceRef of [privateToken,"https://example.com/token","evidence://../escape","evidence://"]){
    const outcome=await run(fixture({invoke:async()=>({status:"OK",evidenceRef})}));
    assert.deepEqual(outcome,{allowed:false,code:"ADAPTER_FAILED",requestId:request.requestId});
  }
});
