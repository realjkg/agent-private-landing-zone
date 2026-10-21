import type { DepCheck } from "../deps/checks.js";
import { PLUGIN_CATALOG, type PluginDefinition } from "../plugins/catalog.js";

/** Planning contexts only. No real environment binding or privilege arises from selection. */
export const STAGES = ["development", "staging", "production"] as const;
export type DeploymentStage = typeof STAGES[number];
export const PROVIDERS = ["aws", "azure", "gcp", "private"] as const;
export type LandingProvider = typeof PROVIDERS[number];
export const ENGINES = ["terraform", "pulumi", "opentofu", "bicep", "cloudformation", "cdk", "crossplane", "ansible"] as const;
export type LandingEngine = typeof ENGINES[number];
export type SetupIntent = { provider: LandingProvider; stage: DeploymentStage; engine: LandingEngine; localModels: boolean };

export const STAGE_HELP: Record<DeploymentStage, string> = {
  development: "Isolated development/sandbox target. Discover and experiment with fixture-only evidence.",
  staging: "Non-production pre-release target. Require separate identity, inventory, review and promotion evidence.",
  production: "Production target. Require explicit ownership, approvals, controls and independent qualifications; never infer readiness from a demo.",
};
export const PROVIDER_HELP: Record<LandingProvider, string> = {
  aws: "AWS cloud landing zone; inspect/session remain separately authorized, read-only workflows.",
  azure: "Azure cloud landing zone; inspect/session remain separately authorized, read-only workflows.",
  gcp: "GCP is currently a synthetic Terraform showcase; authenticated provider integration is not qualified.",
  private: "Private/on-premise platform; use the governed provider/adapter capabilities, never ambient host access.",
};
const pluginId: Record<LandingEngine, PluginDefinition["id"]> = {
  terraform: "TERRAFORM", pulumi: "PULUMI", opentofu: "OPENTOFU", bicep: "BICEP",
  cloudformation: "CLOUDFORMATION", cdk: "AWS_CDK", crossplane: "CROSSPLANE", ansible: "ANSIBLE",
};

export type ToolRequirement = {
  id: string;
  label: string;
  status: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";
  installed: boolean | null;
  detail: string;
  fix?: string;
};
/**
 * AWS first-run guidance shares the existing setup and policy boundaries.
 * Informational only: never a credential, role grant, approval, or ACT ticket.
 */
export type AwsSetupGuidance = {
  environment: DeploymentStage;
  primaryEngine: "terraform" | "cdk" | null;
  nextSteps: readonly string[];
  permissions: readonly string[];
  cloudAccess: "NOT_REQUESTED";
  actEnabled: false;
};
export function awsSetupGuidance(intent: SetupIntent): AwsSetupGuidance | null {
  if (intent.provider !== "aws") return null;
  const primaryEngine = intent.engine === "terraform" || intent.engine === "cdk" ? intent.engine : null;
  const stageNote = intent.stage === "development"
    ? "DEV: verify one development account, stage-specific state and execution identity before native preview."
    : intent.stage === "staging"
      ? "STAGING: require independent non-production account/state, fresh discovery and reviewed promotion evidence."
      : "PROD: require production account isolation, independent review, approved release and separate governed execution authorization.";
  return {
    environment:intent.stage,primaryEngine,
    nextSteps:[
      "Discover the exact AWS account and region with ./alz inspect aws only after operator authentication.",
      primaryEngine === "terraform" ? "Validate Terraform modules and review a state-bound native plan."
        : primaryEngine === "cdk" ? "Review CDK synthesis before a controlled CloudFormation Change Set preview."
        : "Selected advanced engine must qualify independently before AWS provisioning.",
      stageNote,
      intent.localModels ? "Qualify local Ollama and configured private models; do not send prompts or cloud credentials to a remote model."
        : "Private models are disabled for this setup; deterministic assessments remain available."
    ],
    permissions:[
      "Operator: use existing browser/CLI federated AWS sign-in; no AWS credentials enter the installer or AI prompts.",
      "Discovery: scoped STS identity check and read-only inventory for the selected account.",
      "Preview: separate authorization for exact stack/state where cloud-side preview requires it.",
      "Provisioning: no implicit deploy/apply; the existing governed ACT contract is a separate owner decision."
    ],
    cloudAccess:"NOT_REQUESTED",actEnabled:false
  };
}
export type SetupPlan = {
  intent: SetupIntent;
  qualification: "SYNTHETIC_ONLY" | "PREVIEW_NOT_QUALIFIED";
  supportedDemo: boolean;
  tools: ToolRequirement[];
  blocked: string[];
  notice: string;
  awsGuidance?: AwsSetupGuidance;
};

