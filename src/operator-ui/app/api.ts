// Wire types and fetch helpers for the operator console's browser bundle.
//
// The two types below mirror the server's shapes (src/operator-ui/server.ts).
// They are deliberate duplicates: importing the server module would pull
// node:http and the whole runtime into the browser bundle. The existing node
// suites assert the server side of these contracts.

import type { OperationDescriptor } from "../../operations/types.js";

export type { OperationDescriptor };

export type OperatorMode = "matrix-offline" | "matrix-live" | "aws-review" | "chaos";

export type RecoveryVerificationStatus = "VERIFIED" | "PARTIAL" | "BLOCKED" | "NOT_REPORTED";

export type JobState = {
  status: "IDLE" | "RUNNING" | "PASS" | "BLOCKED";
  /** Id of the operation that produced this state (see server.ts). */
  operation?: string;
  title: string;
  evidenceBasis: string;
  output: string;
  /** Resilience runs only (see server.ts): the run's own recovery verification. */
  recoveryVerification?: RecoveryVerificationStatus;
  /** Blocked runs only, when the cause is a known local setup state. */
  blockReason?: BlockReason;
};

/** Mirrors BlockReason in src/operator-ui/server.ts. */
export type BlockReason = "SOURCE_WORKTREE_DIRTY" | "WORKSPACE_NEEDS_BUILD";

/** Mirrors src/operator-ui/model-availability.ts. */
export type ModelAvailability = {
  status: "AVAILABLE" | "UNAVAILABLE";
  reason:
    | "READY"
    | "LIVE_MODELS_DISABLED"
    | "MODEL_ENDPOINT_NOT_LOOPBACK"
    | "NO_LOCAL_MODEL_SERVER"
    | "MODEL_INVENTORY_UNAVAILABLE"
    | "MODELS_NOT_INSTALLED"
    | "MODEL_DIGEST_UNPINNED"
    | "MODEL_DIGEST_MISMATCH";
  required: string[];
  missing: string[];
};

/** True when a poll brought nothing new, so the console can skip a re-render. */
export function sameJobState(a: JobState | null, b: JobState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.status === b.status && a.operation === b.operation && a.title === b.title &&
    a.evidenceBasis === b.evidenceBasis && a.output === b.output &&
    a.recoveryVerification === b.recoveryVerification && a.blockReason === b.blockReason;
}

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

async function postRun(body: URLSearchParams): Promise<RunOutcome> {
  try {
    const response = await fetch("/run", { method: "POST", body });
    if (response.ok) return { accepted: true };
    const item = (await response.json().catch(() => null)) as { error?: string } | null;
    return { accepted: false, error: item?.error ?? "Request denied" };
  } catch {
    return { accepted: false, error: "Cannot reach local operator" };
  }
}

/**
 * POST a governed workflow run. The body carries exactly mode, scenario and
 * the CSRF token — the experience level never leaves the browser, so server
 * validation is identical at every disclosure depth.
 */
export function requestRun(request: RunRequest): Promise<RunOutcome> {
  return postRun(new URLSearchParams({
    mode: request.mode,
    scenario: request.scenario,
    token: request.token,
  }));
}

/** POST a catalog operation: its id, its inputs as JSON text, and the CSRF token. */
export function requestOperationRun(request: {
  operation: string;
  inputs: Record<string, string | boolean>;
  token: string;
}): Promise<RunOutcome> {
  return postRun(new URLSearchParams({
    operation: request.operation,
    inputs: JSON.stringify(request.inputs),
    token: request.token,
  }));
}

/** The catalog's public descriptors. Null means unreachable or unrecognized. */
export async function fetchOperations(): Promise<OperationDescriptor[] | null> {
  try {
    const response = await fetch("/operations", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as OperationDescriptor[]) : null;
  } catch {
    return null;
  }
}
