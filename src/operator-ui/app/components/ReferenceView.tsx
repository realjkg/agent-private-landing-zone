import { CompliancePanels } from "./CompliancePanels";
import { ConnectorGallery } from "./ConnectorGallery";
import { SummaryStrip } from "./SummaryStrip";
import type { ExperienceLevel } from "../../experience-level.js";

/**
 * Connector and compliance detail, Advanced and up. Its own chunk: the
 * connector catalog and requirement rows download only when this area opens.
 */
export default function ReferenceView(props: { level: ExperienceLevel }) {
  return (
    <>
      <section className="panel" id="reference" aria-labelledby="reference-title">
        <h2 id="reference-title" tabIndex={-1}>Reference</h2>
        <p>What the simulated connectors cover and how the safeguards map to each framework.</p>
        <SummaryStrip />
      </section>
      <ConnectorGallery level={props.level} />
      <CompliancePanels level={props.level} />
    </>
  );
}
