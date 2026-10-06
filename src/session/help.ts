import type {
  OperatorPolicyDecision,
} from "./operator-policy.js";

export function promptGuide(): string {
  return [
    "Agentic Landing Zone · Prompt Guide",
    "",
    "You can talk to the operator normally. Good requests describe the infrastructure outcome rather than a raw command.",
    "",
    "Prompts that work:",
    '  “Inspect this AWS environment and summarize the inventory.”',
    '  “Which components have insecure or unknown posture?”',
    '  “What is our SBOM and recovery coverage?”',
    '  “Design the safest additive delta using AWS CDK.”',
    '  “Show the Ansible check-mode path for the attached edge nodes.”',
    '  “Why is this build blocked, and what evidence is missing?”',
    '  “Show credential rotation posture without revealing secret values.”',
    "",
    "Prompts that are blocked:",
    "  • requests to reveal passwords, tokens, private keys, or secret values",
    "  • requests to move private configuration/evidence outside the trust boundary",
    "  • requests to bypass approvals, policy, audit, identity, logging, or scanners",
    "  • requests for arbitrary shell/terminal execution",
    "  • unrelated first-turn work outside landing-zone operations",
    "",
    "Self-help:",
    "  type “help” or “prompt guide” in a session",
    "  type “why was that blocked?” after a denied request",
    "  run ./alz prompts from the operator shell",
    "  read docs/operator-guide.md for scenarios and supported plug-ins",
    "",
    "ACT remains disabled. The agent can explain the nearest safe alternative when a request is not allowed.",
  ].join("\n");
}

export function blockedPromptHelp(
  decision: Exclude<
    OperatorPolicyDecision,
    { allowed: true }
  >,
): string {
  return [
    "I can’t run that request in this Landing Zone.",
    "",
    "Boundary: " + decision.boundary,
    "Why: " + decision.reason,
    "",
    "Try this instead:",
    decision.safeAlternative,
    "",
    "For examples, type “prompt guide” or run ./alz prompts.",
  ].join("\n");
}
