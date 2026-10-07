import {
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

import type {
  AgentState,
} from "../agent/types.js";
import type {
  LocalModelMetadata,
} from "../ollama.js";
import type {
  OperatorPolicyDecision,
} from "../session/operator-policy.js";
import {
  getToolSecurityPosture,
} from "../tools/broker.js";

export type DebugModelInventory = {
  role:
    | "ROUTER"
    | "PRIMARY"
    | "VALIDATOR";
  configuredModel: string;
  installed: boolean;
  digest?: string;
  size?: number;
  inventoryError?: string;
};

export type DebugReport = {
  schemaVersion: 1;
  generatedAt: string;
  runId: string;
  operatingMode:
    "PREVIEW_OPERATE";
  actEnabled: false;
  requestFingerprint: string;
  provider: AgentState["provider"];
  engine: AgentState["engine"];
  intent: AgentState["intent"];
  phase: AgentState["phase"];
  durationMs?: number;
  policy: {
    decisionId: string;
    allowed: boolean;
    boundary?: string;
    reason?: string;
  };
  orchestration: {
    phaseOrder: string[];
    roles: string[];
    validatorRequired: boolean;
    actEnabled: false;
  };
  models: DebugModelInventory[];
  reasoning: {
    status:
      | "NOT_RUN"
      | "OK"
      | "DATA_REQUIRED"
      | "ABSTAIN";
    verificationRequired: boolean;
    validator:
      | "NOT_REQUIRED"
      | "PARTICIPATED"
      | "MISSING";
    adjudication:
      | "NOT_REQUIRED"
      | "PARTICIPATED"
      | "DISAGREE_ABSTAIN"
      | "MISSING";
    modelInvocations: Array<{
      role: string;
      model: string;
      durationMs: number;
      structuredOutput: true;
      schemaValid: true;
    }>;
  };
  grounding: {
    status:
      | "NOT_EVALUATED"
      | "EVIDENCE_REQUIRED"
      | "ENVIRONMENT_UNKNOWN"
      | "ASSUMPTIONS_PRESENT"
      | "AVAILABLE_EVIDENCE";
    assumptionCount: number;
    evidenceRefs: string[];
    unsupportedClaimRisk:
      | "NONE_OBSERVED"
      | "REVIEW_REQUIRED";
  };
  execution: Array<{
    at: string;
    phase: string;
    event: string;
    durationMs?: number;
    detail?: string;
  }>;
  build?: {
    plugin?: string;
    gateAllowed: boolean;
    reasons: string[];
    executionMode: "PREVIEW_ONLY";
  };
  action: {
    attempted: boolean;
    executed: boolean;
    status: string;
    reason: string;
    mutationObserved: boolean;
  };
  toolBoundary: {
    arbitraryShell: false;
    cloudReadDefault: boolean;
    projectCodeExecutionDefault: boolean;
    previewWriteDefault: boolean;
    managedAccessDefault: boolean;
    mutationToolCount: number;
  };
  failure?: {
    category:
      | "POLICY"
      | "MODEL_OR_SCHEMA"
      | "STATE"
      | "ADAPTER_OR_BUILD"
      | "RUNTIME";
    message: string;
  };
};

const SENSITIVE_ASSIGNMENT =
  /\b(secret|password|token|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*[^\s,;]+/gi;
const BEARER =
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export function redactDebugText(
  value: string,
): string {
  return value
    .replace(
      SENSITIVE_ASSIGNMENT,
      (match) => {
        const key =
          match.split(
            /\s*[:=]\s*/,
          )[0] ??
          "sensitive";
        return (
          key +
          "=[REDACTED]"
        );
      },
    )
    .replace(
      BEARER,
      "Bearer [REDACTED]",
    )
    .slice(0, 512);
}

function fingerprint(
  value: string,
): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function evidenceRefs(
  state: AgentState,
): string[] {
  const refs = new Set<string>();

  for (
    const ref of
    state.orchestration?.task
      .evidenceRefs ?? []
  ) {
    refs.add(
      redactDebugText(ref),
    );
  }

  for (
    const ref of
    state.design?.evidenceRefs ??
    []
  ) {
    refs.add(
      redactDebugText(ref),
    );
  }

  for (
    const ref of
    state.observation?.evidence ??
    []
  ) {
    refs.add(
      redactDebugText(ref),
    );
  }

  return [...refs].slice(0, 50);
}

function grounding(
  state: AgentState,
  refs: string[],
): DebugReport["grounding"] {
  const assessment =
    state.assessment;

  if (!assessment) {
    return {
      status:
        "NOT_EVALUATED",
      assumptionCount: 0,
      evidenceRefs: refs,
      unsupportedClaimRisk:
        "NONE_OBSERVED",
    };
  }

  const assumptions =
    assessment.primary
      ?.assumptions.length ?? 0;

  if (
    assessment.status ===
    "DATA_REQUIRED"
  ) {
    return {
      status:
        "EVIDENCE_REQUIRED",
      assumptionCount:
        assumptions,
      evidenceRefs: refs,
      unsupportedClaimRisk:
        "REVIEW_REQUIRED",
    };
  }

  if (
    state.environment
      ?.classification ===
    "UNKNOWN"
  ) {
    return {
      status:
        "ENVIRONMENT_UNKNOWN",
      assumptionCount:
        assumptions,
      evidenceRefs: refs,
      unsupportedClaimRisk:
        "REVIEW_REQUIRED",
    };
  }

  if (assumptions > 0) {
    return {
      status:
        "ASSUMPTIONS_PRESENT",
      assumptionCount:
        assumptions,
      evidenceRefs: refs,
      unsupportedClaimRisk:
        "REVIEW_REQUIRED",
    };
  }

  return {
    status:
      "AVAILABLE_EVIDENCE",
    assumptionCount: 0,
    evidenceRefs: refs,
    unsupportedClaimRisk:
      "NONE_OBSERVED",
  };
}

function failure(
  state: AgentState,
): DebugReport["failure"] {
  if (!state.error) {
    return undefined;
  }

  const message =
    redactDebugText(
      state.error,
    );

  if (
    /PROMPT_POLICY|POLICY|GUARDRAIL/i.test(
      state.error,
    )
  ) {
    return {
      category: "POLICY",
      message,
    };
  }

  if (
    /MODEL|ROUTER|OLLAMA|JSON|SCHEMA/i.test(
      state.error,
    )
  ) {
    return {
      category:
        "MODEL_OR_SCHEMA",
      message,
    };
  }

  if (
    /DESIGN_STATE|STATE_ERROR|REQUIRED/i.test(
      state.error,
    )
  ) {
    return {
      category: "STATE",
      message,
    };
  }

  if (
    /ADAPTER|BUILD|PREVIEW|PLUGIN/i.test(
      state.error,
    )
  ) {
    return {
      category:
        "ADAPTER_OR_BUILD",
      message,
    };
  }

  return {
    category: "RUNTIME",
    message,
  };
}

export function buildDebugReport(input: {
  state: AgentState;
  policy: OperatorPolicyDecision;
  models: DebugModelInventory[];
}): DebugReport {
  const { state } = input;
  const refs =
    evidenceRefs(state);
  const assessment =
    state.assessment;
  const verificationRequired =
    assessment?.plan
      .verificationRequired ??
    state.orchestration
      ?.validatorRequired ??
    false;
  const validator =
    !verificationRequired
      ? "NOT_REQUIRED"
      : assessment?.validator
        ? "PARTICIPATED"
        : "MISSING";
  const adjudication =
    !verificationRequired
      ? "NOT_REQUIRED"
      : assessment?.status ===
          "ABSTAIN"
        ? "DISAGREE_ABSTAIN"
        : assessment?.adjudication
          ? "PARTICIPATED"
          : "MISSING";
  const posture =
    getToolSecurityPosture();
  const policyValue =
    input.policy.allowed
      ? "ALLOW"
      : [
          "DENY",
          input.policy.boundary,
          input.policy.reason,
        ].join("|");
  const report: DebugReport = {
    schemaVersion: 1,
    generatedAt:
      new Date().toISOString(),
    runId: state.requestId,
    operatingMode:
      "PREVIEW_OPERATE",
    actEnabled: false,
    requestFingerprint:
      fingerprint(state.request),
    provider: state.provider,
    engine: state.engine,
    intent: state.intent,
    phase: state.phase,
    durationMs:
      state.durationMs,
    policy: {
      decisionId:
        fingerprint(
          state.request +
            "|" +
            policyValue,
        ).slice(0, 24),
      allowed:
        input.policy.allowed,
      ...(!input.policy.allowed
        ? {
            boundary:
              input.policy.boundary,
            reason:
              redactDebugText(
                input.policy.reason,
              ),
          }
        : {}),
    },
    orchestration: {
      phaseOrder:
        state.orchestration
          ?.execution.phaseOrder ??
        [
          "PLAN",
          "DO",
          "CONVERGE_VERIFY",
          "ACT",
        ],
      roles:
        state.orchestration
          ?.assignments.map(
            (assignment) =>
              assignment.role,
          ) ?? [],
      validatorRequired:
        state.orchestration
          ?.validatorRequired ??
        false,
      actEnabled: false,
    },
    models: input.models,
    reasoning: {
      status:
        assessment?.status ??
        "NOT_RUN",
      verificationRequired,
      validator,
      adjudication,
      modelInvocations:
        assessment
          ?.modelInvocations ??
        [],
    },
    grounding:
      grounding(
        state,
        refs,
      ),
    execution:
      state.events.map(
        (event) => ({
          at: event.at,
          phase: event.phase,
          event: event.event,
          ...(typeof event.durationMs ===
          "number"
            ? {
                durationMs:
                  event.durationMs,
              }
            : {}),
          ...(event.detail
            ? {
                detail:
                  redactDebugText(
                    event.detail,
                  ),
              }
            : {}),
        }),
      ),
    ...(state.build
      ? {
          build: {
            plugin:
              state.design?.plugin
                .plugin,
            gateAllowed:
              state.build.gate
                .allowed,
            reasons:
              state.build.gate
                .reasons.map(
                  redactDebugText,
                ),
            executionMode:
              "PREVIEW_ONLY" as const,
          },
        }
      : {}),
    action: {
      attempted:
        state.action
          ?.attempted ??
        false,
      executed:
        state.action
          ?.executed ??
        false,
      status:
        state.action?.status ??
        "NOT_REQUIRED",
      reason:
        redactDebugText(
          state.action?.reason ??
            "No action result.",
        ),
      mutationObserved:
        state.observation
          ?.mutationObserved ??
        false,
    },
    toolBoundary: {
      arbitraryShell: false,
      cloudReadDefault:
        posture.cloudReadDefault,
      projectCodeExecutionDefault:
        posture
          .projectCodeExecutionDefault,
      previewWriteDefault:
        posture
          .previewWriteDefault,
      managedAccessDefault:
        posture
          .managedAccessDefault,
      mutationToolCount:
        posture.mutationTools
          .length,
    },
    ...(failure(state)
      ? {
          failure:
            failure(state),
        }
      : {}),
  };

  return report;
}

export function writeDebugTrace(
  report: DebugReport,
): string {
  const directory = resolve(
    ".runs",
    "debug",
  );
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  );

  const path = resolve(
    directory,
    report.runId +
      ".jsonl",
  );
  const lines = [
    JSON.stringify({
      type: "summary",
      ...report,
      execution: undefined,
    }),
    ...report.execution.map(
      (event) =>
        JSON.stringify({
          type: "event",
          runId: report.runId,
          ...event,
        }),
    ),
  ];

  writeFileSync(
    path,
    lines.join("\n") +
      "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  return path;
}

export function modelInventoryEntry(
  role:
    DebugModelInventory["role"],
  configuredModel: string,
  result:
    | LocalModelMetadata
    | Error,
): DebugModelInventory {
  if (
    result instanceof Error
  ) {
    return {
      role,
      configuredModel,
      installed: false,
      inventoryError:
        redactDebugText(
          result.message,
        ),
    };
  }

  return {
    role,
    configuredModel,
    installed: true,
    digest: result.digest,
    size: result.size,
  };
}
