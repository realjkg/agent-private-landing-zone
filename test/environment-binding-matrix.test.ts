import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameEnvironment,
  bindEnvironment,
  bindingFingerprint,
  requirePromotionReview,
  type EnvironmentBinding,
  type SovereignProvider,
  type Stage,
} from "../src/security/environment-binding.js";

const stages: readonly Stage[] = ["DEVELOPMENT", "STAGING", "PRODUCTION"];
const providers: readonly SovereignProvider[] = ["aws", "azure", "gcp", "private"];

function scope(stage: Stage, provider: SovereignProvider = "aws"): EnvironmentBinding {
  const name = stage.toLowerCase();
  return bindEnvironment({
    environmentId: "alz-" + name,
    stage,
    tenantId: "tenant-lab",
    provider,
    targetId: "target-" + name,
    region: "us-east-2",
    residency: "us-east-2",
    identityRef: "host-" + name,
    capability: "PREVIEW",
  });
}

test("all provider and DEV/STAGING/PROD combinations remain explicit and independently fingerprinted", () => {
  const seen = new Set<string>();
  for (const provider of providers) {
    for (const stage of stages) {
      const bound = scope(stage, provider);
      assert.equal(bound.provider, provider);
      assert.equal(bound.stage, stage);
      assert.ok(Object.isFrozen(bound));
      const fingerprint = bindingFingerprint(bound);
      assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.equal(seen.has(fingerprint), false, "scope identity was reused across environments");
      seen.add(fingerprint);
    }
  }
  assert.equal(seen.size, providers.length * stages.length);
});

test("every cross-stage combination fails closed, including PROD back to DEV", () => {
  for (const source of stages) {
    for (const target of stages) {
      const left = scope(source);
      const right = scope(target);
      if (source === target) {
        assert.doesNotThrow(() => assertSameEnvironment(left, right));
      } else {
        assert.throws(() => assertSameEnvironment(left, right), /ENVIRONMENT_SCOPE_MISMATCH/);
        assert.throws(() => requirePromotionReview(left, right), /PROMOTION_REQUIRES_INDEPENDENT_APPROVAL/);
      }
    }
  }
});

test("PROD rejects dev role reuse even when stage, account and tenancy labels are held constant", () => {
  const prod = scope("PRODUCTION");
  for (const change of [
    {identityRef: "host-development"},
    {targetId: "target-development"},
    {tenantId: "tenant-other"},
    {region: "eu-west-1"},
    {capability: "OPERATE"},
    {environmentId: "alz-development"},
  ]) {
    assert.throws(
      () => assertSameEnvironment(prod, bindEnvironment({...prod, ...change})),
      /ENVIRONMENT_SCOPE_MISMATCH/,
    );
  }
  assert.throws(() => bindEnvironment({...prod, stage: "prod"}), /ENVIRONMENT_BINDING_INVALID/);
  assert.throws(() => bindEnvironment({...prod, capability: "ACT"}), /ENVIRONMENT_BINDING_INVALID/);
  assert.equal("actEnabled" in prod, false);
});

test("DEV/STAGING/PROD bindings cannot infer authority from a role label or synthetic evidence", () => {
  for (const stage of stages) {
    const b = scope(stage);
    assert.throws(() => bindEnvironment({...b, authorization:"APPROVED"}), /ENVIRONMENT_BINDING_INVALID/);
    assert.throws(() => bindEnvironment({...b, accessKeyId:"NOT_A_REAL_SECRET"}), /ENVIRONMENT_BINDING_INVALID/);
    assert.throws(() => bindEnvironment({...b, approvalDigest:"sha256:fake"}), /ENVIRONMENT_BINDING_INVALID/);
  }
});
