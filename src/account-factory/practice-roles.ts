/**
 * Internal practice affiliation guides the customer experience, not AWS IAM.
 * Anyone in these practices can use their organization's existing AWS access.
 */
export const PRACTICE_ROLES = [
  {
    id: "MODERN_PLATFORMS_PRESALES",
    label: "Modern Platforms · Presales",
    focus: "Demonstrate a customer-specific, governed DEV platform.",
    prerequisites: [
      "Use an existing AWS SSO profile with access to the customer's Control Tower Account Factory.",
      "Have a unique email for the DEV account and a named administrator for the account.",
      "Know which DEV architecture and baseline capabilities you want to demonstrate.",
    ],
    handoff: "Share the environment's architecture and account details with Delivery.",
  },
  {
    id: "MODERN_PLATFORMS_DELIVERY",
    label: "Modern Platforms · Delivery",
    focus: "Create the customer DEV platform using its existing landing-zone guardrails.",
    prerequisites: [
      "Use the AWS SSO profile for the customer's existing Control Tower management account.",
      "Provide the DEV account name, unique email and administrator contact.",
      "Record the resulting account ID and existing baseline for ongoing support.",
    ],
    handoff: "Share account ID, OU, baseline and setup notes with Digital Operations.",
  },
  {
    id: "DIGITAL_PRESALES",
    label: "Digital · Presales",
    focus: "Demonstrate digital solutions on a dedicated customer DEV account.",
    prerequisites: [
      "Use an AWS SSO profile that can access the customer's existing Account Factory.",
      "Supply a unique DEV account email and a named administrator.",
      "Identify sample workloads and data that are suitable for a nonproduction demonstration.",
    ],
    handoff: "Share the digital solution blueprint and environment details with Delivery.",
  },
  {
    id: "DIGITAL_DELIVERY",
    label: "Digital · Delivery",
    focus: "Establish a dedicated, governed DEV environment for digital workloads.",
    prerequisites: [
      "Use an AWS SSO profile with the necessary existing Service Catalog permissions.",
      "Provide the unique member-account email, account owner and workload name.",
      "Share the account ID, baseline and maintenance notes with the digital operations team.",
    ],
    handoff: "Transfer the environment record and workload runbook to Digital Operations.",
  },
] as const;
export type PracticeRole = typeof PRACTICE_ROLES[number]["id"];
export function isPracticeRole(value: unknown): value is PracticeRole {
  return typeof value === "string" && PRACTICE_ROLES.some(x => x.id === value);
}
export const COMMON_DEV_GATES = [
  "Sign in with an existing named AWS SSO profile; AWS IAM decides if Account Factory is permitted",
  "Select DEV, QA, STAGING or PROD and supply a unique account name and email",
  "Reuse the organization's discovered Control Tower landing zone and an enabled organizational unit",
  "Review and confirm the exact account before creating it; AWS accounts may incur charges",
  "Read the Account Factory status and resulting member-account ID for handoff",
] as const;
