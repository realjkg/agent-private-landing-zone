import assert from "node:assert/strict";
import test from "node:test";
import { bindEnvironment, bindingFingerprint, assertSameEnvironment, requirePromotionReview } from "../src/security/environment-binding.js";

const base = {
  environmentId: "dev-001", stage: "DEVELOPMENT", tenantId: "tenant-001",
  provider: "aws", targetId: "account-123", region: "us-east-1",
  residency: "us-east-1", identityRef: "host-session-001", capability: "PREVIEW",
} as const;

test("exact scoped environment is immutable and deterministic", () => {
  const a = bindEnvironment(base);
  const b = bindEnvironment({...base});
  assert.ok(Object.isFrozen(a));
  assert.equal(bindingFingerprint(a), bindingFingerprint(b));
  assert.doesNotThrow(() => assertSameEnvironment(a,b));
});

test("reject omissions, unknown fields, invalid stages, credential-bearing inputs", () => {
  for (const change of [
    {stage: undefined}, {stage: "prod"}, {provider: "azurex"},
    {environmentId: "../escape"}, {tenantId: ""}, {capability: "ACT"},
    {identityRef: ""}, {region: "../../private"}, {targetId: null},
  ]) {
    assert.throws(() => bindEnvironment({...base,...change}),/ENVIRONMENT_BINDING_INVALID/);
  }
  assert.throws(() => bindEnvironment({...base,accessToken:"secret"}),/ENVIRONMENT_BINDING_INVALID/);
  assert.throws(() => bindEnvironment(null),/ENVIRONMENT_BINDING_INVALID/);
});

test("cannot carry dev identity or evidence into staging, production or another tenant/provider", () => {
  const expected = bindEnvironment(base);
  for (const change of [
    {stage:"STAGING"}, {stage:"PRODUCTION"}, {tenantId:"tenant-002"},
    {provider:"gcp"}, {targetId:"account-456"}, {region:"eu-west-1"},
    {identityRef:"host-session-002"}, {capability:"OPERATE"}, {environmentId:"prod-001"},
  ]) {
    const actual = bindEnvironment({...base,...change});
    assert.throws(() => assertSameEnvironment(expected,actual),/ENVIRONMENT_SCOPE_MISMATCH/);
  }
});

test("promotion always requires independent approval; never creates ACT", () => {
  const source = bindEnvironment(base);
  const destination = bindEnvironment({...base,stage:"PRODUCTION",environmentId:"prod-001"});
  assert.throws(() => requirePromotionReview(source,destination),/PROMOTION_REQUIRES_INDEPENDENT_APPROVAL/);
  assert.equal("actEnabled" in source,false);
});
