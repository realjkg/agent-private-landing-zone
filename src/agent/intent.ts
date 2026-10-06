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
    /discover|inventory|what exists|resources|environment/.test(
      value,
    )
  ) {
    return "DISCOVER";
  }

  if (
    /assess|review|risk|architecture|evaluate|recommend/.test(
      value,
    )
  ) {
    return "ASSESS";
  }

  return "ANSWER";
}

export function intentRequestsMutation(
  intent: AgentIntent,
): boolean {
  return intent === "CHANGE";
}
