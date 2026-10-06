import {
  createChangeSet,
  type ChangeOperation,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

type TerraformPlan = {
  resource_changes?: Array<{
    address?: string;
    type?: string;
    change?: {
      actions?: string[];
    };
  }>;
};

function mapTerraformActions(
  actions: string[],
): ChangeOperation {
  const values = new Set(actions);

  if (
    values.has("create") &&
    values.has("delete")
  ) {
    return "REPLACE";
  }

  if (values.has("delete")) return "DELETE";
  if (values.has("create")) return "CREATE";
  if (values.has("update")) return "UPDATE";
  if (values.has("read")) return "READ";
  if (values.has("no-op")) return "SAME";

  return "UNKNOWN";
}

function normalizeTerraformLikePlan(
  json: string,
  engine: "TERRAFORM" | "OPENTOFU",
): ChangeSet {
  const plan = JSON.parse(json) as TerraformPlan;
  const resources: ResourceChange[] = [];

  for (
    const [index, resource] of
    (plan.resource_changes ?? []).entries()
  ) {
    const address =
      resource.address ??
      engine.toLowerCase() + ":unknown:" + index;

    resources.push({
      address,
      type: resource.type,
      operation: mapTerraformActions(
        resource.change?.actions ?? [],
      ),
    });
  }

  return createChangeSet(
    engine,
    resources,
  );
}

export function normalizeTerraformPlan(
  json: string,
): ChangeSet {
  return normalizeTerraformLikePlan(
    json,
    "TERRAFORM",
  );
}

export function normalizeOpenTofuPlan(
  json: string,
): ChangeSet {
  return normalizeTerraformLikePlan(
    json,
    "OPENTOFU",
  );
}
