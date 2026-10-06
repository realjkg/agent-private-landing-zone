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
    /what (else )?can you do|how can you help|what can i ask|what are you capable of/.test(value)
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
    /why is .*blocked|why was .*blocked|why did .*block|why can't|why can'?t|explain that|explain why|why\?$/.test(
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

function postureSummary(
  state: AgentState,
): string[] {
  const posture =
    state.postureAssessment;

  if (!posture) {
    return [
      "Security, SBOM, and resiliency posture have not been assessed yet.",
    ];
  }

  const highOrCritical =
    posture.findings.filter(
      (finding) =>
        finding.severity === "HIGH" ||
        finding.severity === "CRITICAL",
    ).length;

  return [
    "Security posture: " +
      posture.securityStatus +
      " (" +
      posture.findings.length +
      " findings, " +
      highOrCritical +
      " high/critical).",
    "SBOM posture: " +
      posture.sbom.status +
      " with " +
      posture.sbom.componentCount +
      " observed components.",
    "Resiliency posture: " +
      posture.resiliency.status +
      "; configuration backup " +
      posture.resiliency.configurationBackup +
      "; restore evidence " +
      posture.resiliency.restoreEvidence +
      ".",
    "Recovery snapshot: " +
      posture.recoverySnapshot.coverage +
      "; configuration hash " +
      posture.recoverySnapshot.configurationHash.slice(
        0,
        16,
      ) +
      "…",
  ];
}

export function formatAgentResponse(
  state: AgentState,
): string {
  const lines: string[] = [
    environmentSummary(state),
    "",
    ...postureSummary(state),
  ];

  if (
    state.intent === "ASSESS" &&
    state.engineeringAssessment
  ) {
    lines.push("");
    lines.push(
      "The strongest operational risk I see is: " +
        state.engineeringAssessment.topRisk,
    );
    lines.push(
      state.engineeringAssessment.whyItMatters,
    );
  }

  if (
    state.deltaAssessment &&
    state.environment?.classification ===
      "BROWNFIELD"
  ) {
    const reuse =
      state.deltaAssessment.decisions.filter(
        (decision) =>
          decision.action === "REUSE",
      ).length;
    const integrate =
      state.deltaAssessment.decisions.filter(
        (decision) =>
          decision.action === "INTEGRATE",
      ).length;
    const configure =
      state.deltaAssessment.decisions.filter(
        (decision) =>
          decision.action === "CONFIGURE",
      ).length;
    const blocked =
      state.deltaAssessment.decisions.filter(
        (decision) =>
          decision.action === "BLOCKED",
      ).length;

    lines.push("");
    lines.push(
      "Brownfield delta posture: " +
        reuse +
        " reuse / " +
        integrate +
        " integrate / " +
        configure +
        " configure / " +
        blocked +
        " blocked.",
    );
  }

  if (
    state.intent === "BUILD" ||
    state.intent === "CHANGE"
  ) {
    lines.push("");

    if (state.build) {
      lines.push(
        "I prepared a " +
          state.engine +
          " candidate. The build gate is " +
          (state.build.gate.allowed
            ? "passing"
            : "stopped") +
          ".",
      );

      if (
        state.build.gate.reasons.length >
        0
      ) {
        lines.push(
          "Reason: " +
            state.build.gate.reasons.join(
              " ",
            ),
        );
      }
    } else {
      lines.push(
        "I did not create a build candidate because the current safety or assessment gates do not permit it.",
      );
    }
  }

  lines.push("");
  lines.push(
    "No cloud changes were made. ACT is disabled.",
  );
  lines.push(
    "You can ask about inventory, security findings, SBOM coverage, resiliency, recovery, the brownfield delta, or what should be designed next.",
  );

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
      '  "Which components look insecure?"',
      '  "What is our SBOM coverage?"',
      '  "Is the landing zone recoverable?"',
      '  "What configuration is backed up?"',
      '  "Show me the brownfield delta."',
      '  "What should we design next?"',
      '  "Use Pulumi instead."',
      '  "Show me the evidence."',
      "",
      "I will infer the operation and keep the same session state. ACT remains disabled.",
    ].join("\n");
  }

  if (!state) {
    return [
      "I don't have an environment assessment in this session yet.",
      'Start naturally, for example: "Inspect this environment and assess its security and resiliency posture."',
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
        ". Security posture is " +
        (state.postureAssessment?.securityStatus ?? "UNKNOWN") +
        ". Resiliency is " +
        (state.postureAssessment?.resiliency.status ?? "UNKNOWN") +
        ". The selected IaC engine is " +
        (engine ?? state.engine) +
        ".",
      "Cloud mutation remains disabled.",
    ].join(" ");
  }

  if (command === "ENVIRONMENT") {
    return [
      environmentSummary(state),
      ...postureSummary(state),
    ].join("\n");
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

    if (
      state.postureAssessment &&
      state.postureAssessment.findings.length >
        0
    ) {
      return [
        "The current posture findings are:",
        ...state.postureAssessment.findings.map(
          (finding) =>
            "  • " +
            finding.severity +
            " " +
            finding.domain +
            ": " +
            finding.title,
        ),
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

    return "There is no recorded blocking or posture decision to explain in the current session.";
  }

  if (command === "NEXT") {
    if (
      state.environment?.classification ===
      "UNKNOWN"
    ) {
      return "The next safe step is better read-only discovery. I would not design or build against an UNKNOWN environment.";
    }

    if (!state.postureAssessment) {
      return "The next step is to complete security, SBOM, ownership, and resiliency assessment of the discovered estate.";
    }

    if (
      state.deltaAssessment?.designRequired
    ) {
      return "The next step is Design: turn the observed environment, posture findings, ownership boundaries, and desired outcome into an explicit delta design before generating IaC.";
    }

    return "The current discovery and assessment evidence is ready for design review. ACT remains disabled.";
  }

  if (command === "COMPARE_IAC") {
    return [
      "Both engines use the same discovery, ownership, security, SBOM, resiliency, evidence, and approval gates.",
      "Terraform is evaluated through validate/plan and normalized plan data; Pulumi is evaluated through preview and normalized preview data.",
      "For brownfield resources, the existing source of truth remains authoritative. The IaC engine should implement only the approved delta rather than infer a migration.",
      "Current session engine: " +
        (engine ?? state.engine) +
        ".",
    ].join("\n");
  }

  const evidence = [
    ...(state.observation?.evidence ?? []),
  ];

  if (state.postureAssessment) {
    evidence.push(
      "Posture assessment: " +
        state.postureAssessment.assessmentId,
    );
    evidence.push(
      "Recovery coverage: " +
        state.postureAssessment.recoverySnapshot.coverage,
    );
    evidence.push(
      "Recovery configuration SHA-256: " +
        state.postureAssessment.recoverySnapshot.configurationHash,
    );
    evidence.push(
      "SBOM status: " +
        state.postureAssessment.sbom.status,
    );
    evidence.push(
      "Restore evidence: " +
        state.postureAssessment.resiliency.restoreEvidence,
    );
  }

  if (state.build) {
    evidence.push(
      "Artifact SHA-256: " +
        state.build.candidate.artifact.contentHash,
    );
    evidence.push(
      "Preview SHA-256: " +
        (state.build.candidate.evidence.planHash ?? "missing"),
    );

    for (const reason of
      state.build.gate.reasons) {
      evidence.push(
        "Gate: " + reason,
      );
    }
  }

  if (evidence.length === 0) {
    evidence.push(
      "No execution evidence has been recorded yet.",
    );
  }

  return [
    "Here is the evidence currently attached to this session:",
    ...evidence.map(
      (item) => "  • " + item,
    ),
  ].join("\n");
}
