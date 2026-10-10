import { COMPLIANCE_PACKS } from "../../../compliance/packs/index.js";
import { COMPLIANCE_PACK_DISCLAIMER } from "../../../compliance/schema.js";
import { PACK_LABELS } from "../compliance-labels.js";

/**
 * The Beginner compliance surface (spec mode matrix, D3 row): one
 * plain-language posture line naming the frameworks and what the statuses
 * mean, plus the pack disclaimer in full. No requirement rows, no control
 * ids, no statuses — the Beginner DOM ceiling applies.
 */
export function CompliancePosture() {
  const frameworks = COMPLIANCE_PACKS.map((pack) => PACK_LABELS[pack.id]).join(", ");
  return (
    <section className="panel beginner-only" aria-label="Compliance posture">
      <h2>Compliance posture</h2>
      <p className="beginner-proof" role="status" aria-live="polite">
        This workspace maps its safeguards to {COMPLIANCE_PACKS.length} frameworks — {frameworks} — and
        shows where coverage is proven, incomplete, or unknown.
      </p>
      <p>
        <small>{COMPLIANCE_PACK_DISCLAIMER}</small>
      </p>
    </section>
  );
}
