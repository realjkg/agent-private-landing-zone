import type { JobState } from "../api";

type LedStatus = JobState["status"] | "UNAVAILABLE";

const STATUS_LED_LABELS: Record<LedStatus, string> = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PASS: "PASS",
  BLOCKED: "BLOCKED",
  UNAVAILABLE: "Local session unavailable",
};

/**
 * LED-style status readout. The label stays the literal job status — the LED
 * dot is presentation chrome and never decorates or replaces the
 * classification.
 */
export function StatusLed(props: { status: LedStatus }) {
  return (
    <p className="led" data-status={props.status} role="status" aria-live="polite">
      <span className="led-dot" aria-hidden="true" />
      <span className="led-label">{STATUS_LED_LABELS[props.status]}</span>
    </p>
  );
}
