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
 * The partial backend configuration init saves: the STATE_WRITE principal's
 * client id, tenant, subscription and token file path. Never a secret value, and
 * every value is checked against a strict pattern before it is written into
 * HCL. The apply process then needs only the APPLY identity for the provider.
 */
function backendConfig(env: NodeJS.ProcessEnv): string {
  const pick = (name: string, ok: RegExp): string => pickIdentityValue(env, "STATE_WRITE", name, ok);
  return [
    "use_oidc = true",
    `client_id = "${pick("ARM_CLIENT_ID", SAFE_VALUE)}"`,
    `tenant_id = "${pick("ARM_TENANT_ID", GUID)}"`,
    `subscription_id = "${pick("ARM_SUBSCRIPTION_ID", GUID)}"`,
    `oidc_token_file_path = "${pick("ARM_OIDC_TOKEN_FILE", TOKEN_FILE)}"`,
    "",
  ].join("\n");
}

/** The storage account, container and key init saved must be the contract's `<storage-account>/<container>/<key>`. */
function savedBackendMatches(backend: Record<string, unknown>, target: AzureTarget): boolean {
  const config = isRecord(backend.config) ? backend.config : {};
  const parts = [config.storage_account_name, config.container_name, config.key];
  return backend.type === "azurerm" && parts.every((part) => typeof part === "string") && parts.join("/") === target.backend;
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
  backendConfig,
  savedBackendMatches: (saved, target) => savedBackendMatches(saved, target as AzureTarget),
  // Simulation finding (docs/act-pilot-simulation.md): the plan embeds the backend block's settings; the rest is filled from the apply process's ARM_* variables.
  filledAtApply: ["use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"],
  tagAttributes: ["tags"],
  assertProviderConfig: (blocks, target) => assertProviderConfig(blocks, target as AzureTarget),
};
