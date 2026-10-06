import type { AgentState } from "../agent/types.js";
import type { IaCEngine } from "../build/types.js";
import type { SessionCommand } from "./types.js";

export function classifySessionCommand(
  request: string,
): SessionCommand {
  const value = request.trim().toLowerCase();

  if (
    value === ":help" ||
    value === "help" ||
    /what can you do|how can you help|what can i ask/.test(value)
  ) {
    return "HELP";
  }

  if (
    value === ":status" ||
    value === "status" ||
    /current status|where are we|what is the status|where do things stand/.test(value)
  ) {
    return "STATUS";
  }

  if (
    value === ":environment" ||
    value === "environment" ||
    /what did you find|show environment|what resources|environment state|what exists|what's there/.test(
      value,
    )
  ) {
    return "ENVIRONMENT";
  }

  if (
    value === ":evidence" ||
    value === "evidence" ||
    /show evidence|what evidence|show me the evidence|what supports that/.test(
      value,
    )
  ) {
    return "EVIDENCE";
  }

  if (
    /why is .*blocked|why was .*blocked|why did .*block|why can't|why can'?t|explain that|explain why|why?$/.test(
      value,
    )
  ) {
    return "EXPLAIN";
  }

  if (
    /what should (we|i) do next|what's next|what is next|next step|where do we go from here/.test(
      value,
    )
  ) {
    return "NEXT";
  }

  if (
    /compare .*terraform.*pulumi|compare .*pulumi.*terraform|terraform vs pulumi|pulumi vs terraform|which .*terraform.*pulumi/.test(
      value,
    )
  ) {
    return "COMPARE_IAC";
  }

  if (
    /use pulumi|switch to pulumi|try pulumi|with pulumi instead|pulumi instead/.test(
      value,
    )
  ) {
    return "USE_PULUMI";
  }

  if (
    /use terraform|switch to terraform|try terraform|with terraform instead|terraform instead/.test(
      value,
    )
  ) {
    return "USE_TERRAFORM";
  }

  return "RUN";
}

function environmentSummary(
  state: AgentState,
): string {
  return [
    "I found a " +
      (state.environment?.classification ?? "UNKNOWN") +
      " " +
      state.provider +
      " environment.",
    "The control plane is " +
      (state.environment?.controlPlane ?? "UNKNOWN") +
      ", with " +
      (state.environment?.resources.length ?? 0) +
      " discovered resources and " +
      (state.environment?.conflicts.length ?? 0) +
      " ownership conflicts.",
    "The current safe build mode is " +
      (state.environment?.safeBuildMode ?? "UNKNOWN") +
      ".",
  ].join(" ");
}

export function formatAgentResponse(
  state: AgentState,
): string {
  const lines: string[] = [];

  if (state.intent === "DISCOVER") {
    lines.push(environmentSummary(state));
  } else if (state.intent === "ASSESS") {
    lines.push(environmentSummary(state));

    if (state.engineeringAssessment) {
      lines.push("");
      lines.push(
        "The strongest operational risk I see is: " +
          state.engineeringAssessment.topRisk,
      );
      lines.push(
        state.engineeringAssessment.whyItMatters,
      );
    }
  } else if (
    state.intent === "BUILD" ||
    state.intent === "CHANGE"
  ) {
    lines.push(environmentSummary(state));

    if (state.build) {
      lines.push("");
      lines.push(
        "I prepared a " +
          state.engine +
          " candidate. The build gate is " +
          (state.build.gate.allowed ? "passing" : "stopped") +
          ".",
      );

      if (state.build.gate.reasons.length > 0) {
        lines.push(
          "Reason: " +
            state.build.gate.reasons.join(" "),
        );
      }
    } else {
      lines.push("");
      lines.push(
        "I did not create a build candidate because the current safety or assessment gates do not permit it.",
      );
    }
  } else {
    lines.push(environmentSummary(state));
  }

  lines.push("");
  lines.push(
    "No cloud changes were made. ACT is disabled.",
  );

  if (state.build) {
    lines.push(
      "You can ask me to show the evidence, explain why the gate stopped, or compare this approach with the other IaC engine.",
    );
  } else {
    lines.push(
      "You can ask what I found, why it matters, what I recommend next, or ask me to assess/build something.",
    );
  }

  return lines.join("\n");
}

