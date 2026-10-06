import {
  createChangeSet,
  type ChangeOperation,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

type PulumiPreview = {
  steps?: Array<{
    op?: string;
    urn?: string;
    type?: string;
  }>;
};

function mapPulumiOperation(
  operation?: string,
): ChangeOperation {
  if (operation === "create") return "CREATE";
  if (operation === "update") return "UPDATE";
  if (operation === "delete") return "DELETE";
  if (
    operation === "replace" ||
    operation === "create-replacement" ||
    operation === "delete-replaced" ||
    operation === "read-replacement" ||
    operation === "import-replacement"
  ) {
    return "REPLACE";
  }
  if (
    operation === "read" ||
    operation === "refresh" ||
    operation === "import"
  ) {
    return "READ";
  }
  if (operation === "same") return "SAME";

  return "UNKNOWN";
}

export function normalizePulumiPreview(
  json: string,
): ChangeSet {
  const preview =
    JSON.parse(json) as PulumiPreview;

  const byAddress =
    new Map<string, ResourceChange>();

  for (
    const [index, step] of
    (preview.steps ?? []).entries()
  ) {
    const address =
      step.urn ??
      "pulumi:unknown:" + index;
    const operation =
      mapPulumiOperation(step.op);

    const existing =
      byAddress.get(address);

    if (
      existing?.operation === "REPLACE"
    ) {
      continue;
    }

    if (
      operation === "REPLACE" ||
      !existing
    ) {
      byAddress.set(address, {
        address,
        type: step.type,
        operation,
      });
    }
  }

  return createChangeSet(
    "PULUMI",
    [...byAddress.values()],
  );
}
