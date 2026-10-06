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
    /\bdesign\b|target architecture|propose architecture/.test(
      value,
    )
  ) {
    return "DESIGN";
  }

  if (
    /build|generate|terraform|pulumi|opentofu|\btofu\b|\bbicep\b|cloudformation|\bcdk\b|crossplane|ansible|iac|infrastructure as code/.test(
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
    /discover|inspect|inventory|what exists|list resources|show resources|enumerate resources|scan environment|scan landing zone/.test(
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
