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

const ambient = (env: NodeJS.ProcessEnv) => ambientRefusal(env, {
  fallback: FALLBACK_VARIABLE, ambient: /^(AZURE|ARM)_/, fallbackTo: "the az CLI, ambient or another cloud's credentials",
  advice: "The apply identities use ARM_* with an OIDC token file only.",
});

/**
 * State access is Entra ID only (owner decision of 2026-10-27, issue #39; `bootstrap/azure` disables shared keys and SAS on the
 * state accounts). The switch is the backend's own `use_azuread_auth = true`, written into the product's backend file for every
 * init (seal, qualification, apply), so init saves it and the sealed plan embeds it. It is not taken from the environment:
 * Terraform 1.16.4's azurerm backend reads `ARM_USE_AZUREAD` only as a default when the setting is absent, init does not save an
 * environment default, and `ARM_USE_*` other than `ARM_USE_OIDC` is refused as a fallback (`FALLBACK_VARIABLE`).
 * (`ARM_STORAGE_USE_AZUREAD` is the azurerm *provider's* variable; the 1.16.4 backend never reads it.)
 *
 * `resource_group_name` is never written and is refused if saved (`savedBackendMatches`). The backend needs it only to list the
 * account's shared keys through ARM, or for `lookup_blob_endpoint`. With Entra ID authorization it builds the blob endpoint from
 * the storage account name, so the contract's `<storage-account>/<container>/<key>` is the whole location and nothing is defaulted.
 */
const ENTRA_ONLY = "use_azuread_auth = true";

/**
 * The partial backend configuration init saves: the contract's storage account, container and key and the Entra ID switch
 * (`backendLocation`; the product override pins the azurerm type, so no project setting survives), and
 * the STATE_WRITE principal's client id, tenant, subscription and token file path. Never a secret value, and
 * every value is checked against a strict pattern before it is written into
 * HCL. The apply process then needs only the APPLY identity for the provider.
 */
function backendLocation(target: AzureTarget): string {
  if (!backendOk(target.backend)) return stop("BACKEND_NOT_IN_CONTRACT");
  const [account, container, ...key] = target.backend.split("/");
  return [`storage_account_name = "${account}"`, `container_name = "${container}"`, `key = "${key.join("/")}"`, ENTRA_ONLY, ""].join("\n");
}

function backendConfig(env: NodeJS.ProcessEnv, target: AzureTarget): string {
  const pick = (name: string, ok: RegExp): string => pickIdentityValue(env, "STATE_WRITE", name, ok);
  return backendLocation(target) + [
    "use_oidc = true",
    `client_id = "${pick("ARM_CLIENT_ID", SAFE_VALUE)}"`,
    `tenant_id = "${pick("ARM_TENANT_ID", GUID)}"`,
    `subscription_id = "${pick("ARM_SUBSCRIPTION_ID", GUID)}"`,
    `oidc_token_file_path = "${pick("ARM_OIDC_TOKEN_FILE", TOKEN_FILE)}"`,
    "",
  ].join("\n");
}

/**
 * The settings init may save with a value: exactly what `backendLocation` and `backendConfig` write. Init saves every other
 * attribute of the backend's schema as `null` (docs/act-pilot-simulation.md, (a)), and an environment default is not saved.
 */
const SAVED_SETTINGS = new Set(["storage_account_name", "container_name", "key", "use_azuread_auth", "use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"]);

/**
 * The backend init saved, which the sealed plan embeds and the apply uses: the azurerm type, the contract's
 * `<storage-account>/<container>/<key>`, `use_azuread_auth` saved as `true`, `use_oidc` absent, `null` or `true`, and every other
 * setting absent or `null`. That refuses a shared key or SAS token (`access_key`, `sas_token`), another credential or auth path
 * (`client_secret`, `client_certificate*`, `use_msi`, `msi_endpoint`, `use_cli`, `use_aks_workload_identity`), another endpoint or
 * cloud (`endpoint`, `metadata_host`, `environment`, `use_dns_zone_endpoint`), the ARM lookups (`resource_group_name`,
 * `lookup_blob_endpoint`), `snapshot`, and any attribute a later backend version adds.
 */
function savedBackendMatches(backend: Record<string, unknown>, target: AzureTarget): boolean {
  const config = isRecord(backend.config) ? backend.config : {};
  const parts = [config.storage_account_name, config.container_name, config.key];
  return backend.type === "azurerm" && parts.every((part) => typeof part === "string") && parts.join("/") === target.backend &&
    config.use_azuread_auth === true && (config.use_oidc === undefined || config.use_oidc === null || config.use_oidc === true) &&
    Object.entries(config).every(([name, value]) => SAVED_SETTINGS.has(name) || value === null);
}

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
  backendConfig: (env, target) => backendConfig(env, target as AzureTarget),
  backendType: "azurerm",
  backendLocation: (target) => backendLocation(target as AzureTarget),
  savedBackendMatches: (saved, target) => savedBackendMatches(saved, target as AzureTarget),
  // Simulation finding (docs/act-pilot-simulation.md): the plan embeds the seal-time backend settings (now the product's backend file, under the azurerm pin); the rest is filled from the apply process's ARM_* variables.
  filledAtApply: ["use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"],
  tagAttributes: ["tags"],
  // The plan's resource uses are not judged here: the Azure allowlist is open, and the built-in provider is not singled out (as it is for AWS).
  assertProviderConfig: (blocks, target) => assertProviderConfig(blocks, target as AzureTarget),
};
