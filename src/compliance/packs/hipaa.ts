import {
  COMPLIANCE_PACK_DISCLAIMER,
  parseCompliancePack,
} from "../schema.js";

// HIPAA Security Rule requirements that local engineering controls can
// speak to. Administrative and organizational safeguards stay UNKNOWN:
// this repository cannot establish workforce process, and saying so is
// the honest mapping.
export const HIPAA = parseCompliancePack({
  id: "HIPAA",
  version: 1,
  requirements: [
    {
      requirementId: "HIPAA-SR-164.312(a)(1)",
      title: "Access control",
      status: "ALIGNED",
      mechanismIds: [
        "LEAST_PRIVILEGE",
        "OPAQUE_SECRET_REFERENCES",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.312(a)(2)(iv)",
      title: "Encryption and decryption of electronic protected health information at rest",
      status: "ALIGNED",
      mechanismIds: [
        "CUSTOMER_MANAGED_ENCRYPTION",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.312(b)",
      title: "Audit controls",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "HASH_CHAINED_CHANGE_RECORDS",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.312(c)(1)",
      title: "Integrity of electronic protected health information",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.312(d)",
      title: "Person or entity authentication",
      status: "GAP",
      mechanismIds: [
        "GOVERNED_ACTION_REGISTRY",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.312(e)(1)",
      title: "Transmission security",
      status: "ALIGNED",
      mechanismIds: [
        "DEFAULT_DENY_EGRESS",
        "LOCAL_OPERATOR_HOST_PINNING",
      ],
    },
    {
      requirementId: "HIPAA-SR-164.308(a)(1)",
      title: "Security management process",
      status: "UNKNOWN",
      mechanismIds: [],
    },
    {
      requirementId: "HIPAA-SR-164.308(a)(5)",
      title: "Security awareness and training",
      status: "UNKNOWN",
      mechanismIds: [],
    },
  ],
  disclaimer: COMPLIANCE_PACK_DISCLAIMER,
});
