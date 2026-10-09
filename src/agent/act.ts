import {
  executeGovernedAction,
  type ActionReceipt,
  type ActionRegistryDeps,
  type GovernedActionRequest,
  type SignedActionLease,
} from "../actions/registry.js";
import type {
  ActionResult,
  AgentState,
} from "./types.js";

export function act(
  state: AgentState,
): AgentState {
  let result: ActionResult;
  let phase = state.phase;

  if (state.intent === "CHANGE") {
    result = {
      attempted: true,
      executed: false,
      status: "DISABLED",
      reason:
        "ACT_DISABLED: real cloud mutation is not enabled in this iteration.",
    };
    phase = "BLOCKED";
  } else if (state.phase === "AWAITING_APPROVAL") {
    result = {
      attempted: false,
      executed: false,
      status: "AWAITING_APPROVAL",
      reason:
        "Hash-bound human approval is required before any future action.",
    };
    phase = "AWAITING_APPROVAL";
  } else if (state.phase === "BLOCKED") {
    result = {
      attempted: false,
      executed: false,
      status: "BLOCKED",
      reason:
        "A deterministic policy or evidence gate blocked progression.",
    };
    phase = "BLOCKED";
  } else {
    result = {
      attempted: false,
      executed: false,
      status: "NOT_REQUIRED",
      reason: "No mutation was requested.",
    };
    phase = "ACTING";
  }

  return {
    ...state,
    phase,
    action: result,
    events: [
      ...state.events,
      {
        at: new Date().toISOString(),
        phase,
        event: "ACTION_EVALUATED",
        detail: result.reason,
      },
    ],
  };
}

/** Externally authorized, single-operation ACT boundary.
 * This is never invoked by freeform graph/chat prompts or Terraform apply.
 * The trusted host must supply the lease issuer, durable ledger and handler.
 */
export async function actWithExternalLease(
  state: AgentState,
  request: GovernedActionRequest,
  lease: SignedActionLease,
  trusted: ActionRegistryDeps,
): Promise<{ state: AgentState; receipt: ActionReceipt }> {
  const env = state.environment, design = state.design, build = state.build;
  if (state.mock || !env || !design || !build ||
      env.classification === "UNKNOWN" ||
      env.safeBuildMode === "READ_ONLY" || env.safeBuildMode === "BLOCKED" ||
      env.resources.some((resource) => resource.ownership === "UNKNOWN" ||
        resource.mutationPolicy === "DELETE_ALLOWED") ||
      design.status === "BLOCKED" ||
      design.designHash !== request.designHash ||
      design.policies.bundleHash !== request.policyHash ||
      build.candidate.artifact.generatedBy === "fixture-generator" ||
      build.candidate.status !== "APPROVED" ||
      build.candidate.evidence.approvedArtifactHash !==
        build.candidate.artifact.contentHash ||
      build.candidate.evidence.approvedDesignHash !== design.designHash ||
      state.assessment?.status !== "OK" ||
      state.action?.executed === true) {
    throw new Error("GOVERNED_ACT_DENIED:UNAPPROVED_SOURCE_DESIGN_OR_ESTATE");
  }
  let preview: Record<string, unknown>;
  try {
    preview = JSON.parse(build.previewSummary) as Record<string, unknown>;
  } catch {
    throw new Error("GOVERNED_ACT_DENIED:CHANGESET_NOT_ATTESTED");
  }
  if (preview.normalizedChangeSetHash !== request.changeSetHash) {
    throw new Error("GOVERNED_ACT_DENIED:CHANGESET_HASH_MISMATCH");
  }
  const receipt = await executeGovernedAction(request, lease, trusted);
  return {
    receipt,
    state: {
      ...state, phase: "ACTING",
      action: {
        attempted: true, executed: true, status: "EXECUTED",
        reason: "Externally leased governed action; independent observation pending.",
      },
      observation: {
        verified: false, mutationObserved: true,
        evidence: [receipt.providerEvidenceHash, receipt.recoveryEvidenceHash],
      },
      events: [...state.events, {
        at: new Date().toISOString(), phase: "ACTING",
        event: "GOVERNED_ACTION_COMPLETED",
        detail: receipt.operation + " / " + receipt.target,
      }],
    },
  };
}
