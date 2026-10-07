import assert from "node:assert/strict";
import test from "node:test";

import {
  issueCapabilityLease,
} from "../src/orchestration/plan.js";
import {
  getAgentForRole,
} from "../src/orchestration/registry.js";
import {
  BuiltinSecurityPolicyEvaluator,
  capabilitiesForCompromiseState,
  evaluateBuiltinSecurityPolicy,
} from "../src/security/policy/builtin.js";
import {
  baselineHandlingPolicy,
  exposeSecretReference,
} from "../src/security/policy/data.js";
import {
  createSecurityPolicyEvaluator,
} from "../src/security/policy/engine.js";
import {
  createEvidenceLineageEntry,
  verifyEvidenceLineage,
} from "../src/security/policy/lineage.js";
import {
  minimizeSensitiveData,
} from "../src/security/policy/minimize.js";
import {
  OpaSecurityPolicyEvaluator,
} from "../src/security/policy/opa.js";
import {
  executeGovernedTool,
} from "../src/tools/governed.js";

test("restricted data is denied external model and external storage by baseline policy", async () => {
  const evaluator =
    new BuiltinSecurityPolicyEvaluator();
  const handling =
    baselineHandlingPolicy(
      "RESTRICTED",
    );

  const model =
    await evaluator.evaluate({
      kind: "DATA_HANDLING",
      handling,
      destination:
        "EXTERNAL_MODEL",
      containsSecretMaterial:
        false,
    });

  const storage =
    await evaluator.evaluate({
      kind: "DATA_HANDLING",
      handling,
      destination:
        "EXTERNAL_STORAGE",
      containsSecretMaterial:
        false,
    });

  assert.equal(model.allow, false);
  assert.equal(
    storage.allow,
    false,
  );
});

test("secret material is denied even when other data handling would be allowed", () => {
  const decision =
    evaluateBuiltinSecurityPolicy({
      kind: "DATA_HANDLING",
      handling:
        baselineHandlingPolicy(
          "PUBLIC",
        ),
      destination:
        "LOCAL_MODEL",
      containsSecretMaterial:
        true,
    });

  assert.equal(
    decision.allow,
    false,
  );
  assert.match(
    decision.obligations.join(
      " ",
    ),
    /opaque secret reference/i,
  );
});

test("egress is default deny and restricted data cannot use external allowlisted egress", () => {
  const unknown =
    evaluateBuiltinSecurityPolicy({
      kind: "EGRESS",
      classification:
        "INTERNAL",
      destination: {
        scheme: "https",
        host: "unknown.example",
        purpose: "test",
      },
      allowedHosts: [
        "aws-control-plane",
      ],
    });

  const restricted =
    evaluateBuiltinSecurityPolicy({
      kind: "EGRESS",
      classification:
        "RESTRICTED",
      destination: {
        scheme: "https",
        host: "aws-control-plane",
        purpose: "test",
      },
      allowedHosts: [
        "aws-control-plane",
      ],
    });

  const loopback =
    evaluateBuiltinSecurityPolicy({
      kind: "EGRESS",
      classification:
        "RESTRICTED",
      destination: {
        scheme: "http",
        host: "127.0.0.1",
        port: 8181,
        purpose: "OPA",
      },
      allowedHosts: [],
    });

  assert.equal(unknown.allow, false);
  assert.equal(
    restricted.allow,
    false,
  );
  assert.equal(loopback.allow, true);
});

test("sensitive keys are deterministically minimized before model or output use", () => {
  const minimized =
    minimizeSensitiveData({
      account: "example",
      credentials: {
        access_key:
          "AKIA-DO-NOT-EXPOSE",
        clientSecret:
          "secret-value",
      },
      nested: [
        {
          token:
            "private-token",
        },
      ],
    });

  assert.deepEqual(
    minimized.redactedPaths,
    [
      "credentials.access_key",
      "credentials.clientSecret",
      "nested[0].token",
    ],
  );

  assert.deepEqual(
    minimized.value,
    {
      account: "example",
      credentials: {
        access_key:
          "[REDACTED]",
        clientSecret:
          "[REDACTED]",
      },
      nested: [
        {
          token: "[REDACTED]",
        },
      ],
    },
  );
});

test("secret reference exposure preserves metadata but has no secret value field", () => {
  const exposed =
    exposeSecretReference({
      ref:
        "vault://platform/aws/deploy",
      kind: "CREDENTIAL",
      owner:
        "platform-operations",
      scope: "aws-prod",
      metadata: {
        rotatedAt:
          "2026-10-01",
        ageDays: 6,
      },
    });

  assert.equal(
    exposed.ref,
    "vault://platform/aws/deploy",
  );
  assert.equal(
    "value" in
      (exposed as unknown as Record<
        string,
        unknown
      >),
    false,
  );
});

