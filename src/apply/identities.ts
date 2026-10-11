import { collapsedBetween, identityVariables, normalizeClientId, PRINCIPAL_NAME, samePrincipalValue } from "../tools/identity.js";
import { APPLY_IDENTITIES, type ApplyEnvironment, type ApplyIdentity, type PilotContract } from "./types.js";

type ApplyIdentityCheck =
  | { ok: true }
  | { ok: false; code: "IDENTITY_NOT_CONFIGURED" | "IDENTITY_COLLAPSED"; message: string };

/**
 * Anything that lets a child fall back to the az CLI, a managed identity, a
 * certificate or an Azure SDK default instead of the identity's own OIDC token
 * file. The apply identities use `ARM_*` with `ARM_USE_OIDC` and
 * `ARM_OIDC_TOKEN_FILE` only.
 */
const FALLBACK_VARIABLE = /^(AZURE_.*|ARM_USE_(?!OIDC$).*|ARM_MSI_.*|ARM_CLIENT_CERTIFICATE.*)$/;

/**
 * The single enforcement point for apply identities: all four are configured
 * (`ALZ_<IDENTITY>_<VAR>`), no two carry the same secret or principal, none can
 * fall back to the az CLI or ambient credentials, and none equals the
 * operator's own `AZURE_*` / `ARM_*` credentials in the same environment.
 * Messages name identities and variables, never values. The same-uid operator
 * who holds these variables is inside the trust boundary; this refuses honest
 * mistakes and crafted environments, it does not stop that operator.
 */
export function checkApplyIdentities(env: NodeJS.ProcessEnv): ApplyIdentityCheck {
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
  const fallback = APPLY_IDENTITIES.flatMap((identity) =>
    [...identityVariables(env, identity).keys()].filter((name) => FALLBACK_VARIABLE.test(name)).map((name) => "ALZ_" + identity + "_" + name));
  if (fallback.length > 0) {
    return {
      ok: false,
      code: "IDENTITY_NOT_CONFIGURED",
      message: "These variables would let a child fall back to the az CLI or ambient credentials: " + fallback.join(", ") +
        ". The apply identities use ARM_* with an OIDC token file only.",
    };
  }
  const ambient = Object.entries(env).filter(([key, value]) => !key.startsWith("ALZ_") && /^(AZURE|ARM)_/.test(key) && PRINCIPAL_NAME.test(key) && value);
  const inherited: string[] = [];
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, value] of identityVariables(env, identity)) {
      if (!PRINCIPAL_NAME.test(name)) continue;
      for (const [key, operatorValue] of ambient) if (samePrincipalValue(name, value, key, operatorValue ?? "")) inherited.push("ALZ_" + identity + "_" + name + " equals " + key);
    }
  }
  if (inherited.length > 0) {
    return {
      ok: false,
      code: "IDENTITY_COLLAPSED",
      message: "These identities carry the operator's own credentials: " + inherited.join("; ") + ". No identity is the operator.",
    };
  }
  return { ok: true };
}

/** The identity's `ARM_CLIENT_ID`, trimmed and lowercase; empty when unset. Qualification evidence records and compares this form. */
export const attestedClientId = (env: NodeJS.ProcessEnv, identity: ApplyIdentity): string => normalizeClientId(identityVariables(env, identity).get("ARM_CLIENT_ID"));

type IdentityTargetCheck = { ok: true } | { ok: false; code: "IDENTITY_TARGET_MISMATCH"; message: string };

/** The identities that write must say where they write: both variables set, not only equal when present. */
const MUST_NAME_TARGET: readonly ApplyIdentity[] = ["STATE_WRITE", "APPLY"];

/**
 * Every identity's `ARM_TENANT_ID` and `ARM_SUBSCRIPTION_ID`, when present, must
 * be the environment's tenant and subscription from the pinned contract, and
 * APPLY and STATE_WRITE must set both. A credential for another tenant or
 * subscription, or one that names none, cannot apply here. Messages name
 * variables, never values.
 */
export function verifyIdentityTargets(contract: PilotContract, environment: ApplyEnvironment, env: NodeJS.ProcessEnv): IdentityTargetCheck {
  const target = Object.hasOwn(contract.targets, environment) ? contract.targets[environment] : undefined;
  const wrong: string[] = [];
  for (const identity of APPLY_IDENTITIES) {
    const variables = identityVariables(env, identity);
    for (const [name, expected] of [["ARM_TENANT_ID", target?.tenantId], ["ARM_SUBSCRIPTION_ID", target?.subscriptionId]] as const) {
      const actual = variables.get(name);
      const required = MUST_NAME_TARGET.includes(identity);
      if (actual === undefined ? required : expected === undefined || actual.toLowerCase() !== expected.toLowerCase()) {
        wrong.push("ALZ_" + identity + "_" + name + (actual === undefined ? " (not set)" : ""));
      }
    }
  }
  return wrong.length === 0 ? { ok: true } : {
    ok: false,
    code: "IDENTITY_TARGET_MISMATCH",
    message: "These identity variables are not set to the " + environment + " tenant and subscription in the pilot contract: " + wrong.join(", ") + ".",
  };
}
