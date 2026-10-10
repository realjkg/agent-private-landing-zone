/**
 * Process profiles for the governed runner (docs/runner-hardening.md).
 *
 * A child process starts from an EMPTY environment. A profile lists the few
 * variables an executable may receive, and only through explicit injection
 * (`ALZ_<IDENTITY>_<VARIABLE>`), never from the operator's ambient shell. The
 * operator's own credentials, token files and tool configuration are therefore
 * out of reach unless someone deliberately hands a named identity to the tool.
 */
export type ProcessProfile = {
  /** Variable names this executable may receive (exact match). */
  injectable: readonly string[];
  /** Prefixes of variable names it may receive (for example `TF_VAR_`). */
  injectablePrefixes: readonly string[];
  /** Injectable variables whose value is a URL and must name an approved host. */
  urlVariables: readonly string[];
  /** Hosts those URLs may name: an exact name or `*.suffix`. Loopback is always approved. */
  approvedHosts: readonly string[];
  timeoutMs: number;
  /** Stdout/stderr beyond this is cut off, the child is stopped and the result is marked truncated. */
  maxOutputBytes: number;
  /** Keep output excerpts out of diagnostics: plan, state and program output can carry secrets. */
  suppressExcerpts: boolean;
};

/**
 * Names that can never be injectable: they change what runs or where it is
 * found (`LD_PRELOAD`, `PATH`), or point a tool back at the operator's own
 * credential files (`HOME`). Enforced by `child-env.ts` regardless of profile,
 * and pinned by test so a profile cannot add one.
 */
export const NEVER_INJECTABLE: RegExp =
  /^(PATH|HOME|USERPROFILE|TMPDIR|TEMP|TMP|SHELL|IFS|ENV|BASH_ENV|CDPATH|PWD|OLDPWD|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|GOFLAGS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;

/** Network settings, injected as `ALZ_NETWORK_<VARIABLE>` into any profile. */
export const NETWORK_VARIABLES: readonly string[] = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
];
export const NETWORK_URL_VARIABLES: readonly string[] = ["HTTPS_PROXY", "HTTP_PROXY"];

const AWS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CA_BUNDLE", "AWS_EC2_METADATA_DISABLED", "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE", "AWS_ENDPOINT_URL",
];
const AZURE = [
  "AZURE_CONFIG_DIR", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID",
  "ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID", "ARM_USE_OIDC",
];

const AWS_HOSTS = ["*.amazonaws.com", "*.amazonaws.com.cn"];
const AZURE_HOSTS = ["*.microsoftonline.com", "*.microsoft.com", "*.azure.com", "*.windows.net", "*.azure.net"];
const TERRAFORM_HOSTS = ["registry.terraform.io", "releases.hashicorp.com", "registry.opentofu.org", "app.terraform.io"];
const PULUMI_HOSTS = ["api.pulumi.com", "*.pulumi.com"];

const MIB = 1024 * 1024;
// Same effective limits as before this change (Node's implicit 1 MiB maxBuffer),
// now explicit. A tool that needs more (a destroy-preview driver reading a large
// plan) gets its own profile with its own reviewed number, never a silent raise.
const base = { timeoutMs: 120_000, maxOutputBytes: 1 * MIB };

export const PROFILES: Readonly<Record<string, ProcessProfile>> = {
  aws: {
    injectable: AWS, injectablePrefixes: [], urlVariables: ["AWS_ENDPOINT_URL"],
    approvedHosts: AWS_HOSTS, suppressExcerpts: false, ...base,
  },
  az: {
    injectable: AZURE, injectablePrefixes: [], urlVariables: [],
    approvedHosts: AZURE_HOSTS, suppressExcerpts: false, ...base,
  },
  bicep: {
    injectable: [], injectablePrefixes: [], urlVariables: [],
    approvedHosts: AZURE_HOSTS, suppressExcerpts: false, ...base,
  },
  terraform: {
    injectable: [...AWS, ...AZURE, "TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR", "TF_IN_AUTOMATION"],
    injectablePrefixes: ["TF_VAR_", "TF_TOKEN_"], urlVariables: ["AWS_ENDPOINT_URL"],
    approvedHosts: [...AWS_HOSTS, ...AZURE_HOSTS, ...TERRAFORM_HOSTS], suppressExcerpts: true, ...base,
  },
  tofu: {
    injectable: [...AWS, ...AZURE, "TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR", "TF_IN_AUTOMATION"],
    injectablePrefixes: ["TF_VAR_", "TF_TOKEN_"], urlVariables: ["AWS_ENDPOINT_URL"],
    approvedHosts: [...AWS_HOSTS, ...AZURE_HOSTS, ...TERRAFORM_HOSTS], suppressExcerpts: true, ...base,
  },
  pulumi: {
    injectable: [
      ...AWS, ...AZURE, "PULUMI_ACCESS_TOKEN", "PULUMI_BACKEND_URL", "PULUMI_CONFIG_PASSPHRASE",
      "PULUMI_CONFIG_PASSPHRASE_FILE", "PULUMI_SKIP_UPDATE_CHECK",
    ],
    injectablePrefixes: [], urlVariables: ["AWS_ENDPOINT_URL", "PULUMI_BACKEND_URL"],
    approvedHosts: [...AWS_HOSTS, ...AZURE_HOSTS, ...PULUMI_HOSTS], suppressExcerpts: true, ...base,
  },
  cdk: {
    injectable: [...AWS, "CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"],
    injectablePrefixes: [], urlVariables: ["AWS_ENDPOINT_URL"],
    approvedHosts: AWS_HOSTS, suppressExcerpts: true, ...base,
  },
  "ansible-playbook": {
    injectable: ["ANSIBLE_CONFIG", "ANSIBLE_INVENTORY"], injectablePrefixes: [], urlVariables: [],
    approvedHosts: [], suppressExcerpts: true, ...base,
  },
  crossplane: {
    injectable: ["KUBECONFIG"], injectablePrefixes: [], urlVariables: [],
    approvedHosts: [], suppressExcerpts: true, ...base,
  },
};
