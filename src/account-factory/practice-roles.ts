/**
 * Practice role is an operator-experience classification, NEVER AWS authority.
 * Live STS identity, scoped AWS permission and per-customer approvals govern provisioning.
 */
export const PRACTICE_ROLES = [
  {
    id: "MODERN_PLATFORMS_PRESALES",
    label: "Modern Platforms · Presales",
    focus: "Demonstrate the customer's governed DEV landing zone and document its distinctive platform choices.",
    prerequisites: [
      "Customer sponsor approves this specific DEV account and demonstration scope.",
      "Named practitioner has a currently valid customer-authorized AWS administrator or account-vending session.",
      "Customer account email and DEV owner are assigned; data residency and solution assumptions are reviewed.",
      "Account-specific financial owner has approved potential AWS charges and budget notifications.",
    ],
    handoff: "Record a customer-specific architecture and cost blueprint for the delivery team.",
  },
  {
    id: "MODERN_PLATFORMS_DELIVERY",
    label: "Modern Platforms · Delivery",
    focus: "Provision the customer DEV foundation, validate existing Control Tower guardrails and hand off operational evidence.",
    prerequisites: [
      "Customer scope and DEV design are approved by the delivery owner.",
      "Named practitioner has a currently valid customer-authorized AWS administrator or account-vending session.",
      "Dedicated account email, Identity Center DEV owner and Workloads OU are agreed.",
      "Financial approval is recorded and post-provision evidence ownership is assigned.",
    ],
    handoff: "Give Digital Operations verified account ID, OU/baseline evidence and the exception register.",
  },
  {
    id: "DIGITAL_PRESALES",
    label: "Digital · Presales",
    focus: "Demonstrate customer-specific digital workloads on an isolated, governed DEV account.",
    prerequisites: [
      "Customer sponsor authorizes a nonproduction demonstration and permitted datasets.",
      "Named practitioner has a currently valid customer-authorized AWS administrator or account-vending session.",
      "Digital solution requirements and security boundaries are reviewed with Modern Platforms.",
      "Distinct DEV owner, account email, approved spending and evidence retention are identified.",
    ],
    handoff: "Share the solution blueprint, workload boundaries and cost assumptions with Delivery.",
  },
  {
    id: "DIGITAL_DELIVERY",
    label: "Digital · Delivery",
    focus: "Establish and validate a guarded customer DEV account for an approved digital workload.",
    prerequisites: [
      "Customer DEV workload scope and deployment ownership are accepted.",
      "Named practitioner has a currently valid customer-authorized AWS administrator or account-vending session.",
      "Platform governance alignment, account email, access requirements and data classification are reviewed.",
      "Owner-approved costs, monitoring responsibility and post-provision acceptance criteria are recorded.",
    ],
    handoff: "Transfer account evidence, workload runbooks and operational ownership to Digital Operations.",
  },
] as const;

export type PracticeRole = typeof PRACTICE_ROLES[number]["id"];
export function isPracticeRole(value: unknown): value is PracticeRole {
  return typeof value === "string" && PRACTICE_ROLES.some(role => role.id === value);
}
export const COMMON_DEV_GATES = [
  "Verified, non-root customer-specific AWS execution identity and effective Account Factory access",
  "Correct customer organization, healthy Control Tower landing zone and permitted organizational unit",
  "Unique owner-controlled account email, named Identity Center administrator and account purpose",
  "Exact request review, separate customer/financial authorization and explicit cost exposure",
  "Service Catalog submission receipt, independent active account/OU/baseline read-back",
  "No implicit QA/PROD promotion, Terraform APPLY, or infrastructure ACT authorization",
] as const;
