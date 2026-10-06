import type { AgentState } from "../agent/types.js";
import type { SessionCommand } from "./types.js";

export function classifySessionCommand(
  request: string,
): SessionCommand {
  const value = request.trim().toLowerCase();

  if (
    value === ":help" ||
    value === "help"
  ) {
    return "HELP";
  }

  if (
    value === ":status" ||
    value === "status" ||
    /current status|where are we|what is the status/.test(value)
  ) {
    return "STATUS";
  }

  if (
    value === ":environment" ||
    value === "environment" ||
    /what did you find|show environment|what resources|environment state/.test(
      value,
    )
  ) {
    return "ENVIRONMENT";
  }

  if (
    value === ":evidence" ||
    value === "evidence" ||
    /show evidence|what evidence|why was .*blocked|why did .*block/.test(
      value,
    )
  ) {
    return "EVIDENCE";
  }

  return "RUN";
}

export function answerStateQuery(
  command: Exclude<SessionCommand, "RUN">,
  state?: AgentState,
): string {
  if (command === "HELP") {
    return [
      "Commands:",
      "  :status       current agent state",
      "  :environment  discovered environment",
      "  :evidence     evidence and gate results",
      "  :help         this help",
      "  :quit         end session",
      "",
      "Natural-language requests are routed through the Agent Kernel.",
    ].join("\n");
  }

  if (!state) {
    return "No agent state exists yet. Run an assessment or discovery request first.";
  }

  if (command === "STATUS") {
    return [
      "Status",
      "  intent: " + state.intent,
      "  phase: " + state.phase,
      "  provider: " + state.provider,
      "  engine: " + state.engine,
      "  safeBuildMode: " +
        (state.environment?.safeBuildMode ?? "UNKNOWN"),
      "  action: " +
        (state.action?.status ?? "NOT_REQUIRED"),
    ].join("\n");
  }

  if (command === "ENVIRONMENT") {
    return [
      "Environment",
      "  provider: " +
        (state.environment?.provider ?? state.provider),
      "  classification: " +
        (state.environment?.classification ?? "UNKNOWN"),
      "  controlPlane: " +
        (state.environment?.controlPlane ?? "UNKNOWN"),
      "  resources: " +
        (state.environment?.resources.length ?? 0),
      "  conflicts: " +
        (state.environment?.conflicts.length ?? 0),
      "  safeBuildMode: " +
        (state.environment?.safeBuildMode ?? "UNKNOWN"),
    ].join("\n");
  }

  const evidence = [
    ...(state.observation?.evidence ?? []),
  ];

  if (state.build) {
    evidence.push(
      "Artifact SHA-256: " +
        state.build.candidate.artifact.contentHash,
    );
    evidence.push(
      "Preview SHA-256: " +
        (state.build.candidate.evidence.planHash ?? "missing"),
    );

    for (const reason of state.build.gate.reasons) {
      evidence.push("Gate: " + reason);
    }
  }

  if (evidence.length === 0) {
    evidence.push("No execution evidence has been recorded yet.");
  }

  return [
    "Evidence",
    ...evidence.map((item) => "  " + item),
  ].join("\n");
}
