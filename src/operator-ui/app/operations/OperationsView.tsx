import { useEffect, useState } from "react";

import type { ExperienceLevel } from "../../experience-level.js";
import { FAMILIES, FAMILY_TITLES, type Family } from "../../../operations/types.js";
import { fetchOperations, type JobState, type ModelAvailability, type OperationDescriptor } from "../api";
import { prefersReducedMotion, scrollBehaviorFor, scrollIntoViewSafe } from "../motion";
import { OperationCard } from "./OperationCard";
import "./operations.css";

export type OperationsViewProps = {
  level: ExperienceLevel;
  csrfToken: string;
  jobState: JobState | null;
  /** A run is in flight anywhere in the console. */
  busy: boolean;
  onRefresh: () => Promise<void> | void;
  /** Advisory model availability from GET /models; null when unknown. */
  modelAvailability?: ModelAvailability | null;
};

/** Every catalog operation, grouped by family. Loaded on demand as its own chunk. */
export default function OperationsView(props: OperationsViewProps) {
  const [operations, setOperations] = useState<OperationDescriptor[] | null | "loading">("loading");
  const [family, setFamily] = useState<Family | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    void fetchOperations().then(setOperations);
  }, []);

  const loaded = Array.isArray(operations) ? operations : [];
  const families = FAMILIES.filter((name) => loaded.some((spec) => spec.family === name));
  const current = family ?? families[0];

  // Opening a viewer from a handoff card may switch family; focus the card once it renders.
  useEffect(() => {
    if (!focusId) return;
    const title = document.getElementById("op-" + focusId + "-title");
    if (!title) return;
    scrollIntoViewSafe(title, scrollBehaviorFor(prefersReducedMotion()));
    title.focus();
    setFocusId(null);
  }, [focusId, current]);

  if (operations === "loading") return <p role="status">Loading operations…</p>;
  if (operations === null) return <p role="alert">The operation list could not be loaded from the local console.</p>;
  if (!current) return <p>No operations are available.</p>;

  const open = (id: string) => {
    const target = loaded.find((spec) => spec.id === id);
    if (target) setFamily(target.family);
    setFocusId(id);
  };

  return (
    <>
      <nav className="levels op-families" role="group" aria-label="Operation families">
        {families.map((name) => (
          <button key={name} type="button" aria-pressed={name === current} onClick={() => setFamily(name)}>
            {FAMILY_TITLES[name]}
          </button>
        ))}
      </nav>
      <div className="op-list">
        {loaded.filter((spec) => spec.family === current).map((spec) => (
          <OperationCard key={spec.id} spec={spec} level={props.level} csrfToken={props.csrfToken}
            jobState={props.jobState?.operation === spec.id ? props.jobState : null} busy={props.busy}
            onRefresh={props.onRefresh} onOpenViewer={open} modelAvailability={props.modelAvailability} />
        ))}
      </div>
    </>
  );
}
