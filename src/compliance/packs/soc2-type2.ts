import {
  COMPLIANCE_PACK_DISCLAIMER,
  parseCompliancePack,
} from "../schema.js";

// SOC 2 Type 2 Common Criteria (2017 Trust Services Criteria) with local
// engineering coverage. Control-environment governance and tested
// recovery/availability evidence stay UNKNOWN: they are organizational
// or live-evidence claims this codebase cannot make.
export const SOC2_TYPE2 = parseCompliancePack({
  id: "SOC2_TYPE2",
  version: 1,
  requirements: [
    {
      requirementId: "SOC2-CC6.1",
      title: "Logical access security measures restrict access to authorized users",
      status: "ALIGNED",
      mechanismIds: [
        "LEAST_PRIVILEGE",
        "OPAQUE_SECRET_REFERENCES",
      ],
    },
    {
      requirementId: "SOC2-CC6.6",
      title: "Protection against threats from sources outside system boundaries",
      status: "ALIGNED",
      mechanismIds: [
        "DEFAULT_DENY_EGRESS",
        "NO_CENTRAL_DECRYPTION",
      ],
    },
    {
      requirementId: "SOC2-CC6.7",
      title: "Transmission, movement, and removal of data protected in transit",
      status: "ALIGNED",
      mechanismIds: [
        "CUSTOMER_MANAGED_ENCRYPTION",
        "EVIDENCE_VAULT_AES_256_GCM",
      ],
    },
    {
      requirementId: "SOC2-CC7.2",
      title: "System monitored for anomalies indicative of threats",
      status: "ALIGNED",
      mechanismIds: [
        "OBSERVABILITY_EVENT_BUS",
        "OPA_SECURITY_POLICY",
      ],
    },
    {
      requirementId: "SOC2-CC7.4",
      title: "Security incidents identified, assessed, and responded to",
      status: "GAP",
      mechanismIds: [
        "OBSERVABILITY_EVENT_BUS",
        "GOVERNED_ACTION_REGISTRY",
      ],
    },
    {
      requirementId: "SOC2-CC8.1",
      title: "Changes to system components authorized, tested, and approved",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "HASH_CHAINED_CHANGE_RECORDS",
        "GOVERNED_ACTION_REGISTRY",
      ],
    },
    {
      requirementId: "SOC2-CC1.1",
      title: "Governance and ethical values underpinning the control environment",
      status: "UNKNOWN",
      mechanismIds: [],
    },
    {
      requirementId: "SOC2-A1.3",
      title: "Recovery plan tested against availability objectives",
      status: "UNKNOWN",
      mechanismIds: [
        "PROVIDER_EDGE_RECOVERY",
        "IMMUTABLE_RECOVERY",
      ],
    },
  ],
  disclaimer: COMPLIANCE_PACK_DISCLAIMER,
});
