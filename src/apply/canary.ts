import { codeOf, reasonOf, stop, stopBecause } from "./engine.js";
import type { PilotCanary, PilotLimits, PilotTarget } from "./types.js";

/**
 * The canary allowlist judge (owner decision E1; docs/act-pilot-apply.md, "Canary allowlist"). An APPLY may create exactly the
 * resource types and counts its target's `canary` names, and do nothing else: no update, delete, replace, import, move or unknown
 * action, no type the allowlist does not name (an IAM role or a role assignment included), and no count above or below the one
 * listed. It judges what an engine read from its own artifact (Terraform's `show -json` of the plan file, CloudFormation's
 * template and change set), never a summary, and an engine calls it at seal, at the qualification plan and again when an apply
 * re-derives the change list. A cleanup has its own path and never comes here. The refusal reason names addresses, types,
 * actions and counts only, which the redacted change list already shows the approvers; never a value.
 */
export const RESOURCE_NOT_IN_CANARY = "RESOURCE_NOT_IN_CANARY";
export const CANARY_ALLOWLIST_MISSING = "CANARY_ALLOWLIST_MISSING";
/** The artifact creates something the target's provisioning `limits` do not allow: a type, a count over its maximum, a region or a size. */
export const RESOURCE_NOT_IN_LIMITS = "RESOURCE_NOT_IN_LIMITS";

/**
 * The types a canary entry may mark `retain: true` (created at APPLY, intentionally kept at CLEANUP): a small reviewed list of no-cost,
 * inert sentinels only. Today exactly `AWS::CloudFormation::WaitConditionHandle`, which keeps a CDK canary's stack from being emptied by
 * its cleanup (CLEANUP_WOULD_EMPTY_STACK). A `retain` on any other type is refused when the contract is read. A type joins by review.
 */
export const RETAINABLE_CANARY_TYPES: ReadonlySet<string> = new Set(["AWS::CloudFormation::WaitConditionHandle"]);

/**
 * One resource the artifact would touch: its address, its type, its action as the engine reports it, and whether that action is a plain
 * create. An engine that can read where and how large a resource is from its own artifact adds those, for the provisioning `limits`
 * (Terraform, from the plan's resolved values): `region` is the resource's region or location (undefined: the type has none, a global
 * service; null: not known until apply, empty or not text), `otherRegions` the regions it reaches through its own arguments, and `sizes` the values of the type's size attribute (`SIZE_ATTRIBUTES`; undefined: the engine
 * did not read one; null: not shown in the plan). The canary judge never reads either.
 */
export type CanaryEntry = {
  address: string; type: string; action: string; creates: boolean;
  region?: string | null;
  /** Other regions the resource reaches through its own arguments (a DynamoDB replica, a stack set instance, a peering), each null when unknown. */
  otherRegions?: readonly (string | null)[];
  sizes?: readonly string[] | null;
};

const MAX_REASON = 200;
const clip = (text: string): string => (text.length > MAX_REASON ? text.slice(0, MAX_REASON) + "..." : text);

/** Throws `RESOURCE_NOT_IN_CANARY` with the first reason found, or `CANARY_ALLOWLIST_MISSING` when the target names no canary. */
export function assertCanary(canary: PilotCanary | undefined, entries: readonly CanaryEntry[], what: string): void {
  if (!canary || !Array.isArray(canary.resources) || canary.resources.length === 0) return stop(CANARY_ALLOWLIST_MISSING);
  const listed = new Map(canary.resources.map((resource) => [resource.type, resource.count]));
  for (const entry of entries) {
    if (!entry.creates) {
      stopBecause(RESOURCE_NOT_IN_CANARY, clip(entry.address) + " (" + clip(entry.type) + "): the " + what + " would " + clip(entry.action) + " it; the canary allows create only");
    }
    if (!listed.has(entry.type)) stopBecause(RESOURCE_NOT_IN_CANARY, clip(entry.address) + ": type " + clip(entry.type) + " is not in the canary allowlist");
  }
  for (const [type, count] of listed) {
    const found = entries.filter((entry) => entry.type === type).length;
    if (found !== count) stopBecause(RESOURCE_NOT_IN_CANARY, type + ": the " + what + " creates " + found + ", the canary allowlist names exactly " + count);
  }
}

/**
 * The provisioning limits judge (owner direction 6536926009, plan item 3): the general form of the canary allowlist. An APPLY may
 * create only the types `limits.resources` names, each at most its `max` times (zero is within the limit), and still nothing but
 * creates (owner decision E1: no update, delete, replace, import, move or unknown action). When `limits.regions` is set, a resource
 * whose region the engine read must be in it, and one whose region is not known until apply is refused, because the plan cannot show
 * where it goes; a type with no region (a global service) is not judged by region. When a resource entry names `sizes` or `families`,
 * every value of the type's size attribute must be one of the sizes or belong to one of the families (`familyOf`), and a size the plan
 * does not show is refused. It judges the same artifact reading the canary judge does, at the same three points; it is an allowlist,
 * never a cost estimate or a spending limit. The reason names addresses, types, actions and counts, and a region or size only when it
 * is a plain short name (`SHOWN_NAME`); never any other value.
 */
