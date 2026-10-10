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
  // Agent-builder connectors are simulation-only TEST_DOUBLEs:
  // loopback endpoints, synthetic hash-chained records, no egress,
  // no external authority, no infrastructure mutation.
  {
    id: "AZURE_LOCAL_AI_FOUNDRY",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["azurelocal"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated Azure Local + Azure AI Foundry agent-builder connector; no external connection is made.",
  },
  {
    id: "AWS_OUTPOSTS_SAGEMAKER",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["outposts"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated AWS Outposts + SageMaker hybrid agent connector; no external connection is made.",
  },
  {
    id: "VMWARE_PRIVATE_AI",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["vcf"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated VMware Private AI on VCF agent connector, pairing with the VCF connector; no external connection is made.",
  },
  {
    id: "NUTANIX_AI",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["nutanix"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated Nutanix Cloud Infrastructure + AI agent connector; no external connection is made.",
  },
  {
    id: "REDHAT_OPENSHIFT_AI",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["openshift"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated Red Hat OpenShift AI agent connector, pairing with the OPENSHIFT connector; no external connection is made.",
  },
  {
    id: "LANGCHAIN_PRIVATE",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["agent-framework"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated self-hosted LangChain/LangGraph agent connector; no external connection is made.",
  },
  {
    id: "AUTOGEN_PRIVATE",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["agent-framework"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated self-hosted Microsoft AutoGen agent connector; no external connection is made.",
  },
  {
    id: "CREWAI_PRIVATE",
    family: "AGENT_BUILDER",
    status: "TEST_DOUBLE",
    substrates: ["agent-framework"],
    endpoint: "http://127.0.0.1",
    notes:
      "Simulated self-hosted CrewAI agent connector; no external connection is made.",
  },
];

export const AGENT_BUILDER_TARGET_CONNECTORS:
  TargetConnector[] = TARGET_CONNECTORS.filter(
    (connector) =>
      connector.family === "AGENT_BUILDER",
  );

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
