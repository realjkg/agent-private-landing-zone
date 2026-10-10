import {
  AGENT_BUILDER_TARGET_CONNECTORS,
  EVIDENCE_CONNECTORS,
} from "../integration-sim/catalog.js";
import {
  simulateConnection,
  verifyRecordHash,
} from "../integration-sim/agent.js";
import type {
  ConnectionSimulationResult,
  TargetConnector,
  TraceabilityMode,
} from "../integration-sim/types.js";

type ConnectorSummary = {
  id: string;
  substrate: string;
  endpoint: string;
  lanes: number;
  records: number;
  hashesVerified: number;
  execution: string;
  externalAuthority: string;
  infrastructureMutation: string;
  ok: boolean;
};

const MODES: TraceabilityMode[] = [
  "DISCONNECTED",
  "CONNECTED",
  "RECONCILED",
];

function usage(): string[] {
  return [
    "Sovereign ALZ — simulated agent-builder connector matrix",
    "node dist/cli/agent-builder-sim.ts [--connector <ID>] [--mode <MODE>] [--json]",
    "Connectors: " +
      AGENT_BUILDER_TARGET_CONNECTORS.map(
        (connector) => connector.id,
      ).join(", "),
    "Modes: DISCONNECTED, CONNECTED, RECONCILED",
    "Simulation-only: loopback endpoints, NOT_EXECUTED_SYNTHETIC,",
    "no external authority, no infrastructure mutation, no egress.",
  ];
}

function parseArgs(args: string[]): {
  connectorId?: string;
  mode?: TraceabilityMode;
  json: boolean;
} {
  let connectorId: string | undefined;
  let mode: TraceabilityMode | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      console.log(usage().join("\n"));
      process.exit(0);
    } else if (arg === "--connector") {
      connectorId = args[++i];
      if (!connectorId) {
        throw new Error(
          "AGENT_BUILDER_CONNECTOR_ID_REQUIRED",
        );
      }
    } else if (arg === "--mode") {
      const value = args[++i];
      if (
        value !== "DISCONNECTED" &&
        value !== "CONNECTED" &&
        value !== "RECONCILED"
      ) {
        throw new Error(
          "AGENT_BUILDER_MODE_INVALID: " + value,
        );
      }
      mode = value;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(
        "AGENT_BUILDER_ARGUMENT_NOT_ALLOWED: " + arg,
      );
    }
  }

  return { connectorId, mode, json };
}

function selectConnectors(
  connectorId?: string,
): TargetConnector[] {
  if (!connectorId) {
    return AGENT_BUILDER_TARGET_CONNECTORS;
  }

  const connector =
    AGENT_BUILDER_TARGET_CONNECTORS.find(
      (candidate) => candidate.id === connectorId,
    );
  if (!connector) {
    throw new Error(
      "AGENT_BUILDER_CONNECTOR_NOT_FOUND: " +
        connectorId,
    );
  }
  return [connector];
}

function lanesFor(
  connector: TargetConnector,
  mode?: TraceabilityMode,
): ConnectionSimulationResult[] {
  const wanted =
    mode === undefined ? MODES : [mode];
  const lanes: ConnectionSimulationResult[] = [];

  for (const one of wanted) {
    if (one === "DISCONNECTED") {
      lanes.push(
        simulateConnection(
          connector,
          "DISCONNECTED",
        ),
      );
      continue;
    }

    for (const evidence of EVIDENCE_CONNECTORS) {
      lanes.push(
        simulateConnection(
          connector,
          one,
          evidence,
        ),
      );
    }
  }

  return lanes;
}

function isLoopback(
  connector: TargetConnector,
): boolean {
  if (!connector.endpoint) return false;
  const url = new URL(connector.endpoint);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1"
  );
}

function summarize(
  connector: TargetConnector,
  lanes: ConnectionSimulationResult[],
): ConnectorSummary {
  let records = 0;
  let hashesVerified = 0;
  let ok = isLoopback(connector);

  for (const lane of lanes) {
    if (!lane.traceable) ok = false;
    if (lane.externalAuthorityGranted) ok = false;
    if (lane.infrastructureMutationAttempted) {
      ok = false;
    }

    for (const record of lane.records) {
      records += 1;
      if (record.execution !== "NOT_EXECUTED_SYNTHETIC") {
        ok = false;
      }
      if (verifyRecordHash(record)) {
        hashesVerified += 1;
      } else {
        ok = false;
      }
    }
  }

  return {
    id: connector.id,
    substrate: connector.substrates[0] ?? "",
    endpoint: connector.endpoint ?? "UNDECLARED",
    lanes: lanes.length,
    records,
    hashesVerified,
    execution: "NOT_EXECUTED_SYNTHETIC",
    externalAuthority: "NONE",
    infrastructureMutation: "NONE",
    ok,
  };
}

function renderLine(
  summary: ConnectorSummary,
): string {
  return [
    summary.id,
    "substrate=" + summary.substrate,
    "endpoint=" + summary.endpoint,
    "lanes=" + summary.lanes,
    "records=" + summary.records,
    "hashes=" +
      summary.hashesVerified +
      "/" +
      summary.records,
    "execution=" + summary.execution,
    "externalAuthority=" + summary.externalAuthority,
    "infrastructureMutation=" +
      summary.infrastructureMutation,
    summary.ok ? "OK" : "FAILED",
  ].join("  ");
}

async function main(): Promise<void> {
  const { connectorId, mode, json } = parseArgs(
    process.argv.slice(2),
  );

  const selected = selectConnectors(connectorId);
  const runs = selected.map((connector) => ({
    connector,
    lanes: lanesFor(connector, mode),
  }));

  const summaries = runs.map((run) =>
    summarize(run.connector, run.lanes),
  );

  if (json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          connectorIds: summaries.map(
            (summary) => summary.id,
          ),
          mode: mode ?? "ALL",
          runs: runs.map((run) => ({
            connector: run.connector,
            lanes: run.lanes,
          })),
          summaries,
          infrastructureAct: "DISABLED",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      "Simulated agent-builder connector matrix " +
        "(TEST_DOUBLE, loopback-only, no egress)",
    );
    for (const summary of summaries) {
      console.log(renderLine(summary));
    }
    const totals = summaries.reduce(
      (acc, summary) => ({
        lanes: acc.lanes + summary.lanes,
        records: acc.records + summary.records,
        hashes:
          acc.hashes + summary.hashesVerified,
      }),
      { lanes: 0, records: 0, hashes: 0 },
    );
    console.log(
      "Connectors=" +
        summaries.length +
        " | lanes=" +
        totals.lanes +
        " | records=" +
        totals.records +
        " | hash-verified=" +
        totals.hashes,
    );
    console.log("Endpoints: LOOPBACK ONLY (http://127.0.0.1)");
    console.log(
      "External authority granted: NONE | Infrastructure mutation attempted: NONE",
    );
    console.log("Infrastructure ACT: DISABLED");
  }

  if (summaries.some((summary) => !summary.ok)) {
    console.error(
      "AGENT_BUILDER_SIMULATION_INVARIANT_FAILED",
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "AGENT_BUILDER_SIMULATION_FAILED",
  );
  process.exitCode = 1;
});
