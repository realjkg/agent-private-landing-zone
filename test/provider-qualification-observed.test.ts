import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { awsObservedIdentity, azureObservedIdentity } from "../src/qualification/observed-identity.js";

// SYNTHETIC: what the provider qualification document records as the account it actually read (ids only), which the evidence
// runner compares with the expected account after the producer ran (review B1 on #349).

test("AWS: the caller's account from an assumed-role or IAM ARN; anything else is unobserved", () => {
  assert.deepEqual(awsObservedIdentity("arn:aws:sts::111122223333:assumed-role/alz-discovery/session"), { accountId: "111122223333" });
  assert.deepEqual(awsObservedIdentity("arn:aws-us-gov:sts::111122223333:assumed-role/r/s"), { accountId: "111122223333" });
  for (const value of [undefined, "", "arn:aws:s3:::bucket", "not an arn", 111122223333, "arn:aws:sts::12:assumed-role/r/s"]) assert.deepEqual(awsObservedIdentity(value), {}, String(value));
});

test("Azure: the tenant and subscription of az account show, lower-cased; a malformed answer is unobserved", () => {
  const shown = JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", tenantId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", user: { name: "x", type: "servicePrincipal" } });
  assert.deepEqual(azureObservedIdentity(shown), { subscriptionId: "11111111-2222-4333-8444-555555555555", tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  assert.deepEqual(azureObservedIdentity(JSON.stringify({ id: "sub", tenantId: 7 })), {});
  assert.deepEqual(azureObservedIdentity("not json"), {});
  assert.deepEqual(azureObservedIdentity("[]"), {});
  assert.ok(!JSON.stringify(azureObservedIdentity(shown)).includes("servicePrincipal"), "ids only, never the principal's name or type");
});

test("the producer records what it observed: the AWS caller ARN and the Azure account answer feed observedIdentity, which its document carries", () => {
  // src/cli/provider-qualification.ts runs at module top level, so this reads its text (as the selector's UNIMPORTABLE_OWNERS says).
  const source = readFileSync("src/cli/provider-qualification.ts", "utf8");
  assert.match(source, /from "\.\.\/qualification\/observed-identity\.js"/);
  assert.match(source, /observedIdentity\s*=\s*awsObservedIdentity\(callerArn\)/);
  assert.match(source, /observedIdentity\s*=\s*azureObservedIdentity\(\s*accountResult\.stdout,?\s*\)/);
  assert.match(source, /\.\.\.qualification,\s*observedIdentity,/, "the written document carries observedIdentity beside the qualification");
});
