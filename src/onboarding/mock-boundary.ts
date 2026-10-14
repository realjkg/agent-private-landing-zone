/**
 * Browser-safe demonstration of the auth/approval denial boundary.
 * These are fabricated statuses, never requests or credentials. Even a
 * successful mock check and a human-approval fixture cannot activate ACT.
 */
export const MOCK_AUTH_CHOICES = ["NOT_REQUESTED", "VALID_FIXTURE", "EXPIRED_FIXTURE", "WRONG_SCOPE_FIXTURE", "DENIED_FIXTURE"] as const;
export const MOCK_ACT_CHOICES = ["NONE", "NO_APPROVAL", "HUMAN_APPROVAL_FIXTURE", "MODEL_REQUEST_FIXTURE"] as const;
export type MockAuth = typeof MOCK_AUTH_CHOICES[number];
export type MockActRequest = typeof MOCK_ACT_CHOICES[number];

export function mockBoundary(auth: MockAuth, act: MockActRequest): {
  authResult: "NOT_ATTEMPTED" | "SYNTHETIC_AUTH_OK" | "SYNTHETIC_AUTH_REJECTED";
  approvalResult: "NOT_REQUESTED" | "MISSING" | "HUMAN_FIXTURE_ONLY" | "MODEL_HAS_NO_AUTHORITY";
  infrastructureResult: "DENIED_ACT_DISABLED";
  evidence: "SYNTHETIC_NOT_QUALIFIED";
} {
  if (!MOCK_AUTH_CHOICES.includes(auth) || !MOCK_ACT_CHOICES.includes(act)) throw new Error("MOCK_BOUNDARY_INPUT_INVALID");
  const authResult = auth === "NOT_REQUESTED" ? "NOT_ATTEMPTED" as const :
    auth === "VALID_FIXTURE" ? "SYNTHETIC_AUTH_OK" as const : "SYNTHETIC_AUTH_REJECTED" as const;
  const approvalResult = act === "NONE" ? "NOT_REQUESTED" as const :
    act === "NO_APPROVAL" ? "MISSING" as const :
    act === "HUMAN_APPROVAL_FIXTURE" ? "HUMAN_FIXTURE_ONLY" as const : "MODEL_HAS_NO_AUTHORITY" as const;
  return { authResult, approvalResult, infrastructureResult: "DENIED_ACT_DISABLED",
    evidence: "SYNTHETIC_NOT_QUALIFIED" };
}
