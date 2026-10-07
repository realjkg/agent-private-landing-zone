import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyProductionIdentity,
} from "../src/qualification/identity.js";

test("AWS assumed-role identity qualifies without model-visible secrets", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/sovereign-lz/session",
      environment: {},
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    true,
  );
  assert.equal(
    result.mode,
    "ASSUME_ROLE",
  );
  assert.deepEqual(
    result.blockers,
    [],
  );
});

test("AWS web identity qualifies as workload identity", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/sovereign-lz/session",
      environment: {
        AWS_WEB_IDENTITY_TOKEN_FILE:
          "/var/run/secrets/token",
        AWS_ROLE_ARN:
          "arn:aws:iam::123456789012:role/sovereign-lz",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    true,
  );
  assert.equal(
    result.mode,
    "WORKLOAD_IDENTITY",
  );
});

test("AWS IAM user and static access-key patterns are blocked", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:iam::123456789012:user/operator",
      environment: {
        AWS_ACCESS_KEY_ID:
          "present",
        AWS_SECRET_ACCESS_KEY:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    false,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /static access-key/i,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /IAM user/i,
  );
});

test("Azure managed identity qualifies", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType:
        "servicePrincipal",
      environment: {
        IDENTITY_ENDPOINT:
          "http://localhost/identity",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    true,
  );
  assert.equal(
    result.mode,
    "MANAGED_IDENTITY",
  );
});

test("Azure federated identity qualifies", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType:
        "servicePrincipal",
      environment: {
        AZURE_FEDERATED_TOKEN_FILE:
          "/var/run/secrets/azure-token",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    true,
  );
  assert.equal(
    result.mode,
    "FEDERATED_IDENTITY",
  );
});

test("Azure client-secret and interactive-user patterns are blocked", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType:
        "user",
      environment: {
        AZURE_CLIENT_SECRET:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  assert.equal(
    result.ready,
    false,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /client-secret/i,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /interactive user/i,
  );
});

test("secret handling fails closed when references are not opaque or secret material reaches model context", () => {
  const result =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/sovereign-lz/session",
      environment: {},
      opaqueSecretReferencesOnly:
        false,
      modelVisibleSecretMaterial:
        true,
    });

  assert.equal(
    result.ready,
    false,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /opaque references/i,
  );
  assert.match(
    result.blockers.join(
      " ",
    ),
    /model context/i,
  );
});
