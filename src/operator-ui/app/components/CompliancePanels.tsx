import type { ExperienceLevel } from "../../experience-level.js";
import { COMPLIANCE_PACKS } from "../../../compliance/packs/index.js";
import {
  COMPLIANCE_PACK_DISCLAIMER,
  EVIDENCE_MECHANISMS,
  type CompliancePack,
  type EvidenceMechanismId,
  type LocalMechanismId,
  type PackRequirement,
} from "../../../compliance/schema.js";
import { StatusCountLeds } from "./SummaryStrip";
import { PACK_LABELS, STATUS_LABELS } from "../compliance-labels.js";

function MechanismReference(props: { id: LocalMechanismId }) {
  const mechanism =
    props.id in EVIDENCE_MECHANISMS ? EVIDENCE_MECHANISMS[props.id as EvidenceMechanismId] : undefined;
  return (
    <li>
      <code>{props.id}</code>{" "}
      <small>
        {mechanism
          ? mechanism.description
          : "locked baseline control — config/security-baseline.md"}
      </small>
    </li>
  );
}

/**
 * One requirement, expandable in place (UX depth pass): the header row —
 * literal status badge, title, requirement id — is always visible; the
 * mapping and mechanism detail collapse beneath it. Native
 * details/summary keeps the collapsed content in the DOM (findable,
 * copyable, test-assertable) with zero script. Expert defaults to open so
 * the full mapping stays first-class at that depth.
 */
function RequirementRow(props: { pack: CompliancePack; requirement: PackRequirement; expert: boolean }) {
  const { requirement } = props;
  const hasEvidence = requirement.mechanismIds.length > 0 || requirement.evidencePath !== undefined;
  return (
    <li
      className="requirement-row"
      data-requirement-id={requirement.requirementId}
      data-status={requirement.status}
    >
      <details className="req-details" open={props.expert}>
        <summary className="req-head">
          <span className="status-badge req-status" data-status={requirement.status}>
            {STATUS_LABELS[requirement.status]}
          </span>
          <span className="req-title">{requirement.title}</span>
          <code>{requirement.requirementId}</code>
        </summary>
        {props.expert && (
          <p className="req-mapping">
            <code>
              {props.pack.id}@{props.pack.version} → {requirement.requirementId} ←{" "}
              {requirement.mechanismIds.length > 0
                ? requirement.mechanismIds.join(" + ")
                : "no local mechanism mapped"}{" "}
              ({STATUS_LABELS[requirement.status]})
            </code>
          </p>
        )}
        {hasEvidence && (
          <ul className="req-mechanisms">
            {requirement.mechanismIds.map((id) => (
              <MechanismReference key={id} id={id} />
            ))}
            {requirement.evidencePath && (
              <li>
                <code>{requirement.evidencePath}</code> <small>local evidence path</small>
              </li>
            )}
          </ul>
        )}
      </details>
    </li>
  );
}

/**
 * Compliance packs surface (Advanced and Expert — spec mode matrix, D3
 * row). Per-framework panels with per-requirement status rows; the
 * disclaimer is rendered inline, zero interactions away. Each framework
 * header carries its own ALIGNED/GAP/UNKNOWN count strip (counts only,
 * never scores); Expert adds the pack version and the explicit
 * requirement-to-control mapping line.
 * Status labels come from STATUS_LABELS keyed by the requirement's own
 * status — an UNKNOWN requirement cannot render an Aligned label.
 */
export function CompliancePanels(props: { level: ExperienceLevel }) {
  const expert = props.level === "EXPERT";
  return (
    <section className="panel advanced-only" id="compliance" aria-label="Compliance packs">
      <h2>Compliance packs</h2>
      <p className="disclaimer">
        <small>{COMPLIANCE_PACK_DISCLAIMER}</small>
      </p>
      {COMPLIANCE_PACKS.map((pack) => (
        <div className="pack" key={pack.id} data-pack-id={pack.id}>
          <h3>
            {PACK_LABELS[pack.id]}
            {expert ? <code> @{pack.version}</code> : ""}
          </h3>
          <p className="pack-counts" data-pack-header-counts={pack.id}>
            <StatusCountLeds requirements={pack.requirements} />
          </p>
          <ul className="pack-requirements">
            {pack.requirements.map((requirement) => (
              <RequirementRow
                key={requirement.requirementId}
                pack={pack}
                requirement={requirement}
                expert={expert}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
