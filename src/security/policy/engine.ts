import {
  BuiltinSecurityPolicyEvaluator,
} from "./builtin.js";
import {
  OpaSecurityPolicyEvaluator,
  type OpaPolicyOptions,
} from "./opa.js";
import type {
  SecurityPolicyEvaluator,
} from "./types.js";

export type SecurityPolicyMode =
  | "BUILTIN"
  | "OPA";

export function createSecurityPolicyEvaluator(
  mode:
    | SecurityPolicyMode
    | undefined =
    process.env
      .AGENTIC_SECURITY_POLICY_MODE as
      | SecurityPolicyMode
      | undefined,
  opaOptions?: OpaPolicyOptions,
): SecurityPolicyEvaluator {
  if (mode === "OPA") {
    return new OpaSecurityPolicyEvaluator(
      opaOptions,
    );
  }

  if (
    mode === undefined ||
    mode === "BUILTIN"
  ) {
    return new BuiltinSecurityPolicyEvaluator();
  }

  throw new Error(
    "SECURITY_POLICY_MODE_INVALID: AGENTIC_SECURITY_POLICY_MODE must be BUILTIN or OPA (received " +
      JSON.stringify(String(mode).slice(0, 32)) +
      "); correct or unset the variable.",
  );
}