test("evidence lineage detects content or chain tampering", () => {
  const first =
    createEvidenceLineageEntry({
      artifactType:
        "DesignSpec",
      artifactHash:
        "a".repeat(64),
      policyDecisionHash:
        "b".repeat(64),
      createdAt:
        "2026-10-07T00:00:00.000Z",
    });

  const second =
    createEvidenceLineageEntry({
      artifactType:
        "ChangeSet",
      artifactHash:
        "c".repeat(64),
      policyDecisionHash:
        "d".repeat(64),
      previousHash:
        first.entryHash,
      createdAt:
        "2026-10-07T00:01:00.000Z",
    });

  assert.equal(
    verifyEvidenceLineage([
      first,
      second,
    ]).valid,
    true,
  );

  const tampered = {
    ...second,
    artifactHash:
      "e".repeat(64),
  };

  assert.deepEqual(
    verifyEvidenceLineage([
      first,
      tampered,
    ]),
    {
      valid: false,
      brokenAt: 1,
    },
  );
});

test("compromise state removes risky capabilities and capability leases enforce it", () => {
  assert.deepEqual(
    capabilitiesForCompromiseState(
      "CONTAINED",
    ),
    [
      "EVIDENCE_READ",
      "VALIDATE",
    ],
  );

  const build =
    getAgentForRole("BUILD");

  assert.throws(
    () =>
      issueCapabilityLease({
        agent: build,
        taskId:
          "compromised-task",
        scope:
          "build:terraform",
        requested: [
          "BUILD_PREVIEW",
        ],
        grantor:
          "DETERMINISTIC_POLICY",
        compromiseState:
          "SUSPECTED",
      }),
    /compromise state denies/i,
  );
});

test("governed tool preflight blocks cloud reads in suspected state before executing a provider CLI", async () => {
  const result =
    await executeGovernedTool(
      {
        tool:
          "aws_sts_identity",
        provider: "AWS",
      },
      {
        cwd: process.cwd(),
        allowCloudRead: true,
        allowMutation: false,
      },
      {
        evaluator:
          new BuiltinSecurityPolicyEvaluator(),
        compromiseState:
          "SUSPECTED",
        classification:
          "INTERNAL",
        allowedEgressHosts: [
          "aws-control-plane",
        ],
      },
    );

  assert.equal(
    Array.isArray(result),
    false,
  );

  if (!Array.isArray(result)) {
    assert.equal(
      result.blocked,
      true,
    );
    assert.match(
      result.reason ?? "",
      /compromise state/i,
    );
  }
});

test("OPA evaluator accepts only loopback endpoints and parses named decisions", async () => {
  assert.throws(
    () =>
      new OpaSecurityPolicyEvaluator({
        baseUrl:
          "https://policy.example.com",
      }),
    /must be local/i,
  );

  const evaluator =
    new OpaSecurityPolicyEvaluator({
      baseUrl:
        "http://127.0.0.1:8181",
      fetchImpl:
        async (
          input,
          init,
        ) => {
          assert.match(
            String(input),
            /\/v1\/data\/agent_landing_zone\/security\/decision$/,
          );
          assert.equal(
            init?.method,
            "POST",
          );

          return new Response(
            JSON.stringify({
              decision_id:
                "decision-123",
              result: {
                allow: true,
                reasons: [],
                obligations: [
                  "preserve-evidence",
                ],
              },
            }),
            {
              status: 200,
              headers: {
                "content-type":
                  "application/json",
              },
            },
          );
        },
    });

  const decision =
    await evaluator.evaluate({
      kind: "AUTOMATION",
      compromiseState:
        "NORMAL",
      operation:
        "RECOVERY_VERIFY",
    });

  assert.equal(
    decision.allow,
    true,
  );
  assert.equal(
    decision.source,
    "OPA",
  );
  assert.equal(
    decision.decisionId,
    "decision-123",
  );
});

test("OPA evaluator fails closed on unavailable or undefined decisions", async () => {
  const unavailable =
    new OpaSecurityPolicyEvaluator({
      fetchImpl:
        async () => {
          throw new Error(
            "unavailable",
          );
        },
    });

  const denied =
    await unavailable.evaluate({
      kind: "AUTOMATION",
      compromiseState:
        "NORMAL",
      operation:
        "RECOVERY_VERIFY",
    });

  assert.equal(denied.allow, false);

  const undefinedDecision =
    new OpaSecurityPolicyEvaluator({
      fetchImpl:
        async () =>
          new Response(
            JSON.stringify({}),
            { status: 200 },
          ),
    });

  const missing =
    await undefinedDecision.evaluate({
      kind: "AUTOMATION",
      compromiseState:
        "NORMAL",
      operation:
        "RECOVERY_VERIFY",
    });

  assert.equal(missing.allow, false);
  assert.match(
    missing.reasons.join(" "),
    /undefined/i,
  );
});

test("invalid security policy mode fails closed instead of silently selecting built-in policy", () => {
  assert.throws(
    () =>
      createSecurityPolicyEvaluator(
        "INVALID" as never,
      ),
    /mode_invalid/i,
  );
});
