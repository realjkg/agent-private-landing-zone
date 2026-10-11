import { identityVariables, PRINCIPAL_NAME, samePrincipalValue, type ExecutionIdentity } from "../../tools/identity.js";
import { stop } from "../engine.js";
import type { IdentityRefusal } from "../provider.js";
import { APPLY_IDENTITIES } from "../types.js";

/** A plain object, as parsed from JSON. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One segment of a backend key: no `..`, nothing that could end a quoted HCL string. */
export const KEY_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

/** An identity's variable, which must match `ok` before it is written into generated HCL; otherwise the backend configuration is unusable. */
export function pickIdentityValue(env: NodeJS.ProcessEnv, identity: ExecutionIdentity, name: string, ok: RegExp): string {
  const value = identityVariables(env, identity).get(name);
  return value !== undefined && ok.test(value) ? value : stop("STATE_WRITE_BACKEND_CONFIG_INVALID");
}

/**
 * The shared half of every spec's `ambientRefusal`: an identity variable that matches `fallback` would let a child
 * use something other than that identity's own credential, and an identity value equal to the operator's own
 * (`ambient` names the operator's variables, which are never handed to a child) means the identity is the operator.
 */
export function ambientRefusal(
  env: NodeJS.ProcessEnv, rule: { fallback: RegExp; ambient: RegExp; fallbackTo: string; advice: string },
): IdentityRefusal | undefined {
  const fallback = APPLY_IDENTITIES.flatMap((identity) =>
    [...identityVariables(env, identity).keys()].filter((name) => rule.fallback.test(name)).map((name) => "ALZ_" + identity + "_" + name));
  if (fallback.length > 0) {
    return { ok: false, code: "IDENTITY_NOT_CONFIGURED", message: "These variables would let a child fall back to " + rule.fallbackTo + ": " + fallback.join(", ") + ". " + rule.advice };
  }
  const ambient = Object.entries(env).filter(([key, value]) => !key.startsWith("ALZ_") && rule.ambient.test(key) && PRINCIPAL_NAME.test(key) && value);
  const inherited: string[] = [];
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, value] of identityVariables(env, identity)) {
      if (!PRINCIPAL_NAME.test(name)) continue;
      for (const [key, operatorValue] of ambient) if (samePrincipalValue(name, value, key, operatorValue ?? "")) inherited.push("ALZ_" + identity + "_" + name + " equals " + key);
    }
  }
  return inherited.length === 0 ? undefined : {
    ok: false,
    code: "IDENTITY_COLLAPSED",
    message: "These identities carry the operator's own credentials: " + inherited.join("; ") + ". No identity is the operator.",
  };
}
