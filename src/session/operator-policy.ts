import {
  screenOperatorPrompt,
} from "../security/prompt-governance.js";

export type OperatorBoundary =
  | "SECRET_DISCLOSURE"
  | "EXFILTRATION"
  | "CONTROL_BYPASS"
  | "ARBITRARY_EXECUTION"
  | "OUT_OF_SCOPE";

export type OperatorPolicyDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      boundary: OperatorBoundary;
      reason: string;
      safeAlternative: string;
    };

const IN_SCOPE =
  /landing zone|aws|azure|cloud|private|edge|infrastructure|inventory|resource|sbom|security|resilien|recovery|backup|terraform|pulumi|opentofu|tofu|bicep|cloudformation|cdk|crossplane|ansible|design|build|preview|plan|policy|govern|drift|network|identity|iam|rbac|kubernetes|k8s|vmware|datacenter|appliance|evidence|posture/i;

export function evaluateOperatorRequest(
  request: string,
  hasSessionContext: boolean,
): OperatorPolicyDecision {
  const value = request.trim().toLowerCase();

  const promptScreen =
    screenOperatorPrompt(request);

  if (!promptScreen.allowed) {
    return {
      allowed: false,
      boundary: "CONTROL_BYPASS",
      reason:
        promptScreen.reason ??
        "The request attempts to change or bypass the governed prompt boundary.",
      safeAlternative:
        "State the infrastructure outcome you need without asking the agent to ignore instructions, change roles, reveal hidden prompts, or bypass the tool broker.",
    };
  }

  const safeSecretMetadataRequest =
    /(credential|secret|token|key).{0,50}(metadata|age|rotation|scope|owner|reference|posture)|(?:metadata|age|rotation|scope|owner|reference|posture).{0,50}(credential|secret|token|key)/i.test(
      value,
    ) &&
    /without (revealing|showing|returning|displaying).{0,30}(secret|value|credential|token|key)/i.test(
      value,
    );

  if (
    !safeSecretMetadataRequest &&
    (
      /(show|print|dump|reveal|give me|display|return).{0,40}(password|secret|token|api key|access key|private key|credential)/i.test(
        value,
      ) ||
      /(password|secret|token|api key|access key|private key|credential).{0,40}(value|contents|plaintext|plain text)/i.test(
        value,
      )
    )
  ) {
    return {
      allowed: false,
      boundary: "SECRET_DISCLOSURE",
      reason:
        "Secret values and private credential material are never returned to the operator or model.",
      safeAlternative:
        "Ask for credential metadata, age, rotation status, scope, ownership, or whether a secret reference is configured correctly—without revealing the secret value.",
    };
  }

  if (
    /(send|upload|post|copy|forward|export|transfer).{0,60}(secret|credential|private|sensitive|config|evidence|sbom|inventory|customer data).{0,60}(external|public|internet|remote|third[- ]party|outside)/i.test(
      value,
    ) ||
    /(exfiltrat|data leak|leak .*secret)/i.test(
      value,
    )
  ) {
    return {
      allowed: false,
      boundary: "EXFILTRATION",
      reason:
        "Private environment data, evidence, configuration, and secrets cannot be moved outside the approved trust boundary.",
      safeAlternative:
        "Ask for a redacted local summary, evidence hash, or approved export manifest that omits secret values and remains inside the configured workspace.",
    };
  }

  if (
    /(disable|bypass|ignore|turn off|circumvent|skip).{0,50}(guardrail|policy|approval|audit|logging|evidence|security|scanner|scan|sbom|identity|authentication|authorization|control)/i.test(
      value,
    ) ||
    /ignore .{0,30}(system|previous|operator).{0,20}instruction|override .{0,30}system prompt|reveal .{0,30}system prompt/i.test(
      value,
    ) ||
    /(hide|erase|remove).{0,40}(audit|evidence|log|trace)/i.test(
      value,
    )
  ) {
    return {
      allowed: false,
      boundary: "CONTROL_BYPASS",
      reason:
        "Governance, audit, approval, identity, and security controls cannot be bypassed from the operator conversation.",
      safeAlternative:
        "Ask which control is blocking the request, what evidence it requires, and what approved configuration change would satisfy the control.",
    };
  }

  if (
    /(open|give me|start|launch).{0,25}(shell|terminal|bash|powershell|command prompt)/i.test(
      value,
    ) ||
    /(run|execute).{0,30}(arbitrary|any command|raw command|shell command)/i.test(
      value,
    ) ||
    /curl .*(\||;).*bash|wget .*(\||;).*sh/i.test(
      value,
    )
  ) {
    return {
      allowed: false,
      boundary: "ARBITRARY_EXECUTION",
      reason:
        "The Landing Zone exposes typed, allowlisted tools rather than arbitrary shell or command execution.",
      safeAlternative:
        "Describe the infrastructure outcome you need. The agent can select an approved discovery, validation, preview, or configuration adapter and explain what is available.",
    };
  }

  if (
    /crypto(?:currency)? mining|mine cryptocurrency|reverse shell|credential harvesting|keylogger|persistence mechanism/i.test(
      value,
    )
  ) {
    return {
      allowed: false,
      boundary: "OUT_OF_SCOPE",
      reason:
        "The requested activity is outside the governed infrastructure lifecycle supported by this Landing Zone.",
      safeAlternative:
        "Describe the legitimate infrastructure, security, recovery, or configuration outcome you need and the agent can map it to an approved workflow.",
    };
  }

  if (
    !hasSessionContext &&
    value.length > 0 &&
    !IN_SCOPE.test(value) &&
    !/help|what can you do|how do i|prompt|status|environment|evidence|what did you find|next|compare|why|explain/i.test(
      value,
    )
  ) {
    return {
      allowed: false,
      boundary: "OUT_OF_SCOPE",
      reason:
        "This operator is intentionally scoped to governed landing-zone discovery, assessment, design, preview, governance, recovery, and management workflows.",
      safeAlternative:
        "Ask about the environment, security/SBOM/resiliency posture, a DesignSpec, a supported build plug-in, recovery readiness, or a preview-only infrastructure change.",
    };
  }

  return { allowed: true };
}
