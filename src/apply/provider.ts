import { AWS } from "./providers/aws.js";
import { AZURE } from "./providers/azure.js";
import type { BackendType } from "./backend-pin.js";
import type { PilotContract, PilotTarget, ProviderId } from "./types.js";

/**
 * The one place a provider's specifics live (docs/act-pilot-apply.md, "Providers").
 * The generic apply modules (contract, identities, driver, seal, evidence, the
 * CLI) hold the requirement and its single enforcement point; a spec supplies
 * only the provider's facts and checks, and the contract's `provider` id selects
 * it. A contract naming a provider with no spec here is not a contract.
 */

/** The target fields that identify the cloud account and place (AZURE: tenant and subscription; AWS: account and region). The same fields bind qualification evidence to the DEV target. */
type AccountFields = Readonly<Record<string, string>>;

/** A provider block from `terraform show -json` `configuration.provider_config`. */
export type ProviderBlock = { name?: string; full_name?: string; expressions?: Record<string, unknown> };
/**
 * One resource or data source the plan names, with the provider that serves it, from `terraform show -json`: the
 * configuration tree (every module; the only place a data source read at plan time is sure to appear), the changes, the
 * prior state and the planned values. `mode` is `managed` or `data` as Terraform reports it (empty when it did not).
 */
export type ProviderUse = { address: string; mode: string; type: string; provider: Pick<ProviderBlock, "name" | "full_name"> };

/** A refusal the identity checks raise; the driver maps it to the apply refusal of the same code. */
export type IdentityRefusal = { ok: false; code: "IDENTITY_NOT_CONFIGURED" | "IDENTITY_COLLAPSED"; message: string };

export type ProviderSpec = {
  id: ProviderId;
  /** Target shape: a validator per account field, in the order the contract lists them. `backend` and `workspace` are every provider's. */
  accountFields: Readonly<Record<string, (value: string) => boolean>>;
  /** Whether a backend string, as the contract writes it, is well formed. */
  backendOk(value: string): boolean;
  /** What `ResolvedTarget.account` carries for a target, and what to call it in a message. */
  account(target: PilotTarget): string;
  accountNoun: string;
  /** What names the target in messages about identities and qualification, for example "tenant and subscription". */
  targetNoun: string;
  /** The identity variable whose normalized value qualification attests as the principal, whether a value of it is well formed, and the cloud logs a person checks to attest separation. */
  clientIdVariable: string;
  clientIdOk(value: string): boolean;
  /**
   * Whether each environment brings its own principals (AWS: a role per account, so its ARN names the environment's
   * account) rather than the DEV principals qualification attested being used everywhere (AZURE: one client for every
   * subscription). Qualification binds the attested principals to DEV runs only when this is true.
   */
  principalPerEnvironment: boolean;
  logSource: string;
  /** Identity variable name to whether its value is the target's. APPLY and STATE_WRITE must set every one; the others when they set it. */
  identityTargetVariables: Readonly<Record<string, (value: string, target: PilotTarget) => boolean>>;
  /** Variables that would let a child fall back to a CLI, instance or ambient credential, and identities that carry the operator's own. */
  ambientRefusal(env: NodeJS.ProcessEnv): IdentityRefusal | undefined;
  /** The partial backend configuration init saves for STATE_WRITE. Throws a code if a value is unusable. */
  backendConfig(env: NodeJS.ProcessEnv, target: PilotTarget): string;
  /**
   * Whether the backend `init` saved (`.terraform/terraform.tfstate`) is the contract target's, and whether every identity
   * setting it saved is the STATE_WRITE identity's own value in `env` (the environment that init's backend configuration was
   * written from). Checked after the seal-time init, whose settings the plan embeds, and after the apply-time init.
   */
  savedBackendMatches(saved: Record<string, unknown>, target: PilotTarget, env: NodeJS.ProcessEnv): boolean;
  /**
   * The backend type the product-owned override file pins (src/apply/backend-pin.ts). The project's own backend block is never
   * read: the override replaces it, and every setting comes from `backendConfig` or `backendLocation`.
   */
  backendType: BackendType;
  /** The contract target's backend location only (no identity setting): the `-backend-config` file of a seal that does not embed STATE_WRITE. */
  backendLocation(target: PilotTarget): string;
  /** The backend settings the plan leaves null for the apply process to fill from its own environment, the APPLY identity's. `terraform apply <planfile>` ignores the apply-time init (docs/act-pilot-simulation.md). */
  filledAtApply: readonly string[];
  /**
   * Throws a code if a provider block names another account than the contract's, or (AWS) credentials, files, destinations or providers
   * the pilot does not allow, or (AWS) a resource or data source of Terraform's built-in provider other than `terraform_data` (`uses`:
   * everything the plan names, with its provider). `env` holds the APPLY identity.
   */
  assertProviderConfig(blocks: readonly ProviderBlock[], target: PilotTarget, env: NodeJS.ProcessEnv, uses: readonly ProviderUse[]): void;
  /** The plan attributes that hold a resource's tags, most complete first (AWS: `tags_all`, then `tags`; Azure: `tags`). A created resource with none of them is untaggable. */
  tagAttributes: readonly string[];
};

const SPECS: Readonly<Record<ProviderId, ProviderSpec>> = { AZURE, AWS };

/** The spec for a contract's `provider`, or undefined for anything that is not an implemented provider id. */
export const providerSpec = (id: unknown): ProviderSpec | undefined =>
  typeof id === "string" && Object.hasOwn(SPECS, id) ? SPECS[id as ProviderId] : undefined;

/** The spec of a loaded contract, whose `provider` validation already guaranteed. */
export const specOf = (contract: Pick<PilotContract, "provider">): ProviderSpec => SPECS[contract.provider];

export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(SPECS) as ProviderId[];

/** A target's account fields: the values qualification evidence records and apply compares. */
export const accountFieldsOf = (spec: ProviderSpec, target: PilotTarget): AccountFields =>
  Object.fromEntries(Object.keys(spec.accountFields).map((key) => [key, (target as AccountFields)[key]]));
