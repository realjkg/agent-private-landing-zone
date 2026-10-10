// Wire types and fetch helpers for the operator console's browser bundle.
//
// The two types below mirror the server's shapes (src/operator-ui/server.ts).
// They are deliberate duplicates: importing the server module would pull
// node:http and the whole runtime into the browser bundle. The existing node
// suites assert the server side of these contracts.

export type OperatorMode = "matrix-offline" | "matrix-live" | "aws-review" | "chaos";

export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  title: string;
  evidenceBasis: string;
  output: string;
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
