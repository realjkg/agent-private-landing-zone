import type { DiscoveredResource } from "../discovery/types.js";
import type { PlannedTags } from "./types.js";

/**
 * Per-engine readers for the traceable-teardown gates (docs/teardown-traceability.md).
 *
 * Each reader turns one engine's own preview output into the tags a CREATE
 * will carry, keyed by the same address the engine's change-set normalizer
 * uses. Terraform/OpenTofu live in gates.ts: their plans list every attribute,
 * so a missing `tags` really means "no tags attribute". These engines are
 * different — a preview shows only what the template set — so a create that
 * omits tags reports an EMPTY tag set (the create gate then BLOCKS it as
 * untagged) unless the resource type is in a reviewed `untaggableTypes`
 * allowlist. A preview that cannot show tags at all reports nothing for that
 * address, which the gate also blocks (TAGS_NOT_REPORTED). Everything is a
 * pure function over JSON the operator's own engine run produced: nothing
 * here executes a tool, calls a cloud, or deletes anything.
 */
export type TagReaderOptions = {
  /** Resource types that genuinely have no tags (for example IAM attachments). */
  untaggableTypes?: ReadonlySet<string>;
};

/** Pulumi's marker for a value only known at apply time. */
const PULUMI_UNKNOWN = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringTags(value: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, tag] of Object.entries(value)) {
    if (typeof tag === "string") tags[key] = tag;
  }
  return tags;
}

