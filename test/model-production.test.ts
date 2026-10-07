import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyProductionModelRuntime,
  type MemorySnapshot,
  type ProductionQualificationContext,
} from "../src/qualification/model-production.js";

function context(
  overrides:
    Partial<ProductionQualificationContext> = {},
): ProductionQualificationContext {
  return {
    sourceCommit:
      "099f99c45b71ea7649ce899ae726240044056797",
    ollamaBaseUrl:
      "http://127.0.0.1:11435",
    ollamaVersion:
      "ollama version is 0.40.0",
    restartVerified: true,
    longRunTurns: 4,
    host: {
      targetHardwareId:
        "fixture-edge-01",
      platform: "linux",
      release: "fixture",
      arch: "x64",
      cpuModel: "fixture",
      cpuCount: 8,
      totalMemoryBytes:
        16 * 1024 ** 3,
      nodeVersion: "v24.0.0",
      accelerator: "none",
    },
    ...overrides,
  };
}

const memory =
  (): MemorySnapshot => ({
    freeBytes:
      4 * 1024 ** 3,
    totalBytes:
      16 * 1024 ** 3,
    processRssBytes:
      128 * 1024 ** 2,
  });

test("production model runtime qualification passes bound local target evidence", async () => {
  const result =
    await qualifyProductionModelRuntime(
      context(),
      async (turns) => ({
        historyBeforeRestart:
          Math.floor(
            turns / 2,
          ),
        historyAfterRestart:
          turns,
        mutationObserved: false,
      }),
      memory,
    );

  assert.equal(
    result.passed,
    true,
  );
  assert.equal(
    result.checks.every(
      (item) => item.passed,
    ),
    true,
  );
});

test("production qualification rejects hosted or ambiguous target identity", async () => {
  const result =
    await qualifyProductionModelRuntime(
      context({
        host: {
          ...context().host,
          targetHardwareId:
            "UNKNOWN",
        },
      }),
      async () => ({
        historyBeforeRestart: 2,
        historyAfterRestart: 4,
        mutationObserved: false,
      }),
      memory,
    );

  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "target hardware identity",
    )?.passed,
    false,
  );
});

test("production qualification rejects stale source and missing restart evidence", async () => {
  const result =
    await qualifyProductionModelRuntime(
      context({
        sourceCommit: "UNKNOWN",
        restartVerified: false,
      }),
      async () => ({
        historyBeforeRestart: 2,
        historyAfterRestart: 4,
        mutationObserved: false,
      }),
      memory,
    );

  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "source commit binding",
    )?.passed,
    false,
  );
  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "model process restart",
    )?.passed,
    false,
  );
});

test("production qualification fails checkpoint loss or mutation observation", async () => {
  const result =
    await qualifyProductionModelRuntime(
      context(),
      async () => ({
        historyBeforeRestart: 2,
        historyAfterRestart: 2,
        mutationObserved: true,
      }),
      memory,
    );

  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "checkpoint continuation",
    )?.passed,
    false,
  );
  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "runtime mutation boundary",
    )?.passed,
    false,
  );
});

test("production qualification rejects non-loopback inference", async () => {
  const result =
    await qualifyProductionModelRuntime(
      context({
        ollamaBaseUrl:
          "https://models.example.com",
      }),
      async () => ({
        historyBeforeRestart: 2,
        historyAfterRestart: 4,
        mutationObserved: false,
      }),
      memory,
    );

  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "local inference boundary",
    )?.passed,
    false,
  );
});

test("production qualification fails when memory reserve is exhausted", async () => {
  const lowMemory =
    (): MemorySnapshot => ({
      freeBytes:
        32 * 1024 ** 2,
      totalBytes:
        16 * 1024 ** 3,
      processRssBytes:
        128 * 1024 ** 2,
    });

  const result =
    await qualifyProductionModelRuntime(
      context(),
      async () => ({
        historyBeforeRestart: 2,
        historyAfterRestart: 4,
        mutationObserved: false,
      }),
      lowMemory,
    );

  assert.equal(
    result.checks.find(
      (item) =>
        item.name ===
        "memory reserve",
    )?.passed,
    false,
  );
});
