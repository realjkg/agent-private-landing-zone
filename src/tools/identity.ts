import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Execution identities for governed child processes
 * (docs/identity-and-execution-contracts.md, docs/act-pilot-plan.md).
 *
 * Four identities exist. None is the operator's own credentials, and a child
 * never falls back from one to another, or to something it was not handed.
 *
 *  - DISCOVERY: provider reads for discovery and previews (describe, list, plan
 *    refresh). Read-only by policy at the cloud side.
 *  - STATE: reads the state container (backend) and takes the lease, for a
 *    destroy preview. A different principal from DISCOVERY because state is
 *    sensitive material and state access should not imply provider access.
 *  - STATE_WRITE: writes state blobs and takes the lease. Used by apply only.
 *  - APPLY: provider writes. Used by apply only, and never a state fallback.
 *
 * Locking stays on for every run. A state identity that cannot take the lock is
 * given the access to take it, not a way around it.
 */
export const EXECUTION_IDENTITIES = ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"] as const;
export type ExecutionIdentity = (typeof EXECUTION_IDENTITIES)[number];

/** `^ALZ_(<identity>|...)_`, built from the identity list so no copy of the names can drift. */
const identityPrefixPattern = (identities: readonly ExecutionIdentity[]): RegExp => new RegExp("^ALZ_(" + identities.join("|") + ")_");

/** The two identities that write; see `mutationIdentityVariables`. */
export const MUTATION_IDENTITIES = ["STATE_WRITE", "APPLY"] as const satisfies readonly ExecutionIdentity[];
export const ANY_IDENTITY_VARIABLE = identityPrefixPattern(EXECUTION_IDENTITIES);
export const MUTATION_IDENTITY_VARIABLE = identityPrefixPattern(MUTATION_IDENTITIES);

export function isExecutionIdentity(value: string): value is ExecutionIdentity {
  return (EXECUTION_IDENTITIES as readonly string[]).includes(value);
}

/**
 * Prefixes that name an identity this system must never read from. Setting one
 * is a configuration mistake worth reporting, because an operator who exports
 * `ALZ_DEPLOY_AWS_ACCESS_KEY_ID` expects something to use it.
 */
const FORBIDDEN_IDENTITY_PREFIXES = /^ALZ_(DEPLOY|DEPLOYMENT|OPERATOR|ADMIN|DESTROY)_/;

export function forbiddenIdentityVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => FORBIDDEN_IDENTITY_PREFIXES.test(key)).sort();
}

/**
 * The two identities that write (STATE_WRITE and APPLY) exist only for the
 * pilot apply path. A read-only preview refuses to run beside them, so a shell
 * holding mutation credentials never starts one; the apply path strips them
 * from every child that is not its own step.
 */
export function mutationIdentityVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => MUTATION_IDENTITY_VARIABLE.test(key)).sort();
}

export const PRINCIPAL_NAME = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|ACCESS_KEY|SESSION|CLIENT_ID$|CLIENT_CERTIFICATE|CONFIG_DIR$)/i;

/**
 * Does `key` (`ALZ_<IDENTITY>_<VAR>`) belong to `identity`? `STATE` is a prefix
 * of `STATE_WRITE`, so a key that belongs to a longer identity is not STATE's.
 */
export function ownsIdentityVariable(key: string, identity: ExecutionIdentity): boolean {
  if (!key.startsWith("ALZ_" + identity + "_")) return false;
  return !EXECUTION_IDENTITIES.some((other) =>
    other !== identity && other.startsWith(identity + "_") && key.startsWith("ALZ_" + other + "_"));
}

/** Non-empty variables configured for `identity`, by name without the prefix. */
export function identityVariables(env: NodeJS.ProcessEnv, identity: ExecutionIdentity): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "" || !ownsIdentityVariable(key, identity)) continue;
    found.set(key.slice("ALZ_".length + identity.length + 1), value);
  }
  return found;
}

const PATH_NAME = /(TOKEN_FILE(_PATH)?|CONFIG_DIR)$/i;
const CLIENT_ID_NAME = /CLIENT_ID$/i;

/**
 * The forms under which a principal value is compared: the trimmed text always;
 * a client id lowercased (GUIDs are case-insensitive); a token file or
 * configuration directory as its resolved path and, where it exists, its real
 * path and device+inode, so a symlink or hard link to the same file is the same
 * principal. Two values collide when any form is shared, so this never compares
 * less than the raw text did.
 */
export function comparableForms(name: string, value: string): string[] {
  const text = value.trim();
  const forms = ["raw:" + text];
  if (CLIENT_ID_NAME.test(name)) forms.push("raw:" + text.toLowerCase());
  if (PATH_NAME.test(name) && text !== "") {
    const resolved = resolve(text);
    forms.push("path:" + resolved);
    try {
      forms.push("path:" + realpathSync(resolved));
      const stat = statSync(resolved, { bigint: true });
      forms.push("inode:" + stat.dev + ":" + stat.ino);
    } catch {
      // Not present: the resolved path is all there is to compare.
    }
  }
  return forms;
}

/** The same principal or secret under the forms above. */
export function samePrincipalValue(nameA: string, valueA: string, nameB: string, valueB: string): boolean {
  const b = new Set(comparableForms(nameB, valueB));
  return comparableForms(nameA, valueA).some((form) => b.has(form));
}

/** A client id as stored in qualification evidence and compared with it: trimmed, lowercase. */
export const normalizeClientId = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * Variable names (never values) for which two identities carry the same secret
 * or the same principal (a client id, a token file, a CLI configuration
 * directory), under the same variable name or different ones. One credential
 * used for both collapses the separation the identities exist to provide.
 * Tenant and subscription ids are shared on purpose and are not compared.
 */
export function collapsedBetween(env: NodeJS.ProcessEnv, a: ExecutionIdentity, b: ExecutionIdentity): string[] {
  const other = [...identityVariables(env, b)].filter(([name]) => PRINCIPAL_NAME.test(name));
  const names = new Set<string>();
  for (const [nameA, valueA] of identityVariables(env, a)) {
    if (!PRINCIPAL_NAME.test(nameA)) continue;
    for (const [nameB, valueB] of other) if (samePrincipalValue(nameA, valueA, nameB, valueB)) names.add(nameA === nameB ? nameA : nameA + "/" + nameB);
  }
  return [...names].sort();
}

/** STATE and DISCOVERY, for the destroy-preview driver. */
export function collapsedIdentityVariables(env: NodeJS.ProcessEnv): string[] {
  return collapsedBetween(env, "STATE", "DISCOVERY");
}
