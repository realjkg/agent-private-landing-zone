
/**
 * Step 1 of every human-invoked driver: a person at an interactive session
 * named this exact target. The preview driver and the pilot apply driver share
 * this one check; neither imports the other's entry points. It reads only
 * `invocation` and `target`, so it takes any request.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const SAFE_OPERATOR = /^[A-Za-z0-9._@+-]{1,128}$/;
const TARGET_KEYS = ["account", "backend", "workspace"] as const;

export type HumanRefusal = { ok: false; code: "HUMAN_INVOCATION_REQUIRED" | "HUMAN_CONFIRMATION_MISMATCH"; message: string };
const refuse = (code: HumanRefusal["code"], message: string): HumanRefusal => ({ ok: false, code, message });

/** `subject` opens the first message ("A destroy preview", "An apply"); the check is the same for every driver. */
export function checkHumanInvocation(request: unknown, subject: string): HumanRefusal | undefined {
  const fields = isRecord(request) ? request : {};
  const invocation = fields.invocation;
  if (!isRecord(invocation) || typeof invocation.operatorId !== "string" ||
    !SAFE_OPERATOR.test(invocation.operatorId) || invocation.interactiveSession !== true ||
    typeof invocation.confirmedAt !== "string" || Number.isNaN(Date.parse(invocation.confirmedAt))) {
    return refuse("HUMAN_INVOCATION_REQUIRED",
      subject + " is run by a person: the request needs an invocation record with an operator id, " +
      "an interactive session and the time the target was confirmed. An agent cannot start one.");
  }
  const confirmed = invocation.confirmedTarget;
  const target = fields.target;
  if (!isRecord(confirmed) || !isRecord(target) ||
    TARGET_KEYS.some((key) => typeof confirmed[key] !== "string" || confirmed[key] !== target[key])) {
    return refuse("HUMAN_CONFIRMATION_MISMATCH",
      "The target the operator typed is not the exact target of this request (account, backend, workspace or stack).");
  }
  return undefined;
}
