import type { BackendBlockRule } from "../backend-block.js";
import { SAFE_VALUE, TOKEN_FILE } from "../constants.js";
import { stop } from "../engine.js";
import type { ProviderBlock, ProviderSpec } from "../provider.js";
import { KEY_SEGMENT, ambientRefusal, isRecord, pickIdentityValue } from "./shared.js";

/**
 * Everything the pilot knows about Azure with the AzureRM backend (docs/act-pilot-apply.md,
 * "Providers"). Nothing outside this file names an Azure field, variable or backend type.
 */

/** One environment's target. `account` in a `ResolvedTarget` is the subscription id. */
export type AzureTarget = {
  tenantId: string;
  subscriptionId: string;
  /** The azurerm backend, written as `<storage-account>/<container>/<key>`. */
  backend: string;
  workspace: string;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function backendOk(value: string): boolean {
  const [account, container, ...key] = value.split("/");
  return STORAGE_ACCOUNT.test(account) && CONTAINER.test(container ?? "") && key.length > 0 && key.every((s) => KEY_SEGMENT.test(s));
}

/**
 * Anything that lets a child fall back to the az CLI, a managed identity, a
 * certificate or an Azure SDK default instead of the identity's own OIDC token
 * file, or to another cloud's credentials (`AWS_*`). The apply identities use `ARM_*` with `ARM_USE_OIDC` and
 * `ARM_OIDC_TOKEN_FILE` only.
 */
const FALLBACK_VARIABLE = /^(AZURE_.*|ARM_USE_(?!OIDC$).*|ARM_MSI_.*|ARM_CLIENT_CERTIFICATE.*|AWS_.*)$/;

/**
 * State access is Entra ID only (owner decision of 2026-10-27, issue #39): the backend's `use_azuread_auth`, which the
 * partial configuration sets and the project's own block may set. Shared keys and SAS tokens never reach a child
 * (`ARM_ACCESS_KEY` and `ARM_SAS_TOKEN` are not injectable), and the bootstrap disables shared-key access on the storage
 * account. The environment form of the switch (`ARM_STORAGE_USE_AZUREAD`) is not on the runner profile yet.
 */
const ambient = (env: NodeJS.ProcessEnv) => ambientRefusal(env, {
  fallback: FALLBACK_VARIABLE, ambient: /^(AZURE|ARM)_/, fallbackTo: "the az CLI, ambient or another cloud's credentials",
  advice: "The apply identities use ARM_* with an OIDC token file only.",
});

/**
 * The partial backend configuration init saves: Entra ID authorization for the
 * state blob, and the STATE_WRITE principal's client id, tenant, subscription and
 * token file path. Never a secret value, and every value is checked against a
 * strict pattern before it is written into HCL. The apply process then needs
 * only the APPLY identity for the provider.
 */
function backendConfig(env: NodeJS.ProcessEnv): string {
  const pick = (name: string, ok: RegExp): string => pickIdentityValue(env, "STATE_WRITE", name, ok);
  return [
    "use_azuread_auth = true",
    "use_oidc = true",
    `client_id = "${pick("ARM_CLIENT_ID", SAFE_VALUE)}"`,
    `tenant_id = "${pick("ARM_TENANT_ID", GUID)}"`,
    `subscription_id = "${pick("ARM_SUBSCRIPTION_ID", GUID)}"`,
    `oidc_token_file_path = "${pick("ARM_OIDC_TOKEN_FILE", TOKEN_FILE)}"`,
    "",
  ].join("\n");
}

/**
 * The settings init may save with a value: the contract's storage names, the two switches, and the STATE_WRITE principal's
 * identifiers the partial configuration writes (`backendConfig`). Init saves every other attribute of the backend's schema as
 * `null` when nothing set it (docs/act-pilot-simulation.md, (a)).
 */
const SAVED_SETTINGS = new Set(["storage_account_name", "container_name", "key", "use_azuread_auth", "use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"]);

/**
 * The storage account, container and key init saved must be the contract's `<storage-account>/<container>/<key>`, and Entra ID
 * authorization must be on (`use_azuread_auth` saved as `true`: the partial configuration sets it, and without one the project's
 * own block must, since init saves nothing from the environment). Every other saved setting must be `null` or absent: a shared
 * key or SAS token, another credential or auth path (`client_secret`, `client_certificate*`, `use_msi`, `msi_endpoint`,
 * `use_cli`), another endpoint or cloud (`endpoint`, `metadata_host`, `environment`), `resource_group_name`, `snapshot` or any
 * attribute this list does not name. `use_oidc`, when saved, must be `true`. The plan embeds what init saved, so this is what the
 * apply uses; the backend-block check refuses the same settings before init, and this one holds even if a block got past it.
 */
function savedBackendMatches(backend: Record<string, unknown>, target: AzureTarget): boolean {
  const config = isRecord(backend.config) ? backend.config : {};
  const parts = [config.storage_account_name, config.container_name, config.key];
  return backend.type === "azurerm" && parts.every((part) => typeof part === "string") && parts.join("/") === target.backend &&
    config.use_azuread_auth === true && (config.use_oidc === undefined || config.use_oidc === null || config.use_oidc === true) &&
    Object.entries(config).every(([name, value]) => SAVED_SETTINGS.has(name) || value === null);
}

/**
 * What the project's own `backend "azurerm"` block may set, judged before init reads it: the contract's storage account,
 * container and key (each, when set, exactly the contract's), `use_oidc` and `use_azuread_auth` (each, when set, `true`).
 * Everything else is refused as such: a shared key or SAS token (`access_key`, `sas_token`), another credential or auth
 * path (`client_secret`, `client_certificate*`, `use_msi`, `msi_endpoint`, `use_cli`), another endpoint or cloud
 * (`endpoint`, `metadata_host`, `environment`), the key-based lookup through ARM (`resource_group_name`), a snapshot
 * setting, or a `cloud` block. What init needs beyond the block comes from the partial configuration and the identity's own
 * `ARM_*` variables.
 */
const BACKEND_BLOCK: BackendBlockRule = {
  type: "azurerm",
  attributes: ["storage_account_name", "container_name", "key", "use_oidc", "use_azuread_auth"],
  literals: (backend) => {
    const [storage_account_name, container_name, ...key] = backend.split("/");
    return { storage_account_name, container_name, key: key.join("/"), use_oidc: true, use_azuread_auth: true };
  },
};

/**
 * The provider half of the contract binding: a constant `subscription_id` or `tenant_id` in any azurerm provider block
 * must be the contract's. An expression (a variable, a data source) is not checkable from the plan and is not judged;
 * the runbook says so. The identity checks and the cloud-side role assignments still bound what the credentials reach.
 */
function assertProviderConfig(blocks: readonly ProviderBlock[], pinned: AzureTarget): void {
  for (const provider of blocks) {
    if (provider?.name !== "azurerm" && !/\/azurerm$/.test(provider?.full_name ?? "")) continue;
    for (const [field, want, code] of [["subscription_id", pinned.subscriptionId, "PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT"], ["tenant_id", pinned.tenantId, "PROVIDER_TENANT_NOT_IN_CONTRACT"]] as const) {
      const constant = (provider.expressions?.[field] as { constant_value?: unknown } | undefined)?.constant_value;
      if (constant !== undefined && constant !== null && String(constant).toLowerCase() !== want.toLowerCase()) stop(code);
    }
  }
}

export const AZURE: ProviderSpec = {
  id: "AZURE",
  accountFields: { tenantId: (v) => GUID.test(v), subscriptionId: (v) => GUID.test(v) },
  backendOk,
  account: (target) => (target as AzureTarget).subscriptionId,
  accountNoun: "subscription",
  targetNoun: "tenant and subscription",
  clientIdVariable: "ARM_CLIENT_ID",
  clientIdOk: (v) => SAFE_VALUE.test(v) && v === v.toLowerCase(),
  principalPerEnvironment: false,
  logSource: "Azure sign-in and storage logs",
  identityTargetVariables: {
    ARM_TENANT_ID: (v, t) => v.toLowerCase() === (t as AzureTarget).tenantId.toLowerCase(),
    ARM_SUBSCRIPTION_ID: (v, t) => v.toLowerCase() === (t as AzureTarget).subscriptionId.toLowerCase(),
  },
  ambientRefusal: ambient,
  backendConfig,
  savedBackendMatches: (saved, target) => savedBackendMatches(saved, target as AzureTarget),
  backendBlock: BACKEND_BLOCK,
  // Simulation finding (docs/act-pilot-simulation.md): the plan embeds the backend block's settings; the rest is filled from the apply
  // process's ARM_* variables. `use_azuread_auth` is embedded as true whenever init saved it (above).
  filledAtApply: ["use_azuread_auth", "use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"],
  tagAttributes: ["tags"],
  // The plan's resource uses are not judged here: the Azure allowlist is open, and the built-in provider is not singled out (as it is for AWS).
  assertProviderConfig: (blocks, target) => assertProviderConfig(blocks, target as AzureTarget),
};
