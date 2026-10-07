import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

import {
  parseRecoveryTargets,
} from "../src/recovery/target-loader.js";
import {
  validateRecoveryTarget,
} from "../src/recovery/target.js";
import {
  parseSecurityBaseline,
} from "../src/recovery/profile/baseline.js";
import {
  compileRecoveryTarget,
} from "../src/recovery/profile/compiler.js";
import {
  promoteIntentToProduction,
  semanticRecoveryDiff,
} from "../src/recovery/profile/diff.js";
import {
  explainRecoveryIntent,
  recoveryIntentFromAnswers,
  recoveryTargetStatus,
  recoveryTestReadiness,
} from "../src/recovery/profile/operator.js";
import type {
  RecoveryCompileContext,
  RecoveryTargetIntent,
} from "../src/recovery/profile/types.js";
import {
  verifyCompiledRecoveryTarget,
} from "../src/recovery/profile/verify.js";

const baselineRaw =
  readFileSync(
    "config/security-baseline.md",
    "utf8",
  );

const baseline =
  parseSecurityBaseline(
    baselineRaw,
  );

const context:
  RecoveryCompileContext = {
    engine: "TERRAFORM",
    approvedDesignHash:
      "a".repeat(64),
    designRef:
      "fixture:design",
    sourceOfTruthRef:
      "fixture:git",
    destinationTargetRef:
      "aws:backup-vault:account:region:vault",
    sourceCommit:
      "commit-fixture",
  };

const developmentIntent:
  RecoveryTargetIntent = {
    targetId: "payments-dev",
    owner: "platform",
    provider: "AWS",
    scopeId: "123456789012",
    organization: "STARTUP",
    environment: "DEVELOPMENT",
    criticality: "NON_CRITICAL",
    compliancePacks: [],
  };

test("security baseline parses only strict front matter and keeps ACT disabled", () => {
  assert.equal(
    baseline.actEnabled,
    false,
  );
  assert.equal(
    baseline.centralControlCanDecrypt,
    false,
  );
  assert.equal(
    baseline.immutableRecovery,
    true,
  );
  assert.equal(
    baseline.expectedSha256.length,
    64,
  );

  const proseAttempt =
    parseSecurityBaseline(
      baselineRaw +
        "\nactEnabled: true\n",
    );

  assert.equal(
    proseAttempt.actEnabled,
    false,
  );
});

test("seven customer answers create a small recovery intent", () => {
  const intent =
    recoveryIntentFromAnswers([
      "payments-dev",
      "platform",
      "aws",
      "123456789012",
      "startup",
      "development",
      "non-critical",
    ]);

  assert.deepEqual(
    intent,
    developmentIntent,
  );

  assert.throws(
    () =>
      recoveryIntentFromAnswers([
        "too",
        "few",
      ]),
    /exactly seven/i,
  );
});

test("compiled profile extends the existing target contract without granting capabilities", () => {
  const compiled =
    compileRecoveryTarget(
      developmentIntent,
      context,
      baseline,
    );

  assert.equal(
    validateRecoveryTarget(
      compiled,
    ).valid,
    true,
  );
  assert.equal(
    verifyCompiledRecoveryTarget(
      compiled,
    ).valid,
    true,
  );

  assert.deepEqual(
    compiled.capabilityRequests,
    [
      "EVIDENCE_READ",
      "EVIDENCE_WRITE",
      "CLOUD_READ",
    ],
  );

  assert.equal(
    compiled.evidenceDestination
      .kind,
    "LOCAL_ENCRYPTED_VAULT",
  );

  assert.equal(
    compiled.recoveryMetadata
      .destination.placement,
    "PROVIDER_EDGE",
  );
  assert.equal(
    compiled.recoveryMetadata
      .destination
      .centralControlCanDecrypt,
    false,
  );
  assert.equal(
    compiled.recoveryMetadata
      .automation
      .productionMutation,
    false,
  );
  assert.equal(
    compiled.recoveryMetadata
      .dataBoundary
      .productionDataAllowed,
    false,
  );
});