export function answerStateQuery(
  command: Exclude<
    SessionCommand,
    "RUN" | "USE_TERRAFORM" | "USE_PULUMI"
  >,
  state?: AgentState,
  engine?: IaCEngine,
): string {
  if (command === "HELP") {
    return [
      "Talk to me normally. For example:",
      "",
      '  "Inspect this AWS environment."',
      '  "What did you find?"',
      '  "What is the biggest operational risk?"',
      '  "Build a safe Terraform proposal."',
      '  "Use Pulumi instead."',
      '  "Why is this blocked?"',
      '  "Show me the evidence."',
      '  "Compare Terraform with Pulumi."',
      '  "What should we do next?"',
      "",
      "I will infer the operation and keep the same session state. ACT remains disabled.",
    ].join("\n");
  }

  if (!state) {
    return [
      "I don't have an environment assessment in this session yet.",
      'You can start naturally, for example: "Inspect this environment and tell me the biggest risk."',
    ].join("\n");
  }

  if (command === "STATUS") {
    return [
      "We're currently at " +
        state.phase +
        " for a " +
        state.environment?.classification +
        " " +
        state.provider +
        " environment.",
      "Safe build mode is " +
        (state.environment?.safeBuildMode ?? "UNKNOWN") +
        ". The selected IaC engine is " +
        (engine ?? state.engine) +
        ".",
      "Cloud mutation remains disabled.",
    ].join(" ");
  }

  if (command === "ENVIRONMENT") {
    return environmentSummary(state);
  }

  if (command === "EXPLAIN") {
    const reasons =
      state.build?.gate.reasons ?? [];

    if (reasons.length > 0) {
      return [
        "The current build is stopped because:",
        ...reasons.map(
          (reason) => "  • " + reason,
        ),
        "",
        "Those are deterministic gate decisions, not model preferences.",
      ].join("\n");
    }

    if (state.engineeringAssessment) {
      return [
        "The main concern is " +
          state.engineeringAssessment.topRisk +
          ".",
        state.engineeringAssessment.whyItMatters,
      ].join(" ");
    }

    return "There is no recorded blocking decision to explain in the current session.";
  }

  if (command === "NEXT") {
    if (
      state.environment?.classification === "UNKNOWN"
    ) {
      return "The next safe step is better read-only discovery. I would not build against an UNKNOWN environment.";
    }

    if (!state.assessment) {
      return "The next step is to assess the discovered environment before generating infrastructure.";
    }

    if (!state.build) {
      return (
        "The next step is to generate a preview-only " +
        (engine ?? state.engine) +
        " candidate and evaluate it against ownership and policy gates."
      );
    }

    if (!state.build.gate.allowed) {
      return "The next step is to resolve the build-gate reasons, then regenerate and revalidate the exact candidate. No apply operation is available.";
    }

    return "The candidate has passed the current build gate. The MVP stops at evidence and approval because ACT is disabled.";
  }

  if (command === "COMPARE_IAC") {
    return [
      "Both engines use the same discovery, ownership, policy, evidence, and approval gates.",
      "Terraform is evaluated through validate/plan and normalized plan data; Pulumi is evaluated through preview and normalized preview data.",
      "For this environment, I would preserve whichever engine already owns the target resources. If ownership is not established, I would keep the comparison preview-only rather than infer a migration.",
      "Current session engine: " +
        (engine ?? state.engine) +
        ".",
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
    evidence.push(
      "No execution evidence has been recorded yet.",
    );
  }

  return [
    "Here is the evidence currently attached to this session:",
    ...evidence.map((item) => "  • " + item),
  ].join("\n");
}
