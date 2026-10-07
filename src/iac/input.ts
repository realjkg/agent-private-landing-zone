export type ChangeSetType =
  | "CREATE"
  | "UPDATE";

export type CloudFormationCapabilities =
  | "CAPABILITY_IAM"
  | "CAPABILITY_NAMED_IAM"
  | "CAPABILITY_AUTO_EXPAND";

export type AzureDeploymentScope =
  | "tenant"
  | "management-group"
  | "subscription"
  | "resource-group";

export type AdapterInput = {
  templatePath?: string;
  parametersPath?: string;
  stackName?: string;
  changeSetName?: string;
  changeSetType?: ChangeSetType;
  capabilities?: CloudFormationCapabilities[];
  stack?: string;
  bicepFile?: string;
  azureScope?: AzureDeploymentScope;
  location?: string;
  managementGroupId?: string;
  resourceGroup?: string;
  deploymentName?: string;
  playbookPath?: string;
  inventoryPath?: string;
  limit?: string;
  manifestPath?: string;
  extensionsPath?: string;
  xrPath?: string;
  compositionPath?: string;
  functionsPath?: string;
};
