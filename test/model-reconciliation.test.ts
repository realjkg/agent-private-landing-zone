import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileIndependentRisks, type EngineeringAssessment,
} from "../src/loop.js";

const base: EngineeringAssessment = {
  topRisk: "Unverified restore capability",
  whyItMatters: "Recovery has not been proven",
  recommendedActions: ["Verify restores in DEV"],
  confidence: "MEDIUM",
  assumptions: ["No live restore evidence"],
};
const other: EngineeringAssessment = {
  topRisk: "Insecure execution role",
  whyItMatters: "Role boundaries may not be least privilege",
  recommendedActions: ["Audit the execution role"],
  confidence: "MEDIUM",
  assumptions: ["No live role evidence"],
};

test("complementary independent risks are retained, not suppressed", () => {
  const result = reconcileIndependentRisks({
    relationship: "COMPLEMENTARY",
    primaryAddressable: true,
    validatorAddressable: true,
    reason: "Restore verification and least-privilege reviews are independent controls; both remain open.",
  }, base, other);
  assert.equal(result.accepted, true);
  assert.equal(result.evidence.relationship, "COMPLEMENTARY");
  assert.equal(result.evidence.primaryRisk, base.topRisk);
  assert.equal(result.evidence.validatorRisk, other.topRisk);
  assert.match(result.evidence.reason, /both remain open/);
});

test("different names are never sufficient to manufacture agreement", () => {
  for (const relationship of ["CONFLICTING", "UNCERTAIN"] as const) {
    const result = reconcileIndependentRisks({
      relationship,
      primaryAddressable: true,
      validatorAddressable: true,
      reason: "Independent reviewer cannot establish compatible actions.",
    }, base, other);
    assert.equal(result.accepted, false);
    assert.equal(result.evidence.primaryRisk, base.topRisk);
    assert.equal(result.evidence.validatorRisk, other.topRisk);
  }
});

test("complementary claim without both risks addressable must abstain", () => {
  for (const primaryAddressable of [true, false]) {
    for (const validatorAddressable of [true, false]) {
      const result = reconcileIndependentRisks({
        relationship: "COMPLEMENTARY",
        primaryAddressable,
        validatorAddressable,
        reason: "Retain both risk findings.",
      }, base, other);
      assert.equal(result.accepted, primaryAddressable && validatorAddressable);
    }
  }
});

test("malformed and obsolete binary adjudication never silently pass", () => {
  const invalid = [
    null, [], "agree", { agree: true, reason: "compatible" },
    { relationship: "COMPLEMENTARY", primaryAddressable: true,
      validatorAddressable: "true", reason: "both" },
    { relationship: "COMPATIBLE", primaryAddressable: true,
      validatorAddressable: true, reason: "both" },
    { relationship: "COMPLEMENTARY", primaryAddressable: true,
      validatorAddressable: true, reason: "" },
    { relationship: "ALIGNED", primaryAddressable: true,
      validatorAddressable: true, reason: "both", bypassPolicy: true },
  ];
  for (const value of invalid) {
    assert.throws(() => reconcileIndependentRisks(value, base, other),
      /INVALID_ADJUDICATION_OUTPUT/);
  }
});

test("aligned risks still require explicit coverage of both", () => {
  const result = reconcileIndependentRisks({
    relationship: "ALIGNED",
    primaryAddressable: true,
    validatorAddressable: false,
    reason: "Cannot address the validator finding without violating policy.",
  }, base, other);
  assert.equal(result.accepted, false);
});
