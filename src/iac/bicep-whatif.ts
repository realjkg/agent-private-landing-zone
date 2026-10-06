import {
  createChangeSet,
  type ChangeOperation,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

type AzureWhatIf = {
  changes?: Array<{
    resourceId?: string;
    changeType?: string;
  }>;
};

function operation(
  changeType?: string,
): ChangeOperation {
  if (changeType === "Create") return "CREATE";
  if (changeType === "Delete") return "DELETE";
  if (
    changeType === "Modify" ||
    changeType === "Deploy"
  ) {
    return "UPDATE";
  }
  if (
    changeType === "NoChange" ||
    changeType === "NoEffect"
  ) {
    return "SAME";
  }
  if (changeType === "Ignore") return "READ";

  return "UNKNOWN";
}

export function normalizeBicepWhatIf(
  json: string,
): ChangeSet {
  const preview =
    JSON.parse(json) as AzureWhatIf;

  const resources: ResourceChange[] = [];

  for (
    const [index, change] of
    (preview.changes ?? []).entries()
  ) {
    resources.push({
      address:
        change.resourceId ??
        "bicep:unknown:" + index,
      operation: operation(
        change.changeType,
      ),
    });
  }

  return createChangeSet(
    "BICEP",
    resources,
  );
}
