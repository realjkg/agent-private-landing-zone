import type { JobState } from "./api.js";
import { BLOCK_REASON_NEXT_STEPS } from "./block-reasons.js";

/**
 * Plain-language status lines for the Beginner surface. Translates, never
 * hides: every status has an honest sentence, matching D1's speech rules.
 */
export const BEGINNER_STATUS_LINES: Record<JobState["status"], string> = {
  IDLE: "Ready",
  RUNNING: "Running — this may take a few minutes",
  PASS: "Finished — this check passed safely",
  BLOCKED: "This check could not run — switch to Advanced for the technical reason",
};

/**
 * A resilience PASS means the simulated faults were caught — not that backups
 * can really be restored, which this workspace never tests. The beginner line
 * says both, so "passed" is never read as "recovery proven".
 */
export const RESILIENCE_PASS_LINE =
  "Finished — every simulated fault was caught. Real backup recovery was not tested.";

/** Shown instead of the "switch to Advanced" line where the bounded result text is already on screen. */
const BLOCKED_DETAILS_BELOW = "This check could not run — the reason is shown below.";

/** The one Beginner sentence for a job state. `resultShown` means the output is rendered beside it. */
export function beginnerStatusLine(job: JobState | null, resultShown = false): string {
  if (!job) return BEGINNER_STATUS_LINES.IDLE;
  if (job.status === "PASS" && job.recoveryVerification !== undefined) return RESILIENCE_PASS_LINE;
  if (job.status === "BLOCKED" && job.blockReason) {
    return "This check could not run. " + BLOCK_REASON_NEXT_STEPS[job.blockReason];
  }
  if (job.status === "BLOCKED" && resultShown) return BLOCKED_DETAILS_BELOW;
  return BEGINNER_STATUS_LINES[job.status];
}
