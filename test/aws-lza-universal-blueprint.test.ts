import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectLzaConfiguration, CORE_LZA_CONFIG_FILES, type LzaIntakeFile } from "../src/integrations/aws-lza/config-intake.js";
import { mapLzaUniversalConfiguration, type LzaMappingInput } from "../src/integrations/aws-lza/universal-blueprint.js";
const digest=(x:string)=>createHash("sha256").update(x).digest("hex");
const files: LzaIntakeFile[]=CORE_LZA_CONFIG_FILES.map(path=>({path,content:"fixture: true\n",sha256:digest("fixture: true\n")}));
function input():LzaMappingInput {
 const intake=inspectLzaConfiguration(files,"ENTERPRISE_LZA");
 return {
  files,mode:"ENTERPRISE_LZA",blueprintId:"uc-review-01",
  validation:{source:"OFFICIAL_LZA_VERSION_MATCHED_VALIDATOR",lzaVersion:"v1.16.3",
   universalConfigRevision:"a".repeat(40),bundleSha256:intake.bundleSha256!,
   validationArtifactSha256:digest("verified official report"),result:"PASS",independentlyVerified:true},
  sections:{
   global:{homeRegion:"us-east-1",enabledRegions:["us-east-1"],controlTower:{enable:false}},
   accounts:{managementAccountId:"123456789012",mandatoryAccounts:[],workloadAccounts:[]},
   organization:{organizationalUnits:[]},network:{vpcs:[]}
  },
  target:{accountId:"123456789012",region:"us-east-1",organization:"EXISTS",
   controlTower:"EXISTS",identity:"OBSERVED",discoveryArtifactSha256:digest("actual target"),
   existingAccounts:["123456789012"],existingVpcNames:["existing"]}
 };
}
test("source-bound validated UC fields map to incomplete, review-only AWS blueprint",()=>{
 const r=mapLzaUniversalConfiguration(input());
 assert.equal(r.disposition,"REVIEW_REQUIRED");
 assert.equal(r.officialSchema,"VERIFIED_VERSION_MATCHED");
 assert.equal(r.blueprintComplete,false);
 assert.equal(r.mayApply,false);
 assert.equal(r.actEnabled,false);
 assert.equal(r.mapped.blueprintDraft.scope,"APPLICATION_LANDING_ZONE");
 assert.equal(r.mapped.organizationReuse,true);
});
test("stale LZA validator artifact and mismatched input hash cannot be accepted",()=>{
 const a=input();a.validation.bundleSha256="0".repeat(64);
 assert.ok(mapLzaUniversalConfiguration(a).issues.includes("OFFICIAL_LZA_VALIDATION_UNVERIFIED"));
 const b=input();b.validation.independentlyVerified=false;
 assert.ok(mapLzaUniversalConfiguration(b).issues.includes("OFFICIAL_LZA_VALIDATION_UNVERIFIED"));
});
test("enterprise account vending, Control Tower bootstrap and OU changes require separate authority",()=>{
 const a=input();a.sections.global!.controlTower={enable:true};
 assert.ok(mapLzaUniversalConfiguration(a).issues.includes("PARALLEL_CONTROL_TOWER_FORBIDDEN"));
 const b=input();b.sections.accounts!.workloadAccounts=[{name:"NewWorkload"}];
 assert.ok(mapLzaUniversalConfiguration(b).issues.includes("ACCOUNT_VENDING_REQUIRES_SEPARATE_PLAN"));
 const c=input();c.sections.organization!.organizationalUnits=[{name:"NewOU"}];
 assert.ok(mapLzaUniversalConfiguration(c).issues.includes("ORGANIZATION_MUTATIONS_REQUIRE_SEPARATE_PLAN"));
});
test("personal-account partial configuration stays review-only and not multi-account ready",()=>{
 const a=input();a.files=[files[1]];a.mode="PERSONAL_SANDBOX";
 a.validation.bundleSha256=inspectLzaConfiguration(a.files,a.mode).bundleSha256!;
 const r=mapLzaUniversalConfiguration(a);
 assert.equal(r.disposition,"REVIEW_REQUIRED");
 assert.equal(r.blueprintComplete,false);
});
test("untrusted target, conflicting VPC names, region mismatch and bad sections fail closed",()=>{
 const a=input();a.target.identity="UNVERIFIED";
 assert.ok(mapLzaUniversalConfiguration(a).issues.includes("TARGET_IDENTITY_UNVERIFIED"));
 const b=input();b.sections.network!.vpcs=[{name:"existing"}];
 assert.ok(mapLzaUniversalConfiguration(b).issues.includes("EXISTING_VPC_NAME_COLLISION"));
 const c=input();c.target.region="us-west-2";
 assert.ok(mapLzaUniversalConfiguration(c).issues.includes("TARGET_REGION_MISMATCH"));
 const d=input();d.sections.accounts!.mandatoryAccounts="unexpected";
 assert.ok(mapLzaUniversalConfiguration(d).issues.includes("MANDATORY_ACCOUNTS_SHAPE_INVALID"));
});
