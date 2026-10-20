import assert from "node:assert/strict";
import test from "node:test";
import { assessStudioPrerequisites, inspectContainerAbi, type StudioPrerequisites } from "../src/integrations/ai-studio/platform-qualification.js";

const valid: StudioPrerequisites = {
  platform:"linux", arch:"arm64", modelEndpoint:"http://127.0.0.1:11434",
  modelLocalOnly:true, mcpIngress:"PRIVATE_AUTHENTICATED",
  sso:"OIDC_VERIFIED_BY_TRUSTED_GATEWAY", audienceRestricted:true, subagentScopesRestricted:true
};
test("Linux ARM64 and AMD64 report the same Studio integration prerequisites", () => {
  for (const arch of ["arm64","x64"]) {
    const result=assessStudioPrerequisites({...valid,arch});
    assert.equal(result.eligibleForLiveQualification,true);
    assert.equal(result.evidence,"LOCAL_CONFIGURATION_ONLY");
    assert.equal(result.supportedPlatform,arch==="arm64"?"linux/arm64":"linux/amd64");
  }
});
test("macOS local host is not mistaken for a Linux container", () => {
  const result=assessStudioPrerequisites({...valid,platform:"darwin"});
  assert.equal(result.eligibleForLiveQualification,false);
  assert.ok(result.missing.includes("LINUX_ARCH_NOT_SUPPORTED"));
});
test("hosted inference and public ingress fail sovereignty qualification",()=>{
  const result=assessStudioPrerequisites({...valid,modelEndpoint:"https://example.com/inference",mcpIngress:"PUBLIC"});
  assert.equal(result.eligibleForLiveQualification,false);
  assert.ok(result.missing.includes("LOCAL_MODEL_ENDPOINT_REQUIRED"));
  assert.ok(result.missing.includes("PRIVATE_AUTHENTICATED_MCP_INGRESS_REQUIRED"));
});
test("SSO is never accepted without trusted gateway verification, audience and scopes",()=>{
  const result=assessStudioPrerequisites({...valid,sso:"UNVERIFIED",audienceRestricted:false,subagentScopesRestricted:false});
  assert.equal(result.eligibleForLiveQualification,false);
  assert.deepEqual(result.missing.filter(x=>x.includes("SSO")||x.includes("AUDIENCE")||x.includes("SCOPE")),[
    "TRUSTED_SSO_VERIFIER_REQUIRED","TOKEN_AUDIENCE_RESTRICTION_REQUIRED","SUBAGENT_SCOPE_RESTRICTION_REQUIRED"
  ]);
});
test("container architecture introspection returns physical Node runtime attributes",()=>{
  const info=inspectContainerAbi();
  assert.equal(info.platform,process.platform);
  assert.equal(info.arch,process.arch);
  assert.equal(info.node,process.versions.node);
});
