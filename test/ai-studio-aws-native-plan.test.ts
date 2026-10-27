import test from "node:test";
import assert from "node:assert/strict";
import { assessNativeAwsPlan, type NativePlan } from "../src/integrations/ai-studio/aws-native-plan.js";
const existing={organization:"EXISTS",landingZone:"EXISTS",managementAccountVerified:true} as const;
const absent={organization:"EXISTS",landingZone:"ABSENT",managementAccountVerified:true} as const;
const terraform=(type:string,actions:string[])=>({
 engine:"TERRAFORM",payload:{resource_changes:[{type,change:{actions}}]}
}) as NativePlan;
const cfn=(type:string,action:string)=>({
 engine:"CLOUDFORMATION",payload:{Changes:[{ResourceChange:{ResourceType:type,Action:action}}]}
}) as NativePlan;
test("Terraform actual plan admits additive workload resource",()=>{
 assert.equal(assessNativeAwsPlan(terraform("aws_cloudwatch_log_group",["create"]),existing).allowed,true);
});
test("Terraform blocks parallel AWS organization or Control Tower creation",()=>{
 for(const type of ["aws_organizations_organization","aws_controltower_landing_zone"]) {
  const r=assessNativeAwsPlan(terraform(type,["create"]),existing);
  assert.equal(r.allowed,false);
  assert.ok(r.reasons.includes("PARALLEL_GOVERNANCE_FORBIDDEN"));
 }
});
test("absence routes initial Control Tower create to separate bootstrap approval",()=>{
 const r=assessNativeAwsPlan(terraform("aws_controltower_landing_zone",["create"]),absent);
 assert.deepEqual(r.reasons,["FIRST_TIME_GOVERNANCE_BOOTSTRAP_REQUIRES_SEPARATE_AUTHORITY"]);
});
test("CloudFormation and CDK change sets classify controls and estate roots",()=>{
 assert.equal(assessNativeAwsPlan(cfn("AWS::ControlTower::EnabledControl","Modify"),existing).allowed,false);
 assert.equal(assessNativeAwsPlan(cfn("AWS::ControlTower::LandingZone","Add"),existing).allowed,false);
 assert.equal(assessNativeAwsPlan({...cfn("AWS::Logs::LogGroup","Add"),engine:"CDK"},existing).allowed,true);
});
test("Pulumi normalized plans cannot silently hide governance changes",()=>{
 const p:NativePlan={engine:"PULUMI",payload:{steps:[
  {type:"aws:cloudwatch/logGroup:LogGroup",op:"create"},
  {type:"aws:controltower/landingZone:LandingZone",op:"create"}]}};
 const r=assessNativeAwsPlan(p,existing);
 assert.equal(r.allowed,false);
});
test("unknown native actions or incomplete resource arrays fail closed",()=>{
 assert.equal(assessNativeAwsPlan(terraform("aws_iam_role",["read","create"]),existing).allowed,false);
 assert.equal(assessNativeAwsPlan({engine:"TERRAFORM",payload:{}},existing).allowed,false);
 assert.equal(assessNativeAwsPlan({engine:"PULUMI",payload:{steps:[{type:"aws:s3:Bucket",op:"same"}]}},existing).allowed,false);
});
test("Terraform resource import is classified separately",()=>{
 const r=assessNativeAwsPlan({engine:"TERRAFORM",payload:{resource_changes:[{
  type:"aws_organizations_policy",change:{actions:["create"],importing:{id:"p-012345"}}}]}},existing);
 assert.equal(r.allowed,false);
});
test("a replacement is never flattened to an update (#270 review N1): CloudFormation Modify counts as UPDATE only with an exact Replacement of False, True and Conditional are a delete and a create, a missing or odd value fails closed; Terraform delete,create and Pulumi replace are a delete and a create",()=>{
 const modify=(type:string,replacement?:string)=>({engine:"CLOUDFORMATION",payload:{Changes:[{ResourceChange:{ResourceType:type,Action:"Modify",...(replacement===undefined?{}:{Replacement:replacement})}}]}}) as NativePlan;
 const inPlace=assessNativeAwsPlan(modify("AWS::Logs::LogGroup","False"),existing);
 assert.equal(inPlace.allowed,true);
 assert.deepEqual(inPlace.findings.map(f=>f.action),["UPDATE"]);
 for(const replacement of ["True","Conditional"]) {
  const r=assessNativeAwsPlan(modify("AWS::Logs::LogGroup",replacement),existing);
  assert.deepEqual(r.findings.map(f=>f.action),["DELETE","CREATE"],replacement);
 }
 for(const replacement of [undefined,"false","true","","Maybe"]) {
  const r=assessNativeAwsPlan(modify("AWS::Logs::LogGroup",replacement),existing);
  assert.equal(r.allowed,false,JSON.stringify(replacement));
  assert.deepEqual(r.reasons,["NATIVE_PLAN_INVALID:CLOUDFORMATION_REPLACEMENT_UNSUPPORTED"],JSON.stringify(replacement));
 }
 // A replacement of a governance root is judged as the delete it is, not as an update.
 assert.equal(assessNativeAwsPlan(modify("AWS::Organizations::Organization","True"),existing).allowed,false);
 for(const actions of [["delete","create"],["create","delete"]]) {
  const r=assessNativeAwsPlan(terraform("aws_cloudwatch_log_group",actions),existing);
  assert.deepEqual(r.findings.map(f=>f.action),["DELETE","CREATE"],actions.join(","));
  assert.equal(assessNativeAwsPlan(terraform("aws_organizations_organization",actions),existing).allowed,false,actions.join(","));
 }
 const pulumi=assessNativeAwsPlan({engine:"PULUMI",payload:{steps:[{type:"aws:cloudwatch/logGroup:LogGroup",op:"replace"}]}},existing);
 assert.deepEqual(pulumi.findings.map(f=>f.action),["DELETE","CREATE"]);
 assert.equal(assessNativeAwsPlan({engine:"PULUMI",payload:{steps:[{type:"aws:organizations/organization:Organization",op:"replace"}]}},existing).allowed,false);
});
