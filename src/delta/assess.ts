import type {
  EnvironmentState,
} from "../discovery/types.js";
import type {
  DeltaAction,
  DeltaAssessment,
} from "./types.js";

function actionForResource(
  environment: EnvironmentState,
  resourceId: string,
): DeltaAction {
  const resource =
    environment.resources.find(
      (item) =>
        item.resourceId === resourceId,
    );

  if (!resource) {
    return "BLOCKED";
  }

  if (
    resource.ownership === "UNKNOWN"
  ) {
    return "BLOCKED";
  }

  if (
    resource.mutationPolicy ===
    "UPDATE_ALLOWED"
  ) {
    return "CONFIGURE";
  }

  if (
    resource.ownership ===
    "MANAGED_BY_ACCELERATOR"
  ) {
    return "INTEGRATE";
  }

  if (
    resource.ownership ===
      "MANAGED_BY_CUSTOMER" ||
    resource.ownership ===
      "MANAGED_BY_OTHER_IAC" ||
    resource.ownership === "EXISTING" ||
    resource.ownership === "EXTERNAL"
  ) {
    return "REUSE";
  }

  if (
    resource.ownership === "ADOPTED"
  ) {
    return "CONFIGURE";
  }

  return "NO_TOUCH";
}

export function assessDelta(
  environment: EnvironmentState,
  objective: string,
): DeltaAssessment {
  const desiredStateKnown =
    objective.trim().length > 0;

  const decisions =
    environment.resources.map(
      (resource) => {
        const action =
          actionForResource(
            environment,
            resource.resourceId,
          );

        return {
          resourceId:
            resource.resourceId,
          resourceType:
            resource.resourceType,
          action,
          reason:
            action === "BLOCKED"
              ? "Ownership is unknown; safe integration cannot be inferred."
              : action === "CONFIGURE"
                ? "Explicit update authority exists for this resource."
                : action === "INTEGRATE"
                  ? "Accelerator-managed resource may participate in the proposed design without ownership transfer."
                  : action === "REUSE"
                    ? "Existing resource remains authoritative and may be referenced by the design without adoption."
                    : "No change authority is inferred.",
          requiresExplicitAuthorization:
            action === "CONFIGURE" ||
            action === "ADOPT",
        };
      },
    );

  const blockers: string[] = [];

  if (
    environment.classification ===
    "UNKNOWN"
  ) {
    blockers.push(
      "Environment classification is UNKNOWN.",
    );
  }

  if (
    decisions.some(
      (decision) =>
        decision.action === "BLOCKED",
    )
  ) {
    blockers.push(
      "At least one resource has insufficient ownership evidence.",
    );
  }

  return {
    objective,
    environmentType:
      environment.classification,
    desiredStateKnown,
    decisions,
    blockers,
    designRequired: true,
  };
}
