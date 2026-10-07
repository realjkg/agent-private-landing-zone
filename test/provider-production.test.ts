import assert from "node:assert/strict";
import test from "node:test";

import type {
  EnvironmentState,
  Provider,
} from "../src/discovery/types.js";
import {
  qualifyProductionIdentity,
} from "../src/qualification/identity.js";
import {
  qualifyProviderProduction,
} from "../src/qualification/provider-production.js";
import type {
  ToolResult,
} from "../src/tools/types.js";

function environment(
  provider: Provider,
  source:
    "aws-cli"
    | "azure-cli"
    | "mock",
): EnvironmentState {
  const aws =
    provider === "AWS";

  return {
    provider,
    classification:
      "BROWNFIELD",
    controlPlane:
      "EXISTING",
    resources: [
      {
        resourceId:
          aws
            ? "aws:account:redacted"
            : "/subscriptions/redacted",
        provider,
        resourceType:
          aws
            ? "AWS::Organizations::Account"
            : "Microsoft.Resources/subscriptions",
        name: "redacted",
        ownership:
          "MANAGED_BY_CUSTOMER",
        mutationPolicy:
          "READ_ONLY",
        sourceOfTruth:
          "MANUAL",
        metadata:
          source === "mock"
            ? {
                mock: true,
              }
            : {},
      },
    ],
    ownershipSummary: {
      readOnly: 1,
      additiveOnly: 0,
      updateAllowed: 0,
      unknown: 0,
    },
    conflicts: [],
    safeBuildMode:
      "ADDITIVE_ONLY",
    discoveredAt:
      "2026-10-07T00:00:00.000Z",
    evidence: [
      {
        key:
          aws
            ? "aws.identity"
            : "azure.identity",
        value:
          "authenticated",
        source,
      },
    ],
    scannerObservations: [],
    sbomComponents: [],
    sbomComplete: false,
    resiliencyObservations: [],
    warnings: [],
  };
}

function result(
  tool:
    ToolResult["tool"],
  command: string[],
): ToolResult {
  return {
    tool,
    ok: true,
    exitCode: 0,
    stdout:
      "{\"status\":\"preview\"}",
    stderr: "",
    durationMs: 10,
    command,
  };
}

test("AWS live assumed-role discovery and disposable change-set preview qualifies", () => {
  const identity =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/alz-qualification/run",
      environment: {
        AWS_ACCESS_KEY_ID:
          "present",
        AWS_SECRET_ACCESS_KEY:
          "present",
        AWS_SESSION_TOKEN:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const qualified =
    qualifyProviderProduction({
      sourceCommit:
        "a".repeat(40),
      provider: "AWS",
      identity,
      environment:
        environment(
          "AWS",
          "aws-cli",
        ),
      validationResults: [
        result(
          "cloudformation_validate",
          [
            "aws",
            "cloudformation",
            "validate-template",
          ],
        ),
      ],
      preview:
        result(
          "cloudformation_preview",
          [
            "aws",
            "cloudformation",
            "preview-update-change-set",
          ],
        ),
      actEnabled: false,
    });

  assert.equal(
    qualified.ready,
    true,
  );
  assert.equal(
    qualified.preview
      .commandClass,
    "AWS_CHANGE_SET_PREVIEW",
  );
  assert.deepEqual(
    qualified.blockers,
    [],
  );
});

test("Azure live federated discovery and ResourceIdOnly what-if qualifies", () => {
  const identity =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType:
        "servicePrincipal",
      environment: {
        AZURE_FEDERATED_TOKEN_FILE:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const qualified =
    qualifyProviderProduction({
      sourceCommit:
        "b".repeat(40),
      provider: "AZURE",
      identity,
      environment:
        environment(
          "AZURE",
          "azure-cli",
        ),
      validationResults: [
        result(
          "bicep_lint",
          [
            "bicep",
            "lint",
          ],
        ),
        result(
          "bicep_build",
          [
            "bicep",
            "build",
          ],
        ),
      ],
      preview:
        result(
          "bicep_what_if",
          [
            "az",
            "deployment",
            "sub",
            "what-if",
          ],
        ),
      actEnabled: false,
    });

  assert.equal(
    qualified.ready,
    true,
  );
  assert.equal(
    qualified.preview
      .commandClass,
    "AZURE_WHAT_IF",
  );
});

test("fixture evidence can never satisfy real provider qualification", () => {
  const identity =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/alz-qualification/run",
      environment: {
        AWS_SESSION_TOKEN:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const qualified =
    qualifyProviderProduction({
      sourceCommit:
        "c".repeat(40),
      provider: "AWS",
      identity,
      environment:
        environment(
          "AWS",
          "mock",
        ),
      validationResults: [
        result(
          "cloudformation_validate",
          ["aws"],
        ),
      ],
      preview:
        result(
          "cloudformation_preview",
          [
            "aws",
            "cloudformation",
            "preview-update-change-set",
          ],
        ),
      actEnabled: false,
    });

  assert.equal(
    qualified.ready,
    false,
  );
  assert.match(
    qualified.blockers.join(
      " ",
    ),
    /mock or fixture/i,
  );
});

test("provider qualification rejects mutation commands even when preview reports success", () => {
  const identity =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        "arn:aws:sts::123456789012:assumed-role/alz-qualification/run",
      environment: {
        AWS_SESSION_TOKEN:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const qualified =
    qualifyProviderProduction({
      sourceCommit:
        "d".repeat(40),
      provider: "AWS",
      identity,
      environment:
        environment(
          "AWS",
          "aws-cli",
        ),
      validationResults: [
        result(
          "cloudformation_validate",
          ["aws"],
        ),
      ],
      preview:
        result(
          "cloudformation_preview",
          [
            "aws",
            "cloudformation",
            "execute-change-set",
          ],
        ),
      actEnabled: false,
    });

  assert.equal(
    qualified.ready,
    false,
  );
  assert.match(
    qualified.blockers.join(
      " ",
    ),
    /non-mutating/i,
  );
});

test("qualification evidence is redacted to hashes and summaries rather than provider identifiers", () => {
  const identity =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType:
        "servicePrincipal",
      environment: {
        AZURE_FEDERATED_TOKEN_FILE:
          "present",
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });
  const env =
    environment(
      "AZURE",
      "azure-cli",
    );
  env.resources[0].resourceId =
    "/subscriptions/secret-subscription-id";
  env.resources[0].name =
    "secret-subscription-id";

  const qualified =
    qualifyProviderProduction({
      sourceCommit:
        "e".repeat(40),
      provider: "AZURE",
      identity,
      environment: env,
      validationResults: [
        result(
          "bicep_lint",
          ["bicep"],
        ),
      ],
      preview:
        result(
          "bicep_what_if",
          [
            "az",
            "deployment",
            "sub",
            "what-if",
          ],
        ),
      actEnabled: false,
    });

  assert.doesNotMatch(
    JSON.stringify(
      qualified,
    ),
    /secret-subscription-id/,
  );
});
