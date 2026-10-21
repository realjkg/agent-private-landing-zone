import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CORE_LZA_CONFIG_FILES, inspectLzaConfiguration, type LzaIntakeFile } from "../src/integrations/aws-lza/config-intake.js";
const make=(path:string,content:string):LzaIntakeFile=>({
 path,content,sha256:createHash("sha256").update(content,"utf8").digest("hex")
});
const core=()=>CORE_LZA_CONFIG_FILES.map(path=>make(path,"description: fixture\n"));
test("full declarative core inventory is reviewable, never deployable or schema-qualified",()=>{
 const result=inspectLzaConfiguration(core(),"ENTERPRISE_LZA");
 assert.equal(result.verdict,"REVIEW_REQUIRED");
 assert.equal(result.completeCoreFileSet,true);
 assert.equal(result.issues.length,0);
 assert.equal(result.schemaValidation,"NOT_RUN");
 assert.equal(result.cloudEvidence,"NOT_RUN");
 assert.equal(result.deploymentAuthorized,false);
 assert.equal(result.actEnabled,false);
 assert.equal(result.bundleSha256?.length,64);
});
test("personal AWS partial intake is allowed for design review but cannot claim full LZA",()=>{
 const result=inspectLzaConfiguration([make("global-config.yaml","homeRegion: us-east-1\n")],"PERSONAL_SANDBOX");
 assert.equal(result.verdict,"REVIEW_REQUIRED");
 assert.equal(result.completeCoreFileSet,false);
 assert.equal(result.missingCoreFiles.length,5);
 assert.equal(result.deploymentAuthorized,false);
 assert.equal(inspectLzaConfiguration([make("global-config.yaml","homeRegion: us-east-1\n")],"ENTERPRISE_LZA").verdict,"REJECTED");
});
test("changed bytes, duplicates, path escapes and invalid modes fail closed",()=>{
 const b=core();
 b[0]={...b[0],content:"modified"};
 assert.ok(inspectLzaConfiguration(b,"ENTERPRISE_LZA").issues.some(x=>x.startsWith("CONTENT_HASH_MISMATCH")));
 assert.ok(inspectLzaConfiguration([b[1],b[1]],"PERSONAL_SANDBOX").issues.some(x=>x.startsWith("DUPLICATE_PATH")));
 assert.ok(inspectLzaConfiguration([make("../secrets.yaml","bad")],"PERSONAL_SANDBOX").issues.includes("PATH_INVALID"));
 assert.ok(inspectLzaConfiguration(core(),"BAD" as "ENTERPRISE_LZA").issues.includes("MODE_INVALID"));
});
test("explicit include graph resolves relative includes and detects cycles",()=>{
 const input=[...core(),make("include/network/vpc.yaml","vpcs: []\n")];
 input[3]=make("network-config.yaml","vpcs: !include include/network/vpc.yaml\n");
 const r=inspectLzaConfiguration(input,"ENTERPRISE_LZA");
 assert.equal(r.verdict,"REVIEW_REQUIRED");
 assert.equal(r.resolvedIncludes,1);
 const missing=[...core()];
 missing[3]=make("network-config.yaml","vpcs: !include absent.yaml\n");
 assert.ok(inspectLzaConfiguration(missing,"ENTERPRISE_LZA").issues.some(x=>x.startsWith("INCLUDE_UNRESOLVED")));
 const cycle=[...core(),make("include/a.yaml","foo: !include b.yaml\n"),make("include/b.yaml","bar: !include a.yaml\n")];
 cycle[3]=make("network-config.yaml","foo: !include include/a.yaml\n");
 assert.ok(inspectLzaConfiguration(cycle,"ENTERPRISE_LZA").issues.some(x=>x.startsWith("INCLUDE_CYCLE")));
});
test("stable bundle digest follows file byte changes but not input ordering",()=>{
 const a=core();
 const x=inspectLzaConfiguration(a,"ENTERPRISE_LZA");
 const y=inspectLzaConfiguration([...a].reverse(),"ENTERPRISE_LZA");
 assert.equal(x.bundleSha256,y.bundleSha256);
 const z=[...a];z[0]=make(z[0].path,"different\n");
 assert.notEqual(x.bundleSha256,inspectLzaConfiguration(z,"ENTERPRISE_LZA").bundleSha256);
});
