import { useState } from "react";

import {
  readProtectionDismissed,
  storeProtectionDismissed,
} from "../protection-storage.js";

/**
 * The one-time "how this workspace protects you" card (UX depth pass,
 * Beginner only). Three honest bullets about what this console can and
 * cannot do; dismissed once, remembered per operator, and never shown again
 * unless storage is cleared. Dismissal is a presentation preference only —
 * it hides no status, evidence, or disclaimer content (the beginner
 * compliance posture with its disclaimer renders independently).
 */
export function ProtectionCard() {
  const [dismissed, setDismissed] = useState(readProtectionDismissed);
  if (dismissed) return null;
  return (
    <section
      className="panel beginner-only protection-card"
      aria-label="How this workspace protects you"
    >
      <div className="protection-head">
        <h2>How this workspace protects you</h2>
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
        <li>Runs stay on this machine — the console talks only to localhost.</li>
        <li>
          Evidence is synthetic — runs use recorded fixtures, never your real cloud.
        </li>
        <li>
          Nothing changes without you — infrastructure ACT is permanently disabled.
        </li>
      </ul>
    </section>
  );
}
