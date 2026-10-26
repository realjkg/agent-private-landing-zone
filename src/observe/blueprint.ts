/**
 * The blueprint of one apply (docs/observe-and-cleanup.md): each planned engine address mapped to the cloud identifier the
 * engine recorded for it. It is read from Terraform's state after the apply (`terraform show -json` or `state pull`), or
 * from CloudFormation's stack resource listing for the CDK engine, and it keeps identifiers only: the ARN and the
 * provider's `id` (CloudFormation: the physical id), because the cloud's own read API names some resource types by one and
 * some by the other. No other attribute value is ever copied out, so the blueprint can go into reviewable evidence.
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
  /**
   * Set when a wrapper type (`terraform_data`, `null_resource`, `aws_cloudformation_stack`, a CloudFormation custom resource)
   * holds an IAM ARN in any attribute the state recorded, as a whole value or an element of a list: an identity may be in
   * disguise, so the cleanup refuses to classify it. Judged in place; the attribute itself is never copied.
   */
  holdsIdentityArn?: true;
};
export type Blueprint = {
  entries: BlueprintEntry[];
  /** Addresses the plan says should exist after the apply (created, updated, replaced or unchanged) that the state does not hold. */
  missing: string[];
  /**
   * The unit's own container when the engine has one (CloudFormation: the stack, by its ARN): it carries the unit's tags, so the
   * tag sweep lists it, and it is never a leftover and never a proposal entry. Absent for Terraform, which has no container.
   */
  container?: { type: string; identifier: string };
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
const CREDENTIAL_ID_TYPES = new Set(["aws_iam_access_key", "aws_iam_service_specific_credential", "AWS::IAM::AccessKey"]);
/** Wrapper types that can carry anything, an identity's ARN among it (review 6412488764, N2); their attributes are judged for one. */
const WRAPPER_TYPE = /^(?:terraform_data|null_resource|aws_cloudformation_stack|AWS::CloudFormation::CustomResource|Custom::)/;
/** An IAM ARN as a whole string value, or as one element of a separated list, in any partition. */
const IAM_ARN_ELEMENT = /(?:^|[\s,;|])arn:aws(?:-[a-z]+)*:iam::[^\s,;|]*/;
/** Whether any string anywhere in a value (an attribute, a nested object, a list) is or contains an IAM ARN element. Reads in place, copies nothing. */
function holdsIamArn(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === "string") return IAM_ARN_ELEMENT.test(value);
  if (Array.isArray(value)) return value.some((item) => holdsIamArn(item, depth + 1));
  if (isRecord(value)) return Object.values(value).some((item) => holdsIamArn(item, depth + 1));
  return false;
}

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
      ...(WRAPPER_TYPE.test(resource.type) && holdsIamArn(values) ? { holdsIdentityArn: true as const } : {}),
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

// --- CloudFormation (the CDK engine) ------------------------------------------------------------------------------

/**
 * How a CloudFormation resource's ARN follows from its physical id, for the types the independent reader knows
 * (`CLOUD_CONTROL_TYPES` in ./verify.ts names the same types). The tagging API lists ARNs, so the sweep by the run's unit
 * can tell a stack's own resource from a stray only when the blueprint holds its ARN too. A type not here keeps `arn: null`:
 * its tagged ARN would be reported as unexpected and a person reviews it (fail closed, never assumed to be ours).
 * UNVERIFIED (9): the ARN formats and which physical id each type reports are from memory; checked against AWS documentation
 * and a real DEV run before live use.
 */
const CLOUDFORMATION_ARNS: Readonly<Record<string, (physicalId: string, place: { account: string; region: string }) => string | null>> = {
  "AWS::S3::Bucket": (id) => "arn:aws:s3:::" + id,
  "AWS::Logs::LogGroup": (id, p) => "arn:aws:logs:" + p.region + ":" + p.account + ":log-group:" + id,
  // The physical id is the role or user name; one under a path has the path in its ARN, which the name alone does not show (UNVERIFIED (9)).
  "AWS::IAM::Role": (id, p) => (id.includes("/") ? null : "arn:aws:iam::" + p.account + ":role/" + id),
  "AWS::IAM::User": (id, p) => (id.includes("/") ? null : "arn:aws:iam::" + p.account + ":user/" + id),
  "AWS::SQS::Queue": (id, p) => { const name = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/([A-Za-z0-9_-]+)$/.exec(id)?.[1]; return name === undefined ? null : "arn:aws:sqs:" + p.region + ":" + p.account + ":" + name; },
  "AWS::KMS::Key": (id, p) => "arn:aws:kms:" + p.region + ":" + p.account + ":key/" + id,
  "AWS::DynamoDB::Table": (id, p) => "arn:aws:dynamodb:" + p.region + ":" + p.account + ":table/" + id,
  "AWS::Lambda::Function": (id, p) => "arn:aws:lambda:" + p.region + ":" + p.account + ":function:" + id,
  "AWS::EC2::VPC": (id, p) => "arn:aws:ec2:" + p.region + ":" + p.account + ":vpc/" + id,
  "AWS::EC2::Subnet": (id, p) => "arn:aws:ec2:" + p.region + ":" + p.account + ":subnet/" + id,
  "AWS::EC2::SecurityGroup": (id, p) => "arn:aws:ec2:" + p.region + ":" + p.account + ":security-group/" + id,
};

