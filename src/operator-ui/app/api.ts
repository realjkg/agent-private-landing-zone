// Wire types and fetch helpers for the operator console's browser bundle.
//
// The two types below mirror the server's shapes (src/operator-ui/server.ts).
// They are deliberate duplicates: importing the server module would pull
// node:http and the whole runtime into the browser bundle. The existing node
// suites assert the server side of these contracts.

export type OperatorMode = "matrix-offline" | "matrix-live" | "aws-review" | "chaos";

export type RecoveryVerificationStatus = "VERIFIED" | "PARTIAL" | "BLOCKED" | "NOT_REPORTED";

export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  title: string;
  evidenceBasis: string;
  output: string;
  /** Resilience runs only (see server.ts): the run's own recovery verification. */
  recoveryVerification?: RecoveryVerificationStatus;
};

/** Mirrors src/operator-ui/model-availability.ts. */
export type ModelAvailability = {
  status: "AVAILABLE" | "UNAVAILABLE";
  reason:
    | "READY"
    | "LIVE_MODELS_DISABLED"
    | "MODEL_ENDPOINT_NOT_LOOPBACK"
    | "NO_LOCAL_MODEL_SERVER"
    | "MODEL_INVENTORY_UNAVAILABLE"
    | "MODELS_NOT_INSTALLED";
  required: string[];
  missing: string[];
};

export type RunRequest = {
  mode: OperatorMode;
  scenario: string;
  token: string;
};

export type RunOutcome = {
  accepted: boolean;
  error?: string;
};

/** Poll the local operator's job state. Null means the session is unreachable. */
export async function fetchJobState(): Promise<JobState | null> {
  try {
    const response = await fetch("/state", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as JobState;
  } catch {
    return null;
  }
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Ask the local operator whether the private-model workflows can run here.
 * Null means unknown (unreachable or unrecognized answer): the console then
 * leaves those workflows offered, exactly as before this check existed.
 */
export async function fetchModelAvailability(): Promise<ModelAvailability | null> {
  try {
    const response = await fetch("/models", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ModelAvailability>;
    if ((body.status !== "AVAILABLE" && body.status !== "UNAVAILABLE") ||
      typeof body.reason !== "string" || !isStringList(body.required) ||
      !isStringList(body.missing)) {
      return null;
    }
    return body as ModelAvailability;
  } catch {
    return null;
  }
}

/**
 * POST a governed workflow run. The body carries exactly mode, scenario and
 * the CSRF token — the experience level never leaves the browser, so server
 * validation is identical at every disclosure depth.
 */
export async function requestRun(request: RunRequest): Promise<RunOutcome> {
  try {
    const response = await fetch("/run", {
      method: "POST",
      body: new URLSearchParams({
        mode: request.mode,
        scenario: request.scenario,
        token: request.token,
      }),
    });
    if (response.ok) return { accepted: true };
    const item = (await response.json().catch(() => null)) as { error?: string } | null;
    return { accepted: false, error: item?.error ?? "Request denied" };
  } catch {
    return { accepted: false, error: "Cannot reach local operator" };
  }
}
