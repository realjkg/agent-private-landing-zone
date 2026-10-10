/**
 * Execution identities for governed child processes
 * (docs/identity-and-execution-contracts.md).
 *
 * Exactly two identities exist. Neither is the operator's own credentials and
 * neither is the identity that deploys infrastructure; a child never falls back
 * from one to another, and never to something it was not handed.
 *
 *  - DISCOVERY: provider reads for discovery and previews (describe, list, plan
 *    refresh). Read-only by policy at the cloud side.
 *  - STATE: reads the state container (backend) for a destroy preview. It is a
 *    different principal from DISCOVERY because state is sensitive material and
 *    state access should not imply provider access, or the reverse.
 *
 * Locking stays on for every run. A state reader that cannot take the lock is
 * given the access to take it, not a way around it.
 */
export const EXECUTION_IDENTITIES = ["DISCOVERY", "STATE"] as const;
export type ExecutionIdentity = (typeof EXECUTION_IDENTITIES)[number];

export const DEFAULT_IDENTITY: ExecutionIdentity = "DISCOVERY";

export function isExecutionIdentity(value: string): value is ExecutionIdentity {
  return (EXECUTION_IDENTITIES as readonly string[]).includes(value);
}

/**
 * Prefixes that name an identity this system must never read from. Setting one
 * is a configuration mistake worth reporting, because an operator who exports
 * `ALZ_DEPLOY_AWS_ACCESS_KEY_ID` expects something to use it.
 */
const FORBIDDEN_IDENTITY_PREFIXES = /^ALZ_(DEPLOY|DEPLOYMENT|OPERATOR|ADMIN|APPLY|DESTROY)_/;

export function forbiddenIdentityVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => FORBIDDEN_IDENTITY_PREFIXES.test(key)).sort();
}

const SECRET_SUFFIX = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|ACCESS_KEY|SESSION)/i;

/**
 * Variable names (never values) for which STATE and DISCOVERY carry the same
 * secret. One credential used for both collapses the separation the two
 * identities exist to provide.
 */
export function collapsedIdentityVariables(env: NodeJS.ProcessEnv): string[] {
  const collapsed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("ALZ_STATE_") || value === undefined || value === "") continue;
    const name = key.slice("ALZ_STATE_".length);
    if (SECRET_SUFFIX.test(name) && env["ALZ_DISCOVERY_" + name] === value) collapsed.push(name);
  }
  return collapsed.sort();
}
