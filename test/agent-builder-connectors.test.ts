import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_BUILDER_TARGET_CONNECTORS,
  EVIDENCE_CONNECTORS,
  TARGET_CONNECTORS,
} from "../src/integration-sim/catalog.js";
import {
  simulateConnection,
  syntheticQualificationMatrix,
  verifyRecordHash,
} from "../src/integration-sim/agent.js";

const AGENT_BUILDER_IDS = [
  "AZURE_LOCAL_AI_FOUNDRY",
  "AWS_OUTPOSTS_SAGEMAKER",
  "VMWARE_PRIVATE_AI",
  "NUTANIX_AI",
  "REDHAT_OPENSHIFT_AI",
  "LANGCHAIN_PRIVATE",
  "AUTOGEN_PRIVATE",
  "CREWAI_PRIVATE",
];

const SPEC_SUBSTRATES: Record<string, string[]> = {
  AZURE_LOCAL_AI_FOUNDRY: ["azurelocal"],
  AWS_OUTPOSTS_SAGEMAKER: ["outposts"],
  VMWARE_PRIVATE_AI: ["vcf"],
  NUTANIX_AI: ["nutanix"],
  REDHAT_OPENSHIFT_AI: ["openshift"],
  LANGCHAIN_PRIVATE: ["agent-framework"],
  AUTOGEN_PRIVATE: ["agent-framework"],
  CREWAI_PRIVATE: ["agent-framework"],
};

test("eight agent-builder connectors exist per the spec table", () => {
  assert.equal(TARGET_CONNECTORS.length, 14);
  assert.deepEqual(
    AGENT_BUILDER_TARGET_CONNECTORS.map(
      (connector) => connector.id,
    ),
    AGENT_BUILDER_IDS,
  );

  for (const connector of
    AGENT_BUILDER_TARGET_CONNECTORS
  ) {
    assert.equal(
      connector.family,
      "AGENT_BUILDER",
      connector.id,
    );
    assert.equal(
      connector.status,
      "TEST_DOUBLE",
      connector.id,
    );
    assert.deepEqual(
      connector.substrates,
      SPEC_SUBSTRATES[connector.id],
      connector.id,
    );
  }
});

test("agent-builder endpoints are loopback-only", () => {
  for (const connector of
    AGENT_BUILDER_TARGET_CONNECTORS
  ) {
    assert.ok(connector.endpoint, connector.id);

    const url = new URL(connector.endpoint);
    assert.equal(
      url.protocol,
      "http:",
      connector.id,
    );
    assert.equal(
      url.hostname,
      "127.0.0.1",
      connector.id,
    );
    assert.match(
      connector.notes,
      /no external connection is made/i,
      connector.id,
    );
  }

  // Endpoints are a TEST_DOUBLE declaration; the six
  // pre-existing connectors must not silently grow one.
  for (const connector of TARGET_CONNECTORS) {
    if (connector.family !== "AGENT_BUILDER") {
      assert.equal(
        connector.endpoint,
        undefined,
        connector.id,
      );
    }
  }
});

test("every agent-builder simulation denies authority and mutation in all modes", () => {
  for (const connector of
    AGENT_BUILDER_TARGET_CONNECTORS
  ) {
    const lanes = [
      simulateConnection(
        connector,
        "DISCONNECTED",
      ),
    ];

    for (const evidence of
      EVIDENCE_CONNECTORS
    ) {
      lanes.push(
        simulateConnection(
          connector,
          "CONNECTED",
          evidence,
        ),
        simulateConnection(
          connector,
          "RECONCILED",
          evidence,
        ),
      );
    }

    assert.equal(
      lanes.length,
      1 + EVIDENCE_CONNECTORS.length * 2,
      connector.id,
    );

    for (const lane of lanes) {
      assert.equal(lane.traceable, true);
      assert.equal(
        lane.externalAuthorityGranted,
        false,
        connector.id,
      );
      assert.equal(
        lane
          .infrastructureMutationAttempted,
        false,
        connector.id,
      );
      assert.equal(lane.target.id, connector.id);

      for (const record of lane.records) {
        assert.equal(
          record.execution,
          "NOT_EXECUTED_SYNTHETIC",
          connector.id,
        );
        assert.equal(
          record.policyDecision,
          "SIMULATED_ALLOW_NO_EXECUTION",
          connector.id,
        );
        assert.equal(
          record.capabilityLease,
          "SIMULATED_NON_EXECUTING_LEASE",
          connector.id,
        );
        assert.equal(
          record.actionType,
          "SYNTHETIC_CONNECTION_TEST",
          connector.id,
        );
        assert.equal(
          record.actor,
          "test-integration-agent",
          connector.id,
        );
        assert.equal(
          record.targetConnector,
          connector.id,
        );
      }
    }
  }
});

test("agent-builder records verify against the hash chain", () => {
  const results =
    syntheticQualificationMatrix().filter(
      (lane) =>
        lane.target.family === "AGENT_BUILDER",
    );

  // 8 connectors x (1 + 7 evidence connectors x 2 modes).
  assert.equal(results.length, 8 * 15);

  let recordCount = 0;
  for (const lane of results) {
    for (const record of lane.records) {
      recordCount += 1;
      assert.equal(
        verifyRecordHash(record),
        true,
        record.changeRecordId,
      );
    }

    if (lane.mode === "RECONCILED") {
      const [local, reconciled] = lane.records;
      assert.ok(local && reconciled, lane.canonicalChangeRecordId);
      assert.equal(
        reconciled.previousRecordHash,
        local.recordHash,
        lane.canonicalChangeRecordId,
      );
      assert.deepEqual(
        reconciled.parentChangeRecordIds,
        [local.changeRecordId],
      );
    }
  }

  // DISCONNECTED and CONNECTED lanes carry one record;
  // RECONCILED lanes carry the local record plus the
  // hash-linked reconciled record.
  assert.equal(recordCount, 8 * 22);
});

const NETWORK_CLIENT_PATTERN =
  /(?:from|import|require)\s*\(?\s*["'](?:node:)?(?:http|https|net|tls|dns|undici|axios|node-fetch|superagent|ky)(?=["'/])|\bcreateRequire\b|(?<!\.)\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/;

test("integration-sim imports no network client", () => {
  const folder = join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/integration-sim",
  );

  const files = readdirSync(folder)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  assert.ok(
    files.length >= 3,
    "expected the integration-sim sources, found: " +
      files.join(","),
  );

  for (const file of files) {
    const source = readFileSync(
      join(folder, file),
      "utf8",
    );
    const match =
      NETWORK_CLIENT_PATTERN.exec(source);
    assert.equal(
      match,
      null,
      file +
        " must not pull in a network client, found: " +
        (match?.[0] ?? ""),
    );
  }
});
