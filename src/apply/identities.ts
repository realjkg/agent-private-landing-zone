import { collapsedBetween, identityVariables, normalizeClientId } from "../tools/identity.js";
import type { IdentityRefusal, ProviderSpec } from "./provider.js";
import { APPLY_IDENTITIES, type ApplyEnvironment, type ApplyIdentity, type PilotContract } from "./types.js";

type ApplyIdentityCheck = { ok: true } | IdentityRefusal;

/**
 * The single enforcement point for apply identities: all four are configured
 * (`ALZ_<IDENTITY>_<VAR>`), no two carry the same secret or principal, none can
 * fall back to a CLI or ambient credentials, and none equals the operator's own
 * credentials in the same environment (the last two are the provider's, `ProviderSpec.ambientRefusal`).
 * Messages name identities and variables, never values. The same-uid operator
 * who holds these variables is inside the trust boundary; this refuses honest
 * mistakes and crafted environments, it does not stop that operator.
 */
export function checkApplyIdentities(env: NodeJS.ProcessEnv, spec: ProviderSpec): ApplyIdentityCheck {
  const missing = APPLY_IDENTITIES.filter((identity) => identityVariables(env, identity).size === 0);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "IDENTITY_NOT_CONFIGURED",
      message: "No credentials are configured for the " + missing.join(", ") + " identity (variables named ALZ_<IDENTITY>_<VARIABLE>). " +
        "No identity falls back to another, to the operator's own credentials, or to APPLY for state access.",
    };
  }
  const collapsed: string[] = [];
  APPLY_IDENTITIES.forEach((a, index) => {
    for (const b of APPLY_IDENTITIES.slice(index + 1)) {
      const names = collapsedBetween(env, a, b);
      if (names.length > 0) collapsed.push(a + " and " + b + " (" + names.join(", ") + ")");
    }
  });
  if (collapsed.length > 0) {
    return {
      ok: false,
      code: "IDENTITY_COLLAPSED",
      message: "These identities carry the same secret or client id: " + collapsed.join("; ") +
        ". Each identity must be a separate principal.",
    };
  }
  return spec.ambientRefusal(env) ?? { ok: true };
}

/** The identity's client id, trimmed and lowercase; empty when unset. Qualification evidence records and compares this form. */
export const attestedClientId = (env: NodeJS.ProcessEnv, identity: ApplyIdentity, spec: ProviderSpec): string =>
  normalizeClientId(identityVariables(env, identity).get(spec.clientIdVariable));

type IdentityTargetCheck = { ok: true } | { ok: false; code: "IDENTITY_TARGET_MISMATCH"; message: string };

/** The identities that write must say where they write: both variables set, not only equal when present. */
const MUST_NAME_TARGET: readonly ApplyIdentity[] = ["STATE_WRITE", "APPLY"];

/**
 * Every identity's target variables (`ProviderSpec.identityTargetVariables`),
 * when present, must be the environment's account from the pinned contract, and
 * APPLY and STATE_WRITE must set all of them. A credential for another account,
 * or one that names none, cannot apply here. Messages name variables, never values.
 */
export function verifyIdentityTargets(contract: PilotContract, environment: ApplyEnvironment, env: NodeJS.ProcessEnv, spec: ProviderSpec): IdentityTargetCheck {
  const target = Object.hasOwn(contract.targets, environment) ? contract.targets[environment] : undefined;
  const wrong: string[] = [];
  for (const identity of APPLY_IDENTITIES) {
    const variables = identityVariables(env, identity);
    for (const [name, isTarget] of Object.entries(spec.identityTargetVariables)) {
      const actual = variables.get(name);
      const required = MUST_NAME_TARGET.includes(identity);
      if (actual === undefined ? required : target === undefined || !isTarget(actual, target)) {
        wrong.push("ALZ_" + identity + "_" + name + (actual === undefined ? " (not set)" : ""));
      }
    }
  }
  return wrong.length === 0 ? { ok: true } : {
    ok: false,
    code: "IDENTITY_TARGET_MISMATCH",
    message: "These identity variables are not set to the " + environment + " " + spec.targetNoun + " in the pilot contract: " + wrong.join(", ") + ".",
  };
}
