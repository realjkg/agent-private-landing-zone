/**
 * The blueprint of one apply (docs/observe-and-cleanup.md): each planned engine address mapped to the cloud identifier the
 * engine recorded for it. It is read from `terraform show -json` of the state after the apply, and it keeps identifiers
 * only: the ARN and the provider's `id`, because the cloud's own read API names some resource types by one and some by
 * the other. No other attribute value is ever copied out of the state, so the blueprint can go into reviewable evidence.
 */

/** A planned change, as the sealed plan's redacted summary lists it (src/apply/types.ts PlanChange, structurally). */
export type PlannedChange = { address: string; type: string; action: string };

export type BlueprintEntry = {
  address: string;
  type: string;
  /** The resource's ARN, when the state records one. */
  arn: string | null;
  /** The provider's id, when the state records one. */
  id: string | null;
  /** IN_PLAN: the sealed plan names it. NOT_IN_PLAN: the state holds it and the plan never mentioned it. */
  origin: "IN_PLAN" | "NOT_IN_PLAN";
};
export type Blueprint = {
  entries: BlueprintEntry[];
  /** Addresses the plan says should exist after the apply (created, updated, replaced or unchanged) that the state does not hold. */
  missing: string[];
};

/** Plan actions (src/iac/terraform-plan.ts mapTerraformActions) after which a successful apply leaves the resource in the state. */
const LEAVES_RESOURCE = new Set(["CREATE", "UPDATE", "REPLACE", "SAME"]);

type StateResource = { address?: unknown; mode?: unknown; type?: unknown; values?: unknown };
type StateModule = { resources?: unknown; child_modules?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function* managedResources(module: StateModule, depth = 0): Generator<StateResource> {
  if (depth > 32) throw new Error("STATE_MODULES_TOO_DEEP");
  for (const resource of Array.isArray(module.resources) ? module.resources : []) {
    if (isRecord(resource) && resource.mode === "managed") yield resource;
  }
  for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
    if (isRecord(child)) yield* managedResources(child, depth + 1);
  }
}

/** Types whose provider id is a credential identifier (an access key id, for example). Their id is never copied. */
const CREDENTIAL_ID_TYPES = new Set(["aws_iam_access_key", "aws_iam_service_specific_credential"]);

/** The blueprint from `terraform show -json` output and the sealed plan's changes. Throws on output that is not a state. */
export function blueprintFromTerraformState(showJson: string, planned: readonly PlannedChange[]): Blueprint {
  let body: unknown;
  // The parser's own message can quote the text around the error, which is state; it is never passed on.
  try { body = JSON.parse(showJson); } catch { throw new Error("STATE_JSON_INVALID: not JSON"); }
  if (!isRecord(body) || !text(body.format_version)) throw new Error("STATE_JSON_INVALID: not terraform show -json output");
  const root = isRecord(body.values) && isRecord(body.values.root_module) ? body.values.root_module : {};
  // Outputs are listed among the plan's changes (address "output.<name>") but are not resources.
  const leaving = new Set(planned.filter((change) => change.type !== "output" && LEAVES_RESOURCE.has(change.action)).map((change) => change.address));
  const plannedAddresses = new Set(planned.map((change) => change.address));
  const entries: BlueprintEntry[] = [];
  const seen = new Set<string>();
  for (const resource of managedResources(root)) {
    if (!text(resource.address) || !text(resource.type) || seen.has(resource.address)) continue;
    seen.add(resource.address);
    const values = isRecord(resource.values) ? resource.values : {};
    entries.push({
      address: resource.address, type: resource.type,
      arn: text(values.arn) && values.arn.startsWith("arn:") ? values.arn : null,
      id: text(values.id) && !CREDENTIAL_ID_TYPES.has(resource.type) ? values.id : null,
      origin: plannedAddresses.has(resource.address) ? "IN_PLAN" : "NOT_IN_PLAN",
    });
  }
  // Code-point order, as the sealed plan sorts its changes: the same on every machine, whatever its locale.
  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { entries, missing: [...leaving].filter((address) => !seen.has(address)).sort() };
}