/** Change-set actions after which a successful execution leaves the resource in the stack (the sealed change list's own vocabulary, src/apply/engines/cdk.ts). */
const LEAVES_IN_STACK = new Set(["CREATE", "UPDATE", "REPLACE", "REPLACE_CONDITIONAL", "IMPORT", "DYNAMIC", "SAME"]);
const LOGICAL_ID = /^[A-Za-z0-9]{1,255}$/;
const CFN_TYPE = /^(?:AWS|Alexa)::[A-Za-z0-9]+::[A-Za-z0-9]+$/;

/**
 * The blueprint from `describe-stack-resources` (UNVERIFIED (9): `StackResources[].LogicalResourceId`, `PhysicalResourceId`,
 * `ResourceType`, `ResourceStatus`) and the sealed change list: each logical id mapped to its physical id, which is the
 * resource's Cloud Control identifier for the known types, and to the ARN derived from it where the table above can. A
 * resource whose status says it is gone (`DELETE_COMPLETE`) is not in the stack. Nothing else of the document is read: no
 * status reason, no timestamp, no drift information. Throws on anything that is not a stack resource listing; a resource
 * row that is not well formed is skipped rather than guessed, and shows up as `missing` if the plan expected it.
 */
export function blueprintFromCloudFormationResources(resourcesJson: string, planned: readonly PlannedChange[], place: { account: string; region: string | undefined; stack?: string }): Blueprint {
  const body = parseState(resourcesJson);
  if (!Array.isArray(body.StackResources)) throw new Error("STATE_JSON_INVALID: not a describe-stack-resources document");
  const rows = body.StackResources;
  // The stack itself, by the id every row names (UNVERIFIED (9): `StackId`): the unit's container, which the tag sweep lists and which is never a leftover.
  // Recorded only when it is the pinned stack in the pinned account and region; anything else is not this run's container and is not recorded.
  const stackIds = new Set(rows.filter(isRecord).map((row) => row.StackId).filter((id): id is string => typeof id === "string"));
  const stackArn = place.region !== undefined && place.stack !== undefined ? new RegExp("^arn:aws:cloudformation:" + place.region + ":" + place.account + ":stack/" + place.stack + "/[0-9a-f-]{36}$") : undefined;
  const container = stackIds.size === 1 && stackArn !== undefined && stackArn.test([...stackIds][0]!) ? { type: "AWS::CloudFormation::Stack", identifier: [...stackIds][0]! } : undefined;
  function* instances(): Generator<Instance> {
    for (const row of rows) {
      if (!isRecord(row) || !text(row.LogicalResourceId) || !LOGICAL_ID.test(row.LogicalResourceId) || !text(row.ResourceType) || !CFN_TYPE.test(row.ResourceType)) continue;
      if (typeof row.ResourceStatus === "string" && /DELETE_COMPLETE$/.test(row.ResourceStatus)) continue;
      const physical = text(row.PhysicalResourceId) ? row.PhysicalResourceId : undefined;
      const derived = physical !== undefined && place.region !== undefined ? CLOUDFORMATION_ARNS[row.ResourceType]?.(physical, { account: place.account, region: place.region }) ?? null : null;
      const arn = physical !== undefined && physical.startsWith("arn:") ? physical : derived;
      yield { address: row.LogicalResourceId, type: row.ResourceType, values: { id: physical, arn: arn ?? undefined } };
    }
  }
  const leaving = new Set(planned.filter((change) => LEAVES_IN_STACK.has(change.action)).map((change) => change.address));
  const built = blueprintOf(instances(), planned);
  return { entries: built.entries, missing: [...leaving].filter((address) => !built.entries.some((entry) => entry.address === address)).sort(), ...(container ? { container } : {}) };
}