test("profile composition applies compliance overlays then authorized continuity overrides", () => {
  const intent = {
    ...developmentIntent,
    compliancePacks: [
      "TEST_PACK@1",
    ],
  };

  const compiled =
    compileRecoveryTarget(
      intent,
      {
        ...context,
        complianceOverlays: {
          "TEST_PACK@1": {
            rpoMinutes: 120,
            retentionDays: 45,
          },
        },
        authorizedOverrides: {
          rpoMinutes: 90,
        },
      },
      baseline,
    );

  assert.equal(
    compiled.objectives
      .rpoMinutes,
    90,
  );
  assert.equal(
    compiled.objectives
      .retentionDays,
    45,
  );

  assert.throws(
    () =>
      compileRecoveryTarget(
        intent,
        context,
        baseline,
      ),
    /no installed overlay/i,
  );
});

test("locked immutable recovery cannot be weakened by an override", () => {
  assert.throws(
    () =>
      compileRecoveryTarget(
        developmentIntent,
        {
          ...context,
          authorizedOverrides: {
            immutable: false,
          },
        },
        baseline,
      ),
    /immutable recovery is locked/i,
  );
});

test("development to production promotion recompiles and produces a semantic policy diff", () => {
  const development =
    compileRecoveryTarget(
      developmentIntent,
      context,
      baseline,
    );

  const productionIntent =
    promoteIntentToProduction(
      developmentIntent,
    );

  const production =
    compileRecoveryTarget(
      productionIntent,
      context,
      baseline,
    );

  const diff =
    semanticRecoveryDiff(
      development
        .recoveryMetadata,
      production
        .recoveryMetadata,
    );

  assert.equal(
    diff.changed,
    true,
  );

  const paths =
    diff.changes.map(
      (change) =>
        change.path,
    );

  assert.ok(
    paths.includes(
      "selection.environment",
    ),
  );
  assert.ok(
    paths.includes(
      "dataBoundary.productionDataAllowed",
    ),
  );
  assert.ok(
    paths.includes(
      "objectives.rpoMinutes",
    ),
  );

  assert.equal(
    production.objectives
      .rpoMinutes,
    240,
  );
});

test("compiled target integrity rejects hand-edited runtime values", () => {
  const compiled =
    compileRecoveryTarget(
      developmentIntent,
      context,
      baseline,
    );

  const tampered = {
    ...compiled,
    objectives: {
      ...compiled.objectives,
      rpoMinutes: 5,
    },
  };

  const result =
    verifyCompiledRecoveryTarget(
      tampered,
    );

  assert.equal(
    result.valid,
    false,
  );
  assert.match(
    result.blockers.join(" "),
    /hash|RPO/i,
  );
});

test("target loader preserves compiled metadata and remains backward compatible with legacy targets", () => {
  const compiled =
    compileRecoveryTarget(
      developmentIntent,
      context,
      baseline,
    );

  const parsed =
    parseRecoveryTargets([
      compiled,
    ]);

  assert.equal(
    parsed[0]
      .recoveryMetadata
      ?.apiVersion,
    "alz.io/recovery/v1",
  );

  const {
    recoveryMetadata:
      _metadata,
    ...legacy
  } = compiled;

  const parsedLegacy =
    parseRecoveryTargets([
      legacy,
    ]);

  assert.equal(
    parsedLegacy[0]
      .recoveryMetadata,
    undefined,
  );
});

test("plain-language status and recovery test preflight preserve the non-mutating boundary", () => {
  const compiled =
    compileRecoveryTarget(
      developmentIntent,
      context,
      baseline,
    );

  const status =
    recoveryTargetStatus(
      compiled,
    );
  const preflight =
    recoveryTestReadiness(
      compiled,
    );

  assert.equal(
    status.ready,
    true,
  );
  assert.equal(
    preflight.ready,
    true,
  );
  assert.match(
    preflight.lines.join(" "),
    /isolated preview/i,
  );
  assert.match(
    preflight.lines.join(" "),
    /No infrastructure changes were made/i,
  );

  const explanation =
    explainRecoveryIntent(
      developmentIntent,
    );

  assert.match(
    explanation,
    /Production data is prohibited/i,
  );
});
