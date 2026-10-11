import { lazy, Suspense, useState } from "react";

import type { OperationsViewProps } from "./OperationsView";

// The catalog UI is its own chunk: it downloads when the section is shown.
const OperationsView = lazy(() => import("./OperationsView"));

/**
 * The console's mount point for every catalog operation. Advanced and Expert
 * load it straight away; Beginner keeps the short page until asked, unless the
 * caller is already showing it as its own area (`eager`).
 */
export function OperationsEntry(props: OperationsViewProps & { eager?: boolean }) {
  const { eager, ...view } = props;
  const [asked, setAsked] = useState(false);
  const show = asked || eager || props.level !== "BEGINNER";
  return (
    <section className="panel" id="operations" aria-labelledby="operations-title">
      <h2 id="operations-title" tabIndex={-1}>All operations</h2>
      {show ? (
        <Suspense fallback={<p role="status">Loading operations…</p>}>
          <OperationsView {...view} />
        </Suspense>
      ) : (
        <>
          <p>Browse every check this workspace can run or explain, grouped by topic.</p>
          <button type="button" onClick={() => setAsked(true)}>Browse all operations</button>
        </>
      )}
    </section>
  );
}
