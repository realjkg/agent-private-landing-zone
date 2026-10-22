import { useState } from "react";

import {
  readProtectionDismissed,
  storeProtectionDismissed,
} from "../protection-storage.js";

/**
 * Beginner safety summary. Short labels stay visible; optional native
 * disclosures provide details without hiding safety or release boundaries.
 */
export function ProtectionCard() {
  const [dismissed, setDismissed] = useState(readProtectionDismissed);
  if (dismissed) return null;
  return (
    <section
      className="panel beginner-only protection-card"
      aria-label="Safety"
    >
      <div className="protection-head">
        <h2>Safety</h2>
        <button
          type="button"
          className="protection-dismiss"
          onClick={() => {
            storeProtectionDismissed();
            setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </div>
      <ul className="protection-points">
        <li>
          <strong>Local session</strong>
          <details>
            <summary>Details</summary>
            <p>The console connects only to localhost on this machine.</p>
          </details>
        </li>
        <li>
          <strong>Sample evidence</strong>
          <details>
            <summary>Details</summary>
            <p>These runs use recorded test data, not live cloud evidence.</p>
          </details>
        </li>
        <li>
          <strong>Changes disabled</strong>
          <details>
            <summary>Details</summary>
            <p>Infrastructure changes are off by default. The separate pilot requires owner authorization, approvals, and a person to confirm each change.</p>
          </details>
        </li>
      </ul>
    </section>
  );
}
