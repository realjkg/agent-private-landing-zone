import {
  COMPLIANCE_PACK_DISCLAIMER,
  parseCompliancePack,
} from "../schema.js";

// PCI DSS v4.0 requirements with local engineering coverage. External
// scanning and organizational incident-response process stay UNKNOWN:
// an ASV scan or a written program cannot be produced by this codebase.
export const PCI_DSS = parseCompliancePack({
  id: "PCI_DSS",
  version: 4,
  requirements: [
    {
      requirementId: "PCI-DSS-4-3.5.1",
      title: "Stored account data rendered unreadable",
      status: "ALIGNED",
      mechanismIds: [
        "CUSTOMER_MANAGED_ENCRYPTION",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "PCI-DSS-4-3.7",
      title: "Protection of cryptographic keys against disclosure and misuse",
      status: "ALIGNED",
      mechanismIds: [
        "CUSTOMER_MANAGED_ENCRYPTION",
        "NO_CENTRAL_DECRYPTION",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "PCI-DSS-4-4.2.1",
      title: "Strong cryptography for transmissions over public networks",
      status: "ALIGNED",
      mechanismIds: [
        "DEFAULT_DENY_EGRESS",
        "LOCAL_OPERATOR_HOST_PINNING",
      ],
    },
    {
      requirementId: "PCI-DSS-4-7.2",
      title: "Access restricted by least privilege",
      status: "ALIGNED",
      mechanismIds: [
        "LEAST_PRIVILEGE",
        "OPAQUE_SECRET_REFERENCES",
      ],
    },
    {
      requirementId: "PCI-DSS-4-10.2",
      title: "Audit logging of access to system components and account data",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "HASH_CHAINED_CHANGE_RECORDS",
      ],
    },
    {
      requirementId: "PCI-DSS-4-10.5",
      title: "Retained and protected audit log history",
      status: "ALIGNED",
      mechanismIds: [
        "IMMUTABLE_RECOVERY",
        "TAMPER_EVIDENT_EVIDENCE",
      ],
    },
    {
      requirementId: "PCI-DSS-4-11.3.2",
      title: "External vulnerability scans performed by an approved scanning vendor",
      status: "UNKNOWN",
      mechanismIds: [],
    },
    {
      requirementId: "PCI-DSS-4-12.10.1",
      title: "Documented incident response plan",
      status: "UNKNOWN",
      mechanismIds: [],
    },
  ],
  disclaimer: COMPLIANCE_PACK_DISCLAIMER,
});
