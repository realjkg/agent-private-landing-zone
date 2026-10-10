import {
  COMPLIANCE_PACK_DISCLAIMER,
  parseCompliancePack,
} from "../schema.js";

// AIUC-1 v1.0 mapped first-party across its six risk domains: Data &
// Privacy, Security, Safety, Reliability, Accountability, Society.
// The live-evidence row stays UNKNOWN: qualification on real private
// hardware has not been executed, and fixtures must never count as
// live proof.
export const AIUC1 = parseCompliancePack({
  id: "AIUC1",
  version: 1,
  requirements: [
    {
      requirementId: "AIUC1-DP-1",
      title: "Data and Privacy — agent secrets held as opaque references, never plaintext",
      status: "ALIGNED",
      mechanismIds: [
        "OPAQUE_SECRET_REFERENCES",
        "DEFAULT_DENY_EGRESS",
      ],
    },
    {
      requirementId: "AIUC1-DP-2",
      title: "Data and Privacy — personal data minimized before it reaches model context",
      status: "ALIGNED",
      mechanismIds: [
        "POLICY_DATA_MINIMIZATION",
        "DATA_CLASSIFICATION",
      ],
    },
    {
      requirementId: "AIUC1-SEC-1",
      title: "Security — private-model behavior evaluated adversarially, not only on happy paths",
      status: "ALIGNED",
      mechanismIds: [
        "ADVERSARIAL_EVALUATION_HARNESS",
        "COMPROMISE_CONTAINMENT",
      ],
      evidencePath: "docs/private-model-adversarial.md",
    },
    {
      requirementId: "AIUC1-SAF-1",
      title: "Safety — agent actions pass deterministic policy gating before any execution",
      status: "ALIGNED",
      mechanismIds: [
        "OPA_SECURITY_POLICY",
        "ACT_DISABLED",
      ],
    },
    {
      requirementId: "AIUC1-REL-1",
      title: "Reliability — agent behavior qualified against a repeatable scenario matrix",
      status: "ALIGNED",
      mechanismIds: [
        "QUALIFICATION_MATRIX",
      ],
      evidencePath: "docs/private-agent-matrix.md",
    },
    {
      requirementId: "AIUC1-REL-2",
      title: "Reliability — live qualification evidence on target hardware",
      status: "UNKNOWN",
      mechanismIds: [],
    },
    {
      requirementId: "AIUC1-ACC-1",
      title: "Accountability — tamper-evident audit trail with fail-closed release admission",
      status: "ALIGNED",
      mechanismIds: [
        "TAMPER_EVIDENT_EVIDENCE",
        "HASH_CHAINED_CHANGE_RECORDS",
        "RELEASE_ADMISSION_GATE",
      ],
      evidencePath: "docs/production-release-admission.md",
    },
    {
      requirementId: "AIUC1-SOC-1",
      title: "Society — deployment scope stays local with no external transmission surface",
      status: "ALIGNED",
      mechanismIds: [
        "DEFAULT_DENY_EGRESS",
        "LOCAL_OPERATOR_HOST_PINNING",
      ],
    },
  ],
  disclaimer: COMPLIANCE_PACK_DISCLAIMER,
});
