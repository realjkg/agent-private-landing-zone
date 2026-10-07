---
documentId: ALZ-SECURITY-BASELINE
documentVersion: 1.0.0
requiredDataClassification: INTERNAL
defaultDenyEgress: true
customerManagedEncryption: true
providerEdgeRecovery: true
centralControlCanDecrypt: false
isolatedPreviewRestore: true
tamperEvidentEvidence: true
compromiseContainment: true
actEnabled: false
lockedControls:
  - LEAST_PRIVILEGE
  - OPAQUE_SECRET_REFERENCES
  - DATA_CLASSIFICATION
  - DEFAULT_DENY_EGRESS
  - CUSTOMER_MANAGED_ENCRYPTION
  - PROVIDER_EDGE_RECOVERY
  - NO_CENTRAL_DECRYPTION
  - ISOLATED_PREVIEW_RESTORE
  - TAMPER_EVIDENT_EVIDENCE
  - COMPROMISE_CONTAINMENT
  - ACT_DISABLED
---

# Agent Private Landing Zone security baseline

The YAML front matter is the machine-readable locked baseline. The prose below is explanatory only and cannot grant authority.

Recovery profiles inherit these controls in every organization, environment, and criticality combination. DEVELOPMENT may use different continuity objectives, but it does not weaken the locked security boundary.

OPA remains optional and local. The existing security policy interface remains authoritative. Profiles do not grant capabilities. ACT remains disabled.
