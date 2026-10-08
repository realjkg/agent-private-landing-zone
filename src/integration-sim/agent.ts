import {
  createHash,
} from "node:crypto";

import {
  EVIDENCE_CONNECTORS,
  TARGET_CONNECTORS,
} from "./catalog.js";
import type {
  ConnectionSimulationResult,
  EvidenceConnector,
  ExternalReference,
  SovereignChangeRecord,
  TargetConnector,
  TraceabilityMode,
} from "./types.js";

type RecordWithoutHash =
  Omit<
    SovereignChangeRecord,
    "recordHash"
  >;

function hashRecord(
  record: RecordWithoutHash,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(record),
    )
    .digest("hex");
}

function canonicalId(
  target: TargetConnector,
): string {
  return (
    "chg-synth-" +
    target.id
      .toLowerCase()
      .replaceAll("_", "-")
  );
}

function externalReference(
  connector: EvidenceConnector,
  target: TargetConnector,
): ExternalReference {
  return {
    provider:
      connector.id,
    recordId:
      [
        connector.id,
        "SYNTH",
        target.id,
      ].join("-"),
  };
}

function createRecord(input: {
  changeRecordId: string;
  target: TargetConnector;
  mode: TraceabilityMode;
  externalReferences?: ExternalReference[];
  parentChangeRecordIds?: string[];
  previousRecordHash?: string;
}): SovereignChangeRecord {
  const body: RecordWithoutHash = {
    schemaVersion: 1,
    changeRecordId:
      input.changeRecordId,
    targetConnector:
      input.target.id,
    targetStatus:
      input.target.status,
    traceabilityMode:
      input.mode,
    authorityClass:
      "OPERATE",
    actionType:
      "SYNTHETIC_CONNECTION_TEST",
    actor:
      "test-integration-agent",
    policyDecision:
      "SIMULATED_ALLOW_NO_EXECUTION",
    capabilityLease:
      "SIMULATED_NON_EXECUTING_LEASE",
    execution:
      "NOT_EXECUTED_SYNTHETIC",
    verification:
      "PASS",
    externalReferences:
      input.externalReferences ?? [],
    parentChangeRecordIds:
      input.parentChangeRecordIds ?? [],
    ...(input.previousRecordHash
      ? {
          previousRecordHash:
            input.previousRecordHash,
        }
      : {}),
  };

  return {
    ...body,
    recordHash:
      hashRecord(body),
  };
}

export function verifyRecordHash(
  record: SovereignChangeRecord,
): boolean {
  const {
    recordHash,
    ...body
  } = record;

  return (
    hashRecord(body) ===
    recordHash
  );
}

export function simulateConnection(
  target: TargetConnector,
  mode: TraceabilityMode,
  evidenceConnector?: EvidenceConnector,
): ConnectionSimulationResult {
  if (
    mode === "DISCONNECTED" &&
    evidenceConnector
  ) {
    throw new Error(
      "DISCONNECTED mode cannot bind an external evidence connector.",
    );
  }

  if (
    mode !== "DISCONNECTED" &&
    !evidenceConnector
  ) {
    throw new Error(
      mode +
        " mode requires an external evidence connector.",
    );
  }

  const canonicalChangeRecordId =
    canonicalId(target);

  if (
    mode === "DISCONNECTED"
  ) {
    const localRecord =
      createRecord({
        changeRecordId:
          canonicalChangeRecordId,
        target,
        mode:
          "DISCONNECTED",
      });

    return {
      target,
      mode,
      records: [localRecord],
      canonicalChangeRecordId,
      traceable: true,
      externalAuthorityGranted:
        false,
      infrastructureMutationAttempted:
        false,
    };
  }

  const connector =
    evidenceConnector as EvidenceConnector;
  const reference =
    externalReference(
      connector,
      target,
    );

  if (
    mode === "CONNECTED"
  ) {
    const connectedRecord =
      createRecord({
        changeRecordId:
          canonicalChangeRecordId,
        target,
        mode:
          "CONNECTED",
        externalReferences: [
          reference,
        ],
      });

    return {
      target,
      evidenceConnector:
        connector,
      mode,
      records: [
        connectedRecord,
      ],
      canonicalChangeRecordId,
      traceable: true,
      externalAuthorityGranted:
        false,
      infrastructureMutationAttempted:
        false,
    };
  }

  const disconnectedRecord =
    createRecord({
      changeRecordId:
        canonicalChangeRecordId,
      target,
      mode:
        "DISCONNECTED",
    });

  const reconciledRecord =
    createRecord({
      changeRecordId:
        canonicalChangeRecordId +
        ":reconciled:" +
        connector.id.toLowerCase(),
      target,
      mode:
        "RECONCILED",
      externalReferences: [
        reference,
      ],
      parentChangeRecordIds: [
        canonicalChangeRecordId,
      ],
      previousRecordHash:
        disconnectedRecord
          .recordHash,
    });

  return {
    target,
    evidenceConnector:
      connector,
    mode,
    records: [
      disconnectedRecord,
      reconciledRecord,
    ],
    canonicalChangeRecordId,
    traceable: true,
    externalAuthorityGranted:
      false,
    infrastructureMutationAttempted:
      false,
  };
}

export function syntheticQualificationMatrix():
  ConnectionSimulationResult[] {
  const results:
    ConnectionSimulationResult[] = [];

  for (const target of
    TARGET_CONNECTORS) {
    results.push(
      simulateConnection(
        target,
        "DISCONNECTED",
      ),
    );

    for (const connector of
      EVIDENCE_CONNECTORS) {
      results.push(
        simulateConnection(
          target,
          "CONNECTED",
          connector,
        ),
      );
      results.push(
        simulateConnection(
          target,
          "RECONCILED",
          connector,
        ),
      );
    }
  }

  return results;
}
