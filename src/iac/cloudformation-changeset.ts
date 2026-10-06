import {
  createChangeSet,
  type ChangeOperation,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

type CloudFormationPreview = {
  Changes?: Array<{
    ResourceChange?: {
      Action?: string;
      LogicalResourceId?: string;
      ResourceType?: string;
      Replacement?: string;
    };
  }>;
};

function operation(
  action?: string,
  replacement?: string,
): ChangeOperation {
  if (action === "Add") return "CREATE";
  if (action === "Remove") return "DELETE";
  if (action === "Modify") {
    return replacement === "True" ||
      replacement === "Conditional"
      ? "REPLACE"
      : "UPDATE";
  }

  // Import is adoption semantics and must not
  // silently become an allowed update.
  return "UNKNOWN";
}

export function normalizeCloudFormationChangeSet(
  json: string,
): ChangeSet {
  const preview =
    JSON.parse(json) as CloudFormationPreview;

  const resources: ResourceChange[] = [];

  for (
    const [index, change] of
    (preview.Changes ?? []).entries()
  ) {
    const resource =
      change.ResourceChange;

    resources.push({
      address:
        resource?.LogicalResourceId ??
        "cloudformation:unknown:" + index,
      type: resource?.ResourceType,
      operation: operation(
        resource?.Action,
        resource?.Replacement,
      ),
    });
  }

  return createChangeSet(
    "CLOUDFORMATION",
    resources,
  );
}