/** Tags per planned `create` step in `pulumi preview --json` (tagsAll over tags). */
export function readPulumiPreviewTags(
  json: string,
  options: TagReaderOptions = {},
): Map<string, PlannedTags> {
  const preview = JSON.parse(json) as {
    steps?: Array<{
      op?: string;
      urn?: string;
      type?: string;
      newState?: {
        type?: string;
        inputs?: Record<string, unknown>;
        outputs?: Record<string, unknown>;
      };
    }>;
  };
  const result = new Map<string, PlannedTags>();
  for (const step of preview.steps ?? []) {
    if (step.op !== "create" || !step.urn) continue;
    const type = step.newState?.type ?? step.type;
    if (type && options.untaggableTypes?.has(type)) {
      result.set(step.urn, { kind: "UNTAGGABLE" });
      continue;
    }
    const all = step.newState?.outputs?.tagsAll;
    const own = step.newState?.inputs?.tags;
    if (isObject(all)) {
      result.set(step.urn, { kind: "TAGGED", tags: stringTags(all) });
    } else if (isObject(own)) {
      result.set(step.urn, { kind: "TAGGED", tags: stringTags(own) });
    } else if (all === PULUMI_UNKNOWN || own === PULUMI_UNKNOWN) {
      result.set(step.urn, { kind: "UNKNOWN_AT_PLAN" });
    } else {
      result.set(step.urn, { kind: "TAGGED", tags: {} });
    }
  }
  return result;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Tags per `Add` in `aws cloudformation describe-change-set` output. Only a
 * change set created with property values carries `AfterContext`; without it
 * nothing is reported and the gate blocks, rather than guessing.
 */
export function readCloudFormationChangeSetTags(
  json: string,
  options: TagReaderOptions = {},
): Map<string, PlannedTags> {
  const preview = JSON.parse(json) as {
    Changes?: Array<{
      ResourceChange?: {
        Action?: string;
        LogicalResourceId?: string;
        ResourceType?: string;
        AfterContext?: unknown;
      };
    }>;
  };
  const result = new Map<string, PlannedTags>();
  for (const change of preview.Changes ?? []) {
    const resource = change.ResourceChange;
    if (resource?.Action !== "Add" || !resource.LogicalResourceId) continue;
    const address = resource.LogicalResourceId;
    if (resource.ResourceType && options.untaggableTypes?.has(resource.ResourceType)) {
      result.set(address, { kind: "UNTAGGABLE" });
      continue;
    }
    const context = parseMaybeJson(resource.AfterContext);
    if (!isObject(context)) continue; // not reported
    const properties = parseMaybeJson(context.Properties);
    if (!isObject(properties)) continue; // not reported
    const tags = properties.Tags;
    if (tags === undefined || tags === null) {
      result.set(address, { kind: "TAGGED", tags: {} });
    } else if (Array.isArray(tags)) {
      const entries = tags.filter(isObject);
      if (entries.some((entry) => typeof entry.Value !== "string")) {
        result.set(address, { kind: "UNKNOWN_AT_PLAN" }); // unresolved intrinsic
      } else {
        result.set(address, {
          kind: "TAGGED",
          tags: Object.fromEntries(entries
            .filter((entry) => typeof entry.Key === "string")
            .map((entry) => [entry.Key as string, entry.Value as string])),
        });
      }
    } else if (isObject(tags)) {
      result.set(address, { kind: "TAGGED", tags: stringTags(tags) });
    }
  }
  return result;
}

/** Tags per `Create` in `az deployment ... what-if --no-pretty-print` output (`after.tags`). */
export function readBicepWhatIfTags(
  json: string,
  options: TagReaderOptions = {},
): Map<string, PlannedTags> {
  const preview = JSON.parse(json) as {
    changes?: Array<{
      resourceId?: string;
      changeType?: string;
      after?: { type?: string; tags?: unknown } | null;
    }>;
  };
  const result = new Map<string, PlannedTags>();
  for (const change of preview.changes ?? []) {
    if (change.changeType !== "Create" || !change.resourceId || !isObject(change.after)) continue;
    const address = change.resourceId;
    const type = typeof change.after.type === "string" ? change.after.type : undefined;
    if (type && options.untaggableTypes?.has(type)) {
      result.set(address, { kind: "UNTAGGABLE" });
    } else if (isObject(change.after.tags)) {
      result.set(address, { kind: "TAGGED", tags: stringTags(change.after.tags) });
    } else {
      result.set(address, { kind: "TAGGED", tags: {} });
    }
  }
  return result;
}

export type TaggedInventory = {
  resources: DiscoveredResource[];
  /** False when the listing was paginated: it cannot prove there are no orphans. */
  complete: boolean;
};

// A tag found on a listing is a pointer, never authority: it can say a
// resource claims an ALZ unit, but it cannot make a resource ALZ-owned or
// deletable, so inventoried resources stay UNKNOWN / READ_ONLY.
const inventoried = {
  ownership: "UNKNOWN" as const,
  mutationPolicy: "READ_ONLY" as const,
  sourceOfTruth: "UNKNOWN" as const,
};

/**
 * `aws resourcegroupstaggingapi get-resources` output (optionally filtered
 * with `--tag-filters Key=alz-managed-by,Values=alz`).
 */
export function parseAwsTaggedResources(json: string): TaggedInventory {
  const body = JSON.parse(json) as {
    ResourceTagMappingList?: unknown;
    PaginationToken?: unknown;
    NextToken?: unknown;
  };
  if (!Array.isArray(body.ResourceTagMappingList)) {
    throw new Error("TAGGED_INVENTORY_INVALID: ResourceTagMappingList missing");
  }
  const resources: DiscoveredResource[] = [];
  for (const entry of body.ResourceTagMappingList) {
    if (!isObject(entry) || typeof entry.ResourceARN !== "string") continue;
    const arn = entry.ResourceARN;
    const [, , service, region, account, ...rest] = arn.split(":");
    const tags: Record<string, string> = {};
    for (const tag of Array.isArray(entry.Tags) ? entry.Tags : []) {
      if (isObject(tag) && typeof tag.Key === "string" && typeof tag.Value === "string") {
        tags[tag.Key] = tag.Value;
      }
    }
    resources.push({
      resourceId: arn,
      provider: "AWS",
      resourceType: "aws:" + (service ?? "unknown"),
      name: rest.join(":") || arn,
      scope: account || undefined,
      region: region || undefined,
      tags,
      metadata: { inventory: "resourcegroupstaggingapi" },
      ...inventoried,
    });
  }
  // Two different truncation markers: the service's own PaginationToken, and
  // the AWS CLI's top-level NextToken that `--max-items` adds. Either one
  // means pages are missing, so the listing cannot prove there are no orphans.
  const more = (token: unknown) => typeof token === "string" && token !== "";
  return { resources, complete: !more(body.PaginationToken) && !more(body.NextToken) };
}

/** `az resource list` output (optionally `--tag alz-managed-by=alz`). */
export function parseAzureTaggedResources(json: string): TaggedInventory {
  const body = JSON.parse(json) as unknown;
  if (!Array.isArray(body)) throw new Error("TAGGED_INVENTORY_INVALID: expected a JSON array");
  const resources: DiscoveredResource[] = [];
  for (const entry of body) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    resources.push({
      resourceId: entry.id,
      provider: "AZURE",
      resourceType: typeof entry.type === "string" ? entry.type : "azure:unknown",
      name: typeof entry.name === "string" ? entry.name : entry.id,
      scope: typeof entry.resourceGroup === "string" ? entry.resourceGroup : undefined,
      region: typeof entry.location === "string" ? entry.location : undefined,
      tags: isObject(entry.tags) ? stringTags(entry.tags) : {},
      metadata: { inventory: "az-resource-list" },
      ...inventoried,
    });
  }
  // `az resource list` returns the whole result set; there is no continuation token.
  return { resources, complete: true };
}