export function assertLimits(limits: PilotLimits, entries: readonly CanaryEntry[], what: string): void {
  const listed = new Map(limits.resources.map((resource) => [resource.type, resource]));
  const regions = limits.regions === undefined ? undefined : new Set(limits.regions.map((region) => region.toLowerCase()));
  for (const entry of entries) {
    const at = clip(entry.address) + " (" + clip(entry.type) + ")";
    if (!entry.creates) stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": the " + what + " would " + clip(entry.action) + " it; the limits allow create only");
    const resource = listed.get(entry.type);
    if (!resource) return stopBecause(RESOURCE_NOT_IN_LIMITS, clip(entry.address) + ": type " + clip(entry.type) + " is not in the provisioning limits");
    if (regions !== undefined && entry.region !== undefined) {
      if (entry.region === null) return stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": the " + what + " does not show its region, so it cannot be judged against the allowed regions");
      if (!regions.has(entry.region.toLowerCase())) stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": region " + shown(entry.region) + " is not in the allowed regions (" + limits.regions!.join(", ") + ")");
    }
    if (regions !== undefined) {
      for (const other of entry.otherRegions ?? []) {
        if (other === null) return stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": the " + what + " does not show a region it reaches (a replica, a stack set instance or a peer), so it cannot be judged against the allowed regions");
        if (!regions.has(other.toLowerCase())) stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": it reaches region " + shown(other) + " (a replica, a stack set instance or a peer), which is not in the allowed regions (" + limits.regions!.join(", ") + ")");
      }
    }
    if (resource.sizes !== undefined || resource.families !== undefined) {
      if (entry.sizes === undefined || entry.sizes === null || entry.sizes.length === 0) {
        return stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": the " + what + " does not show its size, so it cannot be judged against the allowed sizes and families");
      }
      for (const size of entry.sizes) {
        const family = familyOf(size);
        if (resource.sizes?.includes(size) || (family !== undefined && resource.families?.includes(family))) continue;
        stopBecause(RESOURCE_NOT_IN_LIMITS, at + ": size " + shown(size) + " is not one of the allowed sizes or families");
      }
    }
  }
  for (const [type, resource] of listed) {
    const found = entries.filter((entry) => entry.type === type).length;
    if (found > resource.max) stopBecause(RESOURCE_NOT_IN_LIMITS, type + ": the " + what + " creates " + found + ", the provisioning limits allow at most " + resource.max);
  }
}

/**
 * The family of a size: everything before its last dot (`t3.micro` is `t3`, `db.r6g.large` is `db.r6g`). A size with no dot (an Azure
 * `Standard_B2s`, a GCP `e2-medium`) has no family, so only an exact size allows it.
 */
export function familyOf(size: string): string | undefined {
  const at = size.lastIndexOf(".");
  return at > 0 ? size.slice(0, at) : undefined;
}

/** A region or size is named in a refusal only when it is a plain short name; anything else is described, never echoed. */
const SHOWN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const shown = (value: string): string => (SHOWN_NAME.test(value) ? value : "(a value that is not a plain name)");

/**
 * The provisioning judge every engine calls: the target's `limits` when it names them, else its canary allowlist exactly as before
 * (`assertCanary`, unchanged, so a canary contract behaves as it always did). A target names one or the other, never both (refused
 * when the contract is read); one with neither is CANARY_ALLOWLIST_MISSING.
 */
export function assertProvisioning(target: PilotTarget, entries: readonly CanaryEntry[], what: string): void {
  if (target.limits !== undefined) return assertLimits(target.limits, entries, what);
  return assertCanary(target.canary, entries, what);
}

/**
 * The size attribute the limits judge reads per Terraform resource type, from the plan's resolved values: a small reviewed table.
 * A type not listed here takes no `sizes` or `families` (refused when the contract is read), because the plan's size for it is not read.
 * A list attribute (EKS node groups) is judged value by value.
 */
export const TERRAFORM_SIZE_ATTRIBUTES: Readonly<Record<string, string>> = {
  aws_instance: "instance_type",
  aws_launch_template: "instance_type",
  aws_db_instance: "instance_class",
  aws_rds_cluster_instance: "instance_class",
  aws_elasticache_cluster: "node_type",
  aws_elasticache_replication_group: "node_type",
  aws_redshift_cluster: "node_type",
  aws_eks_node_group: "instance_types",
  azurerm_linux_virtual_machine: "size",
  azurerm_windows_virtual_machine: "size",
  azurerm_linux_virtual_machine_scale_set: "sku",
  azurerm_windows_virtual_machine_scale_set: "sku",
  google_compute_instance: "machine_type",
};

/**
 * The refusal a seal, a qualification plan or an apply reports for a canary stop, with its reason, or undefined for any other
 * error. `outcome` says what did not happen ("Nothing was sealed.", "Nothing was applied and no approval was consumed.").
 */
export function canaryRefusal(error: unknown, outcome: string): { code: "RESOURCE_NOT_IN_CANARY" | "CANARY_ALLOWLIST_MISSING" | "RESOURCE_NOT_IN_LIMITS"; message: string } | undefined {
  const code = codeOf(error);
  if (code === CANARY_ALLOWLIST_MISSING) {
    return { code, message: "The contract's target names no canary allowlist and no provisioning limits, so nothing may be created there. " + outcome + " Only the owner's reviewed commit of the contract can add them." };
  }
  if (code === RESOURCE_NOT_IN_LIMITS) {
    return {
      code, message: "The plan creates something the contract's provisioning limits do not allow: " + (reasonOf(error) ?? "a change outside them") + ". " + outcome +
        " Change the project so it stays within the allowed types, counts, regions and sizes, or have the owner change the limits in a reviewed commit (docs/act-pilot-apply.md, \"Provisioning limits\").",
    };
  }
  if (code !== RESOURCE_NOT_IN_CANARY) return undefined;
  return {
    code, message: "The plan does not create exactly what the contract's canary allowlist names: " + (reasonOf(error) ?? "a change outside it") + ". " + outcome +
      " Change the project so it creates exactly the listed types and counts and nothing else, or have the owner change the allowlist in a reviewed commit (docs/act-pilot-apply.md, \"Canary allowlist\").",
  };
}
