import {
  z,
} from "zod";

export const CONTROL_STATUSES = [
  "ALIGNED",
  "GAP",
  "UNKNOWN",
] as const;

export type ControlStatus =
  (typeof CONTROL_STATUSES)[number];

export const COMPLIANCE_PACK_IDS = [
  "HIPAA",
  "PCI_DSS",
  "SOC2_TYPE2",
  "ISO27001",
  "AIUC1",
] as const;

export type CompliancePackId =
  (typeof COMPLIANCE_PACK_IDS)[number];

// The locked control ids from the machine-readable front matter of
// config/security-baseline.md. test/compliance-packs.test.ts re-parses
// that file and fails when this list drifts from the configuration.
export const BASELINE_CONTROL_IDS = [
  "LEAST_PRIVILEGE",
  "OPAQUE_SECRET_REFERENCES",
  "DATA_CLASSIFICATION",
  "DEFAULT_DENY_EGRESS",
  "CUSTOMER_MANAGED_ENCRYPTION",
  "PROVIDER_EDGE_RECOVERY",
  "IMMUTABLE_RECOVERY",
  "NO_CENTRAL_DECRYPTION",
  "ISOLATED_PREVIEW_RESTORE",
  "TAMPER_EVIDENT_EVIDENCE",
  "COMPROMISE_CONTAINMENT",
  "ACT_DISABLED",
] as const;

export type BaselineControlId =
  (typeof BASELINE_CONTROL_IDS)[number];

// Named local evidence mechanisms: engineering artifacts inside this
// repository that a pack requirement can cite when its coverage does
// not come from a single locked control. Each entry names the file a
// reviewer can read to verify the claim; the test suite asserts the
// file still exists.
export const EVIDENCE_MECHANISMS = {
  EVIDENCE_VAULT_AES_256_GCM: {
    source: "src/evidence/vault.ts",
    description: "Local encrypted evidence vault: AES-256-GCM encryption with SHA-256 integrity and 0600 key-file permissions.",
  },
  HASH_CHAINED_CHANGE_RECORDS: {
    source: "src/integration-sim/types.ts",
    description: "SovereignChangeRecord entries carry recordHash and previousRecordHash, forming a tamper-evident evidence chain.",
  },
  GOVERNED_ACTION_REGISTRY: {
    source: "src/actions/registry.ts",
    description: "Four governed operations bound to Ed25519 hash-chained approval leases; no shell execution.",
  },
  OPA_SECURITY_POLICY: {
    source: "policy/opa/security.rego",
    description: "Deterministic security policy evaluator for data-handling and egress allow/deny decisions.",
  },
  QUALIFICATION_MATRIX: {
    source: "src/qualification/full-offline-matrix.ts",
    description: "Deterministic offline qualification matrix producing per-scenario evidence rows.",
  },
  OBSERVABILITY_EVENT_BUS: {
    source: "src/observability/bus.ts",
    description: "Redacted operational event bus with fail-closed export validation and aggregated metrics.",
  },
  ADVERSARIAL_EVALUATION_HARNESS: {
    source: "src/qualification/private-model-adversarial.ts",
    description: "Source-bound adversarial evaluation workflow for private local models.",
  },
  RELEASE_ADMISSION_GATE: {
    source: "src/qualification/release-admission.ts",
    description: "Fail-closed admission gate over source-commit and hashed evidence before any release.",
  },
  LOCAL_OPERATOR_HOST_PINNING: {
    source: "src/operator-ui/server.ts",
    description: "Local operator console binds to 127.0.0.1 behind a nonce CSP, CSRF token, and sanitized output.",
  },
  POLICY_DATA_MINIMIZATION: {
    source: "src/security/policy/minimize.ts",
    description: "Data minimization rules inside the deterministic security policy layer.",
  },
} as const;

export type EvidenceMechanismId =
  keyof typeof EVIDENCE_MECHANISMS;

// The full mechanism vocabulary a requirement may reference: locked
// baseline controls plus named local evidence mechanisms.
export const LOCAL_MECHANISM_IDS = [
  // locked baseline controls
  "LEAST_PRIVILEGE",
  "OPAQUE_SECRET_REFERENCES",
  "DATA_CLASSIFICATION",
  "DEFAULT_DENY_EGRESS",
  "CUSTOMER_MANAGED_ENCRYPTION",
  "PROVIDER_EDGE_RECOVERY",
  "IMMUTABLE_RECOVERY",
  "NO_CENTRAL_DECRYPTION",
  "ISOLATED_PREVIEW_RESTORE",
  "TAMPER_EVIDENT_EVIDENCE",
  "COMPROMISE_CONTAINMENT",
  "ACT_DISABLED",
  // named local evidence mechanisms
  "EVIDENCE_VAULT_AES_256_GCM",
  "HASH_CHAINED_CHANGE_RECORDS",
  "GOVERNED_ACTION_REGISTRY",
  "OPA_SECURITY_POLICY",
  "QUALIFICATION_MATRIX",
  "OBSERVABILITY_EVENT_BUS",
  "ADVERSARIAL_EVALUATION_HARNESS",
  "RELEASE_ADMISSION_GATE",
  "LOCAL_OPERATOR_HOST_PINNING",
  "POLICY_DATA_MINIMIZATION",
] as const;

export type LocalMechanismId =
  (typeof LOCAL_MECHANISM_IDS)[number];

// The speech rule from docs/architecture.md: a pack maps controls and
// evidence to a framework; it never claims compliance. Every pack
// carries this disclaimer verbatim plus any framework-specific note.
export const COMPLIANCE_PACK_DISCLAIMER =
  "Mapping only: selecting this pack does not establish compliance and grants no capability. Statuses describe local engineering mechanisms and evidence, not audit outcomes; certification requires an accredited external audit.";

const packRequirementSchema = z
  .strictObject({
    requirementId: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(CONTROL_STATUSES),
    mechanismIds: z.array(
      z.enum(LOCAL_MECHANISM_IDS),
    ),
    evidencePath: z.string().min(1).optional(),
  })
  .refine(
    (requirement) =>
      requirement.status === "UNKNOWN"
      || requirement.mechanismIds.length >= 1,
    {
      message: "ALIGNED and GAP requirements must reference at least one local mechanism id",
      path: ["mechanismIds"],
    },
  );

const compliancePackSchema = z
  .strictObject({
    id: z.enum(COMPLIANCE_PACK_IDS),
    version: z.number().int().min(1),
    requirements: z
      .array(packRequirementSchema)
      .min(1),
    disclaimer: z.string().min(1),
  })
  .refine(
    (pack) =>
      new Set(
        pack.requirements.map(
          (requirement) => requirement.requirementId,
        ),
      ).size === pack.requirements.length,
    {
      message: "requirementId must be unique within a pack",
      path: ["requirements"],
    },
  );

export type PackRequirement =
  z.infer<typeof packRequirementSchema>;

export type CompliancePack =
  z.infer<typeof compliancePackSchema>;

export function parseCompliancePack(
  input: unknown,
): CompliancePack {
  return compliancePackSchema.parse(input);
}
