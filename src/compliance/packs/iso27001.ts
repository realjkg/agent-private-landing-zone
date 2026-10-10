import {
  COMPLIANCE_PACK_DISCLAIMER,
  parseCompliancePack,
} from "../schema.js";

// ISO/IEC 27001:2022 Annex A controls with local engineering coverage.
// Backup stays a GAP: the architecture doc is explicit that the local
// evidence vault must never be represented as provider-native backup
// proof. Incident management is an organizational process (UNKNOWN).
export const ISO27001 = parseCompliancePack({
  id: "ISO27001",
  version: 2022,
  requirements: [
    {
      requirementId: "ISO27001-A.5.15",
      title: "Access control and least-privilege restriction",
      status: "ALIGNED",
      mechanismIds: [
        "LEAST_PRIVILEGE",
        "DATA_CLASSIFICATION",
      ],
    },
    {
      requirementId: "ISO27001-A.5.17",
      title: "Authentication information protected as opaque references",
      status: "ALIGNED",
      mechanismIds: [
        "OPAQUE_SECRET_REFERENCES",
      ],
    },
    {
      requirementId: "ISO27001-A.5.12",
      title: "Classification of information",
      status: "ALIGNED",
      mechanismIds: [
        "DATA_CLASSIFICATION",
      ],
    },
    {
      requirementId: "ISO27001-A.5.14",
      title: "Information transfer restricted to protected channels",
      status: "ALIGNED",
      mechanismIds: [
        "DEFAULT_DENY_EGRESS",
        "NO_CENTRAL_DECRYPTION",
      ],
    },
    {
      requirementId: "ISO27001-A.8.24",
      title: "Use of cryptography",
      status: "ALIGNED",
      mechanismIds: [
        "CUSTOMER_MANAGED_ENCRYPTION",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "ISO27001-A.8.15",
      title: "Logging protected against tampering",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "HASH_CHAINED_CHANGE_RECORDS",
      ],
    },
    {
      requirementId: "ISO27001-A.8.16",
      title: "Monitoring activities recording anomalous behavior",
      status: "ALIGNED",
      mechanismIds: [
        "OBSERVABILITY_EVENT_BUS",
        "COMPROMISE_CONTAINMENT",
      ],
    },
    {
      requirementId: "ISO27001-A.8.13",
      title: "Information backup and restore capability",
      status: "GAP",
      mechanismIds: [
        "PROVIDER_EDGE_RECOVERY",
        "IMMUTABLE_RECOVERY",
        "ISOLATED_PREVIEW_RESTORE",
      ],
    },
    {
      requirementId: "ISO27001-A.5.24",
      title: "Information security incident management planning and operations",
      status: "UNKNOWN",
      mechanismIds: [],
    },
  ],
  disclaimer: COMPLIANCE_PACK_DISCLAIMER,
});
