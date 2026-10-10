import { TARGET_CONNECTORS } from "../../../integration-sim/catalog.js";
import { COMPLIANCE_PACKS } from "../../../compliance/packs/index.js";
import type { ControlStatus } from "../../../compliance/schema.js";
import { PACK_LABELS, STATUS_LABELS } from "../compliance-labels.js";

const STATUS_ORDER: ReadonlyArray<ControlStatus> = ["ALIGNED", "GAP", "UNKNOWN"];

function countByStatus(
  requirements: ReadonlyArray<{ status: ControlStatus }>,
  status: ControlStatus,
): number {
  return requirements.filter((requirement) => requirement.status === status).length;
}

/**
 * Per-status count LEDs shared by the summary strip and the compliance pack
 * headers (UX depth pass). Counts only, never scores: each chip is the
 * literal count of requirements holding that exact status, labeled with the
 * same literal vocabulary the requirement rows use (STATUS_LABELS). No
 * aggregate, rank, or progress number is computed, and nothing here
 * decorates an outcome.
 */
export function StatusCountLeds(props: {
  requirements: ReadonlyArray<{ status: ControlStatus }>;
}) {
  return (
    <>
      {STATUS_ORDER.map((status) => (
        <span className="strip-led" data-status={status} key={status}>
          <b>{countByStatus(props.requirements, status)}</b> {STATUS_LABELS[status]}
        </span>
      ))}
    </>
  );
}

/** At-a-glance counts: connectors by family, requirements per framework. */
export function SummaryStrip() {
  const agentBuilders = TARGET_CONNECTORS.filter(
    (connector) => connector.family === "AGENT_BUILDER",
  ).length;
  const environment = TARGET_CONNECTORS.length - agentBuilders;
  return (
    <div className="summary-strip" aria-label="At-a-glance counts">
      <p className="strip-group" data-testid="connector-counts">
        <span className="strip-label">Connectors</span>
        <span className="strip-led" data-connector-count="AGENT_BUILDER">
          <b>{agentBuilders}</b> simulated agent-builder
        </span>
        <span className="strip-led" data-connector-count="environment">
          <b>{environment}</b> environment
        </span>
      </p>
      {COMPLIANCE_PACKS.map((pack) => (
        <p className="strip-group" key={pack.id} data-pack-counts={pack.id}>
          <span className="strip-label">{PACK_LABELS[pack.id]}</span>
          <StatusCountLeds requirements={pack.requirements} />
        </p>
      ))}
    </div>
  );
}
