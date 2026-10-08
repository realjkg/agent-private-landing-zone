import type {
  TargetConnector,
  TraceabilityConnector,
} from "./types.js";

export const TARGET_CONNECTORS: TargetConnector[] = [
  {
    id: "AWS",
    family: "ENVIRONMENT",
    status: "IMPLEMENTED",
    substrates: ["aws"],
    notes:
      "Existing read-only AWS provider discovery connector.",
  },
  {
    id: "AZURE",
    family: "ENVIRONMENT",
    status: "IMPLEMENTED",
    substrates: ["azure"],
    notes:
      "Existing read-only Azure provider discovery connector.",
  },
  {
    id: "ANSIBLE_PRIVATE_EDGE",
    family: "MANAGED_OPERATIONS",
    status: "IMPLEMENTED",
    substrates: [
      "private",
      "kubernetes",
      "edge",
    ],
    notes:
      "Existing Ansible preview/check path; no non-check execution is exposed.",
  },
  {
    id: "CROSSPLANE_KUBERNETES_EDGE",
    family: "MANAGED_OPERATIONS",
    status: "IMPLEMENTED",
    substrates: [
      "private",
      "kubernetes",
      "edge",
    ],
    notes:
      "Existing Crossplane render/preview path; controller reconciliation remains UNKNOWN until observed.",
  },
  {
    id: "VCF",
    family: "ENVIRONMENT",
    status: "TEST_DOUBLE",
    substrates: ["vcf", "private"],
    notes:
      "Architecture-target synthetic connector only; not a shipped production adapter.",
  },
  {
    id: "OPENSHIFT",
    family: "ENVIRONMENT",
    status: "TEST_DOUBLE",
    substrates: [
      "openshift",
      "kubernetes",
      "private",
      "edge",
    ],
    notes:
      "Architecture-target synthetic connector only; not a shipped production adapter.",
  },
];

export const TRACEABILITY_CONNECTORS:
  TraceabilityConnector[] = [
    {
      id: "JIRA",
      family: "ITSM",
      status: "TEST_DOUBLE",
      notes:
        "Architecture-target synthetic ITSM connector; no live Jira call is made.",
    },
    {
      id: "SERVICENOW",
      family: "ITSM",
      status: "TEST_DOUBLE",
      notes:
        "Architecture-target synthetic ITSM connector; no live ServiceNow call is made.",
    },
    {
      id: "CMDB",
      family: "CMDB",
      status: "TEST_DOUBLE",
      notes:
        "Architecture-target synthetic CMDB connector; CMDB is enrichment, not an authority source.",
    },
  ];
