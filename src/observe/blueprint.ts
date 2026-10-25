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

/** One managed instance as either state format names it: its address, type and attribute values (read for identifiers only). */
type Instance = { address: string; type: string; values: Record<string, unknown> };

/** The parser's own message can quote the text around the error, which is state; it is never passed on. */
function parseState(json: string): Record<string, unknown> {
  let body: unknown;
  try { body = JSON.parse(json); } catch { throw new Error("STATE_JSON_INVALID: not JSON"); }
  if (!isRecord(body)) throw new Error("STATE_JSON_INVALID: not an object");
  return body;
}

/** The blueprint over the instances found, whatever format they were read from. */
function blueprintOf(instances: Iterable<Instance>, planned: readonly PlannedChange[]): Blueprint {
  // Outputs are listed among the plan's changes (address "output.<name>") but are not resources.
  const leaving = new Set(planned.filter((change) => change.type !== "output" && LEAVES_RESOURCE.has(change.action)).map((change) => change.address));
  const plannedAddresses = new Set(planned.map((change) => change.address));
  const entries: BlueprintEntry[] = [];
  const seen = new Set<string>();
  for (const resource of instances) {
    if (!text(resource.address) || !text(resource.type) || seen.has(resource.address)) continue;
    seen.add(resource.address);
    const values = resource.values;
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

/** The blueprint from `terraform show -json` output and the sealed plan's changes. Throws on output that is not a state. */
export function blueprintFromTerraformState(showJson: string, planned: readonly PlannedChange[]): Blueprint {
  const body = parseState(showJson);
  if (!text(body.format_version)) throw new Error("STATE_JSON_INVALID: not terraform show -json output");
  const root = isRecord(body.values) && isRecord(body.values.root_module) ? body.values.root_module : {};
  function* instances(): Generator<Instance> {
    for (const resource of managedResources(root)) {
      if (text(resource.address) && text(resource.type)) yield { address: resource.address, type: resource.type, values: isRecord(resource.values) ? resource.values : {} };
    }
  }
  return blueprintOf(instances(), planned);
}

/** The address of one instance in a raw state document: module path, type and name, then the index (a number, or a quoted key). */
function instanceAddress(resource: Record<string, unknown>, instance: Record<string, unknown>): string | undefined {
  if (!text(resource.type) || !text(resource.name)) return undefined;
  const module = text(resource.module) ? resource.module + "." : "";
  const key = instance.index_key;
  const index = typeof key === "number" && Number.isInteger(key) && key >= 0 ? "[" + key + "]"
    : typeof key === "string" ? "[" + JSON.stringify(key) + "]" : key === undefined || key === null ? "" : undefined;
  return index === undefined ? undefined : module + resource.type + "." + resource.name + index;
}

/**
 * The same blueprint from a raw state document, as `terraform state pull` returns it (state format version 4), which the
 * apply path already reads with the STATE identity: no second argument list is needed to observe. Identifiers only,
 * as above; every other attribute value stays in the document, which the caller drops. Throws on anything that is not a state.
 */
export function blueprintFromTerraformStatePull(stateJson: string, planned: readonly PlannedChange[]): Blueprint {
  const body = parseState(stateJson);
  if (body.version !== 4 || !Array.isArray(body.resources)) throw new Error("STATE_JSON_INVALID: not a version 4 state document");
  const resources = body.resources;
  function* instances(): Generator<Instance> {
    for (const resource of resources) {
      if (!isRecord(resource) || resource.mode !== "managed" || !Array.isArray(resource.instances)) continue;
      for (const instance of resource.instances) {
        if (!isRecord(instance)) continue;
        const address = instanceAddress(resource, instance);
        if (address !== undefined) yield { address, type: resource.type as string, values: isRecord(instance.attributes) ? instance.attributes : {} };
      }
    }
  }
  return blueprintOf(instances(), planned);
}