/** Pure prerequisite classification; NEVER launches installers or assumes permissions. */
export function planSetup(intent: SetupIntent, checks: readonly DepCheck[], options: { offlineTour?: boolean } = {}): SetupPlan {
  if (!STAGES.includes(intent.stage) || !PROVIDERS.includes(intent.provider) ||
    !ENGINES.includes(intent.engine) || typeof intent.localModels !== "boolean") throw new Error("SETUP_SELECTION_INVALID");
  const plugin = PLUGIN_CATALOG.find((p) => p.id === pluginId[intent.engine]);
  if (!plugin) throw new Error("SETUP_PLUGIN_UNREGISTERED");
  const providerSupported = intent.provider === "gcp"
    ? intent.engine === "terraform"
    : plugin.providers.includes(intent.provider.toUpperCase() as PluginDefinition["providers"][number]);
  const checked = new Map<string, DepCheck>(checks.map((x) => [x.id, x]));
  const required = new Set<string>(["node", "git"]);
  // The offline tour executes no engine and needs no Terraform or Ollama binary.
  if (!options.offlineTour) {
    if (intent.engine === "terraform") required.add("terraform");
    else if (plugin.executable) required.add(plugin.executable === "aws" ? "aws-cli" : "product:" + plugin.executable);
    if (intent.localModels) required.add("ollama");
  }
  const names: Array<[string, string]> = [
    ["node", "Node 26"], ["git", "Git"], ["terraform", "Terraform"], ["ollama", "Ollama"],
    ["aws-cli", "AWS CLI"], ["product:pulumi", "Pulumi"], ["product:tofu", "OpenTofu"],
    ["product:bicep", "Bicep"], ["product:cdk", "AWS CDK"], ["product:crossplane", "Crossplane"],
    ["product:ansible-playbook", "Ansible"], ["product:docker", "Docker"],
    ["product:trivy", "Trivy"],
  ];
  // Google SDK is intentionally check-only and never becomes a condition of the OFFLINE demo.
  const tools: ToolRequirement[] = names.map(([id, label]) => {
    const check = checked.get(id);
    const status = required.has(id) ? "REQUIRED" : id === "node" || id === "git" ? "NOT_APPLICABLE" : "OPTIONAL";
    return { id, label, status, installed: check ? check.ok : null,
      detail: check?.detail ?? "Not probed", ...(check?.fix ? { fix: check.fix } : {}) };
  });
  if (intent.provider === "gcp") {
    tools.push({ id: "gcloud", label: "Google Cloud CLI", status: "OPTIONAL", installed: null,
      detail: "Operator check only: command -v gcloud && gcloud version; never needed for the offline GCP demo." });
  }
  const blocked = tools.filter((x) => x.status === "REQUIRED" && x.installed !== true).map((x) => x.label);
  if (!providerSupported) blocked.push("This provider/engine combination is not in the registered preview catalog");
  const supportedDemo = intent.provider === "gcp" && intent.engine === "terraform" ||
    (["aws", "azure"].includes(intent.provider) && providerSupported);
  return {
    intent,
    qualification: intent.provider === "gcp" ? "SYNTHETIC_ONLY" : "PREVIEW_NOT_QUALIFIED",
    supportedDemo, tools, blocked,
    notice: `${STAGE_HELP[intent.stage]} The selection is advisory planning context, not bound to an account, credential, or real deployment. ACT is disabled.`,
    ...(intent.provider === "aws" ? { awsGuidance: awsSetupGuidance(intent)! } : {}),
  };
}
