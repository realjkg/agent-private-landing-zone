export type PluginStage =
  | "BUILD"
  | "CONFIGURE"
  | "MANAGE";

export type PluginStatus =
  | "IMPLEMENTED"
  | "PLANNED";

export type PluginProvider =
  | "AWS"
  | "AZURE"
  | "PRIVATE"
  | "KUBERNETES"
  | "EDGE";

export type PluginCapability =
  | "VERSION"
  | "VALIDATE"
  | "SYNTHESIZE"
  | "PREVIEW"
  | "NORMALIZE"
  | "SBOM"
  | "SECURITY_SCAN";

export type PluginDefinition = {
  id:
    | "TERRAFORM"
    | "OPENTOFU"
    | "PULUMI"
    | "BICEP"
    | "CLOUDFORMATION"
    | "AWS_CDK"
    | "CROSSPLANE"
    | "ANSIBLE";
  stage: PluginStage[];
  status: PluginStatus;
  providers: PluginProvider[];
  capabilities: PluginCapability[];
  executable?: string;
  testedVersion?: string;
  versionSource: string;
  lastReviewed: string;
  notes?: string;
};

export const PLUGIN_CATALOG: PluginDefinition[] = [
  {
    id: "TERRAFORM",
    stage: ["BUILD"],
    status: "IMPLEMENTED",
    providers: ["AWS", "AZURE", "PRIVATE"],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "terraform",
    testedVersion: "1.16.4",
    versionSource:
      "https://github.com/hashicorp/terraform/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Preview-only adapter; apply/destroy are not exposed.",
  },
  {
    id: "PULUMI",
    stage: ["BUILD"],
    status: "IMPLEMENTED",
    providers: [
      "AWS",
      "AZURE",
      "PRIVATE",
      "KUBERNETES",
    ],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "pulumi",
    testedVersion: "3.267.0",
    versionSource:
      "https://github.com/pulumi/pulumi/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Preview-only adapter; up/destroy are not exposed.",
  },
  {
    id: "OPENTOFU",
    stage: ["BUILD"],
    status: "PLANNED",
    providers: ["AWS", "AZURE", "PRIVATE"],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "tofu",
    testedVersion: "1.13.1",
    versionSource:
      "https://github.com/opentofu/opentofu/releases",
    lastReviewed: "2026-10-06",
  },
  {
    id: "BICEP",
    stage: ["BUILD"],
    status: "PLANNED",
    providers: ["AZURE"],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "SYNTHESIZE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "bicep",
    versionSource:
      "https://github.com/Azure/bicep/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Preferred Azure-native declarative authoring path; ARM JSON is not a first-class plug-in.",
  },
  {
    id: "CLOUDFORMATION",
    stage: ["BUILD"],
    status: "PLANNED",
    providers: ["AWS"],
    capabilities: [
      "VALIDATE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    versionSource:
      "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html",
    lastReviewed: "2026-10-06",
    notes:
      "Change Sets provide the preview/change-evidence boundary.",
  },
  {
    id: "AWS_CDK",
    stage: ["BUILD"],
    status: "PLANNED",
    providers: ["AWS"],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "SYNTHESIZE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "cdk",
    versionSource:
      "https://github.com/aws/aws-cdk/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Synthesizes to CloudFormation; normalized change evidence should reuse the CloudFormation path.",
  },
  {
    id: "CROSSPLANE",
    stage: ["BUILD", "MANAGE"],
    status: "PLANNED",
    providers: [
      "AWS",
      "AZURE",
      "PRIVATE",
      "KUBERNETES",
      "EDGE",
    ],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "SYNTHESIZE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    versionSource:
      "https://github.com/crossplane/crossplane/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Controller/reconciliation semantics require a dedicated preview and rollback model.",
  },
  {
    id: "ANSIBLE",
    stage: ["BUILD", "CONFIGURE", "MANAGE"],
    status: "PLANNED",
    providers: [
      "AWS",
      "AZURE",
      "PRIVATE",
      "KUBERNETES",
      "EDGE",
    ],
    capabilities: [
      "VERSION",
      "VALIDATE",
      "PREVIEW",
      "NORMALIZE",
      "SBOM",
      "SECURITY_SCAN",
    ],
    executable: "ansible-playbook",
    versionSource:
      "https://github.com/ansible/ansible/releases",
    lastReviewed: "2026-10-06",
    notes:
      "Build/configure/manage adapter for brownfield private, edge, OS, network and appliance scenarios. Preview must use check/diff semantics; PowerShell is not a first-class plug-in.",
  },
];
