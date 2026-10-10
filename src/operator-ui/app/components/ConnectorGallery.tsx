import type { ExperienceLevel } from "../../experience-level.js";
import { TARGET_CONNECTORS } from "../../../integration-sim/catalog.js";
import type { SovereignChangeRecord, TargetConnector } from "../../../integration-sim/types.js";

/**
 * The SovereignChangeRecord contract (src/integration-sim/types.ts) every
 * simulated connector run emits. Static display data with two honest limits,
 * both verified in test/operator-ui-d3-surfaces.test.tsx: the browser bundle
 * never runs simulations (they hash with node:crypto) and never mints record
 * hashes — actual hash-chained records are produced headlessly by the
 * qualification CLI. The invariant strings must match what a live simulation
 * emits; the test cross-checks them against real simulation output.
 */
export const RECORD_CONTRACT_FIELDS: ReadonlyArray<{
  field: keyof SovereignChangeRecord;
  invariant: string;
}> = [
  { field: "schemaVersion", invariant: "1" },
  { field: "actionType", invariant: "SYNTHETIC_CONNECTION_TEST" },
  { field: "actor", invariant: "test-integration-agent" },
  { field: "policyDecision", invariant: "SIMULATED_ALLOW_NO_EXECUTION" },
  { field: "capabilityLease", invariant: "SIMULATED_NON_EXECUTING_LEASE" },
  { field: "execution", invariant: "NOT_EXECUTED_SYNTHETIC" },
  { field: "verification", invariant: "PASS" },
  { field: "recordHash", invariant: "sha256, chained via previousRecordHash" },
];

const AGENT_BUILDER_CLAIM =
  "TEST_DOUBLE connectors are simulations: no external connection is made, and every run produces synthetic, hash-chained evidence records.";

function ConnectorCard(props: { connector: TargetConnector; expert: boolean }) {
  const connector = props.connector;
  const simulated = connector.family === "AGENT_BUILDER";
  return (
    <article className="connector-card" data-connector-id={connector.id} data-family={connector.family}>
      <h3>{connector.id}</h3>
      <p className="status-row">
        <span className="status-badge" data-status={connector.status}>
          {connector.status}
        </span>
        {simulated && (
          <span className="status-badge" data-status="SIMULATED">
            Simulated — synthetic evidence
          </span>
        )}
      </p>
      {props.expert && (
        <p className="connector-manifest">
          <small>
            endpoint: <code>{connector.endpoint ?? "no declared simulation endpoint"}</code>
            <br />
            substrates: <code>{connector.substrates.join(", ")}</code>
          </small>
        </p>
      )}
      <p>
        <small>{connector.notes}</small>
      </p>
    </article>
  );
}

/**
 * Connector gallery (Advanced and Expert — spec mode matrix, D2 row).
 * Advanced: all fourteen connectors — eight simulated agent-builder, six
 * environment/managed-operations — with literal status badges and
 * synthetic-evidence labels on TEST_DOUBLEs. Expert adds the per-connector
 * manifest and the sovereign record contract. Not rendered at Beginner.
 */
export function ConnectorGallery(props: { level: ExperienceLevel }) {
  const expert = props.level === "EXPERT";
  const agentBuilders = TARGET_CONNECTORS.filter((connector) => connector.family === "AGENT_BUILDER");
  const environment = TARGET_CONNECTORS.filter((connector) => connector.family !== "AGENT_BUILDER");
  return (
    <section className="panel advanced-only" id="connectors" aria-label="Connector gallery">
      <h2>Connector gallery</h2>
      <p>
        <small>
          {agentBuilders.length} simulated agent-builder connectors and {environment.length} environment
          connectors. {AGENT_BUILDER_CLAIM}
        </small>
      </p>
      <div className="connector-grid">
        {agentBuilders.map((connector) => (
          <ConnectorCard key={connector.id} connector={connector} expert={expert} />
        ))}
        {environment.map((connector) => (
          <ConnectorCard key={connector.id} connector={connector} expert={expert} />
        ))}
      </div>
      {expert && (
        <div className="record-contract">
          <h3>Sovereign change record — contract emitted by every simulated run</h3>
          <dl>
            {RECORD_CONTRACT_FIELDS.map((entry) => (
              <div className="record-field" key={entry.field}>
                <dt>
                  <code>record.{entry.field}</code>
                </dt>
                <dd>{entry.invariant}</dd>
              </div>
            ))}
          </dl>
          <p>
            <small>
              Records are hash-chained (SHA-256 via previousRecordHash) and verified in the qualification
              suites. This browser bundle does not run simulations or mint record hashes — actual chained
              records are produced headlessly by <code>npm run matrix:agent-builder</code>.
            </small>
          </p>
        </div>
      )}
    </section>
  );
}
