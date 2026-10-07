import assert from "node:assert/strict";
import test from "node:test";

import {
  candidatesForRole,
  CANDIDATE_MODELS,
} from "../src/models/candidates.js";
import {
  SOVEREIGN_MODEL_AUTHORITY,
  substrateAllowedByDefault,
} from "../src/models/execution-contract.js";

test("all candidate models inherit the same zero-authority Sovereign LZ boundary", () => {
  assert.deepEqual(
    SOVEREIGN_MODEL_AUTHORITY,
    {
      advisoryOnly: true,
      directToolAccess: false,
      directAdapterAccess: false,
      canGrantCapabilities: false,
      canAlterPolicy: false,
      canAlterDataBoundary: false,
      canAlterEgressPolicy: false,
      canApproveOwnRestrictedAction:
        false,
      actEnabled: false,
    },
  );
});

test("managed external inference is never sovereign-by-default", () => {
  assert.equal(
    substrateAllowedByDefault(
      "OLLAMA_LOCAL",
    ),
    true,
  );
  assert.equal(
    substrateAllowedByDefault(
      "NVIDIA_NIM_PRIVATE",
    ),
    true,
  );
  assert.equal(
    substrateAllowedByDefault(
      "FOUNDRY_LOCAL",
    ),
    true,
  );
  assert.equal(
    substrateAllowedByDefault(
      "BASETEN_SELF_HOSTED",
    ),
    true,
  );
  assert.equal(
    substrateAllowedByDefault(
      "EXTERNAL_MANAGED",
    ),
    false,
  );
});

test("24GB laptop primary candidates exclude oversized server models", () => {
  const primary =
    candidatesForRole(
      "PRIMARY_ENGINEER",
      {
        laptopMemoryGb: 24,
        requireLocal: true,
      },
    );

  const ids =
    primary.map(
      (candidate) =>
        candidate.id,
    );

  assert.ok(
    ids.includes(
      "GPT_OSS_20B",
    ),
  );
  assert.ok(
    ids.includes(
      "DEVSTRAL_SMALL_2_24B",
    ),
  );
  assert.ok(
    ids.includes(
      "QWEN3_CODER_30B_A3B",
    ),
  );

  const qwen =
    primary.find(
      (candidate) =>
        candidate.id ===
        "QWEN3_CODER_30B_A3B",
    );
  assert.equal(
    qwen?.laptop24Fit,
    "TIGHT",
  );
  assert.equal(
    ids.includes(
      "QWEN3_CODER_NEXT",
    ),
    false,
  );
  assert.equal(
    ids.includes(
      "NEMOTRON_3_SUPER",
    ),
    false,
  );
});

test("Phi reasoning remains a validator/specialist rather than an autonomous tool worker", () => {
  const phi =
    CANDIDATE_MODELS.find(
      (candidate) =>
        candidate.id ===
        "PHI_4_REASONING_14B",
    );

  assert.ok(phi);
  assert.equal(
    phi.nativeToolUse,
    false,
  );
  assert.ok(
    phi.roles.includes(
      "VALIDATOR",
    ),
  );
  assert.equal(
    phi.roles.includes(
      "PRIMARY_ENGINEER",
    ),
    false,
  );
});

test("Nemotron 3.5 Lightning is excluded as a safe 24GB default", () => {
  const nemotron =
    CANDIDATE_MODELS.find(
      (candidate) =>
        candidate.id ===
        "NEMOTRON_3_5_LIGHTNING_30B_A3B",
    );

  assert.ok(nemotron);
  assert.equal(
    nemotron.laptop24Fit,
    "NO",
  );
});


test("Phi-4 Mini is a compact tool-capable router/specialist candidate", () => {
  const phi =
    CANDIDATE_MODELS.find(
      (candidate) =>
        candidate.id ===
        "PHI_4_MINI_INSTRUCT",
    );

  assert.ok(phi);
  assert.equal(
    phi.nativeToolUse,
    true,
  );
  assert.equal(
    phi.approximateLocalWeightGb,
    2.5,
  );
  assert.ok(
    phi.roles.includes(
      "ROUTER",
    ),
  );
});
