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
  /** Set in the child after everything injected, so nothing can override them: a reviewed constant, never a credential. */
  fixedEnvironment?: Readonly<Record<string, string>>;
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
  "ARM_OIDC_TOKEN_FILE",
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

/**
 * The pilot apply path's Terraform (src/apply). The state-writing and applying
 * identities hold write access, so they may not redirect where providers are
 * installed from: no CLI configuration file (provider mirrors, `provider_installation`
 * and `credentials` blocks) and no shared plugin cache. An `ALZ_STATE_WRITE_` or
 * `ALZ_APPLY_` variable naming either is refused, which fails the step closed.
 */
const PROVIDER_INSTALLATION_OVERRIDES: readonly string[] = ["TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR"];
/**
 * The apply identities use `ARM_*` with OIDC, `AWS_ROLE_ARN` with a web identity token file and `AWS_REGION`, or the four Google
 * variables below (`GOOGLE_IDENTITY`), only: no az CLI
 * configuration, `AZURE_*` SDK credentials, static AWS keys, session token, shared profile or config file reach an
 * apply child; no service endpoint (the web identity token goes wherever one points, and a host allowlist cannot tell
 * an attacker's API Gateway or load balancer from AWS), trust store or second default region either; and the AWS
 * instance metadata service is switched off so it cannot be a fallback. An apply child sees only what its identity injects.
 */
const AWS_OUTSIDE_THE_IDENTITY: readonly string[] = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_EC2_METADATA_DISABLED",
  "AWS_ENDPOINT_URL", "AWS_CA_BUNDLE", "AWS_DEFAULT_REGION",
];
/**
 * The Google variables a pilot identity may hand a Terraform child (src/apply/providers/gcp.ts, `GCP_IDENTITY_VARIABLES`): a workload
 * identity federation credential configuration (a file path), the service account it impersonates, and the project and region. Only
 * the pilot apply profile takes them (review N1 of #323): the general `terraform` profile, which the tool runner and the teardown
 * adapter use, gets no Google variable, so no child there can receive a Google credential without the GCP identity checks and the
 * metadata switch-off below. Every other `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` or `GCE_*` variable is not injectable anywhere, so a key
 * file, an access token, a backend credential, an encryption key or a metadata host never reaches a child.
 */
const GOOGLE_IDENTITY = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"];
/**
 * The Google metadata server, switched off for every pilot apply child so it can never be a credential fallback (review N2 of #323).
 * The Go auth library in hashicorp/google has no documented switch that disables the metadata server: any non-empty
 * `GCE_METADATA_HOST` makes it treat the host as Google Compute Engine and fetch tokens from that host instead. So the host is set
 * to `metadata.invalid`, a name under the `.invalid` top-level domain, which RFC 6761 (section 6.4) reserves so that it never
 * resolves: nothing can listen there, on loopback, on the local network or anywhere else, unlike a loopback port (a local service on
 * port 9 could answer) or an address that is merely unrouted (a dial there waits for a timeout). The lookup fails at once and
 * carries no credential. `GCE_METADATA_IP` (read by the Python library) gets the same name, and `NO_GCE_CHECK` turns the Python
 * library's check off. Each one only ever removes a source of credentials. SYNTHETIC check, 2026-10-28, the signature-verified
 * hashicorp/google 8.9.0 under Terraform 1.16.4: with no credential configuration, the provider's token request went to
 * `http://metadata.invalid/...` and failed with "no such host" in about one second, and with the identity's credential
 * configuration set it never asked the metadata host. The pilot's GCP identities always set one (`ambientRefusal`), so this is
 * defense in depth.
 */
const GOOGLE_METADATA_OFF: Readonly<Record<string, string>> = { GCE_METADATA_HOST: "metadata.invalid", GCE_METADATA_IP: "metadata.invalid", NO_GCE_CHECK: "True" };

export const TERRAFORM_APPLY_PROFILE: ProcessProfile = {
  ...PROFILES.terraform,
  injectable: [
    ...PROFILES.terraform.injectable.filter((name) =>
      !PROVIDER_INSTALLATION_OVERRIDES.includes(name) && !name.startsWith("AZURE_") && !AWS_OUTSIDE_THE_IDENTITY.includes(name)),
    ...GOOGLE_IDENTITY,
  ],
  // The data directory is always init's own fresh one in the work copy (the copy is refused if it already holds one; src/apply/backend-pin.ts).
  fixedEnvironment: { AWS_EC2_METADATA_DISABLED: "true", TF_DATA_DIR: ".terraform", ...GOOGLE_METADATA_OFF },
};

/**
 * The AWS CLI as the pilot's CDK engine runs it (src/apply/engines/cdk.ts): the same identity-only environment as the
 * Terraform apply profile (a web identity role and region, no static key, session token, shared profile or config file,
 * endpoint override or trust store, instance metadata off), a quarter-hour limit so a change set wait fits, and no output
 * excerpts in diagnostics because stack events and descriptions can quote template and parameter values.
 */
export const AWS_CFN_APPLY_PROFILE: ProcessProfile = {
  ...PROFILES.aws,
  injectable: PROFILES.aws.injectable.filter((name) => !AWS_OUTSIDE_THE_IDENTITY.includes(name)),
  fixedEnvironment: { AWS_EC2_METADATA_DISABLED: "true" },
  timeoutMs: 15 * 60_000,
  maxOutputBytes: 8 * MIB,
  suppressExcerpts: true,
};
