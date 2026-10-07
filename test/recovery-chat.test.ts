import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionGraph,
} from "../src/session/graph.js";

const input = {
  provider: "AWS" as const,
  engine: "TERRAFORM" as const,
  mock: "brownfield" as const,
  approveBuild: false,
  fixture: true,
};

test("recovery conversation persists a simulated point and never enables mutation", async () => {
  const { graph } =
    createSessionGraph(":memory:");

  const config = {
    configurable: {
      thread_id:
        "recovery-chat-thread",
    },
  };

  const design = await graph.invoke(
    {
      ...input,
      request:
        "Design this landing zone using Terraform.",
    },
    config,
  );

  assert.ok(design.agentState?.design);
  assert.equal(
    design.agentState?.orchestration
      ?.actEnabled,
    false,
  );

  const status = await graph.invoke(
    {
      ...input,
      request:
        "What is protected?",
    },
    config,
  );

  assert.match(
    status.response ?? "",
    /manifest, not a backup/i,
  );
  assert.match(
    status.response ?? "",
    /RPO: UNKNOWN/i,
  );

  const prepared = await graph.invoke(
    {
      ...input,
      request:
        "Prepare a simulated recovery point.",
    },
    config,
  );

  assert.equal(
    prepared.recoveryPoint
      ?.coverage,
    "MANIFEST_ONLY",
  );
  assert.equal(
    prepared.recoveryPoint
      ?.actEnabled,
    false,
  );
  assert.match(
    prepared.response ?? "",
    /not proof of a recoverable backup/i,
  );

  const verified = await graph.invoke(
    {
      ...input,
      request:
        "Verify this recovery point.",
    },
    config,
  );

  assert.equal(
    verified.recoveryVerification
      ?.status,
    "BLOCKED",
  );

  const drilled = await graph.invoke(
    {
      ...input,
      request:
        "Run a simulated restore drill.",
    },
    config,
  );

  assert.equal(
    drilled.recoveryDrill
      ?.status,
    "BLOCKED",
  );
  assert.equal(
    drilled.recoveryDrill
      ?.mutationAttempted,
    false,
  );
  assert.equal(
    drilled.recoveryDrill
      ?.actEnabled,
    false,
  );

  const blockers = await graph.invoke(
    {
      ...input,
      request:
        "What would block recovery?",
    },
    config,
  );

  assert.match(
    blockers.response ?? "",
    /CONFIGURATION_EXPORT/,
  );
  assert.match(
    blockers.response ?? "",
    /IAC_STATE/,
  );

  const drift = await graph.invoke(
    {
      ...input,
      request:
        "What changed since the recovery point?",
    },
    config,
  );

  assert.equal(
    drift.recoveryDrift?.status,
    "MATCHED",
  );
  assert.match(
    drift.response ?? "",
    /No drift was remediated automatically/,
  );

  const next = await graph.invoke(
    {
      ...input,
      request:
        "What should we fix before this is release-ready?",
    },
    config,
  );

  assert.match(
    next.response ?? "",
    /not fully verified/i,
  );
  assert.match(
    next.response ?? "",
    /ACT remains disabled/,
  );
});

test("preparing a new recovery point invalidates stale verification and drill evidence", async () => {
  const { graph } =
    createSessionGraph(":memory:");

  const config = {
    configurable: {
      thread_id:
        "recovery-refresh-thread",
    },
  };

  await graph.invoke(
    {
      ...input,
      request:
        "Design this landing zone using Terraform.",
    },
    config,
  );

  await graph.invoke(
    {
      ...input,
      request:
        "Prepare a simulated recovery point.",
    },
    config,
  );

  await graph.invoke(
    {
      ...input,
      request:
        "Verify this recovery point.",
    },
    config,
  );

  const drilled = await graph.invoke(
    {
      ...input,
      request:
        "Run a simulated restore drill.",
    },
    config,
  );

  assert.ok(
    drilled.recoveryVerification,
  );
  assert.ok(
    drilled.recoveryDrill,
  );

  const refreshed = await graph.invoke(
    {
      ...input,
      request:
        "Prepare a simulated recovery point.",
    },
    config,
  );

  assert.equal(
    refreshed.recoveryVerification,
    undefined,
  );
  assert.equal(
    refreshed.recoveryDrill,
    undefined,
  );
  assert.equal(
    refreshed.recoveryDrift,
    undefined,
  );
});
