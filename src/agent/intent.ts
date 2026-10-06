import type { AgentIntent } from "./types.js";

export function classifyIntent(
  request: string,
): AgentIntent {
  const value = request.toLowerCase();

  if (
    /deploy|apply|provision|create|change|modify|update|remove|delete/.test(
      value,
    )
  ) {
    return "CHANGE";
  }

  if (
    /build|generate|terraform|pulumi|iac|infrastructure as code/.test(
      value,
    )
  ) {
    return "BUILD";
  }

  if (
    /assess|review|risk|architecture|evaluate|recommend/.test(
      value,
    )
  ) {
    return "ASSESS";
  }

  if (
    /discover|inventory|what exists|list resources|show resources|enumerate resources/.test(
      value,
    )
  ) {
    return "DISCOVER";
  }

  return "ANSWER";
}

export function intentRequestsMutation(
  intent: AgentIntent,
): boolean {
  return intent === "CHANGE";
}
