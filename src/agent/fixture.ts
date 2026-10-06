import type { Thinker } from "./types.js";

export const fixtureThinker: Thinker = async () => ({
  requestId: "fixture-assessment",
  plan: {
    complexity: "HIGH",
    freshDataRequired: false,
    impact: "HIGH",
    verificationRequired: true,
  },
  status: "OK",
  primary: {
    topRisk: "Ownership boundary violation",
    whyItMatters:
      "Brownfield changes must preserve the existing control plane and IaC ownership boundaries.",
    recommendedActions: [
      "Keep proposed changes additive",
      "Validate ownership before preview",
      "Require hash-bound approval",
    ],
    confidence: "HIGH",
    assumptions: [],
  },
  validator: {
    topRisk: "Ownership boundary violation",
    whyItMatters:
      "Existing customer-managed controls must remain authoritative.",
    recommendedActions: [
      "Keep proposed changes additive",
      "Block unknown ownership",
    ],
    confidence: "HIGH",
    assumptions: [],
  },
  adjudication:
    "The independent assessments are materially compatible.",
  durationMs: 1,
});
