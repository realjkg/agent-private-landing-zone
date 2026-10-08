import type {
  EvidenceConnector,
  TargetConnector,
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
    status: "IMPLEMENTED",
    substrates: ["vcf", "private"],
    notes:
      "Read-only VCF SDDC Manager provider contract; customer live qualification remains separate.",
  },
  {
    id: "OPENSHIFT",
    family: "ENVIRONMENT",
    status: "IMPLEMENTED",
    substrates: [
      "openshift",
      "kubernetes",
      "private",
      "edge",
    ],
    notes:
      "Read-only OpenShift REST provider contract; customer live qualification remains separate.",
  },
];

export const EVIDENCE_CONNECTORS:
  EvidenceConnector[] = [
    {
      id: "JIRA",
      family: "ITSM",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic Jira ITSM connector; no live ticket is created.",
    },
    {
      id: "SERVICENOW",
      family: "ITSM",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic ServiceNow ITSM connector; no live change or incident is created.",
    },
    {
      id: "CMDB",
      family: "CMDB",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic CMDB connector; configuration data is enrichment, never authority.",
    },
    {
      id: "GITHUB",
      family: "DEVOPS",
      status: "PROJECT_CONNECTED",
      notes:
        "GitHub is connected for this project; the synthetic suite does not invoke live writes.",
    },
    {
      id: "GITLAB",
      family: "DEVOPS",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic GitLab change-evidence connector until a runtime adapter is connected.",
    },
    {
      id: "CIRCLECI",
      family: "DEVOPS",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic CircleCI pipeline-evidence connector until a runtime adapter is connected.",
    },
    {
      id: "JENKINS",
      family: "DEVOPS",
      status: "TEST_DOUBLE",
      notes:
        "Synthetic Jenkins build/deployment-evidence connector until a runtime adapter is connected.",
    },
  ];
