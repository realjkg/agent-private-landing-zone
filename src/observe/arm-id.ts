/**
 * Azure Resource Manager ids, parsed by position, the way ARM itself reads them: alternating key and value segments.
 *
 *   /subscriptions/<guid>                                          a subscription (a scope with no resource type)
 *   /subscriptions/<guid>/resourceGroups/<name>                    a resource group
 *   .../providers/<Namespace>/<type>/<name>[/<type>/<name>...]     a resource under a provider, with its nested types
 *   .../providers/<Namespace>/<type>/<name>/providers/<Namespace>/<type>/<name>   an extension resource on it
 *   /providers/<Namespace>/<type>/<name>...                        a tenant-level resource (a management group, an alias)
 *
 * A segment is a keyword (`subscriptions`, `resourceGroups`, `providers`) only in a key slot. In a value slot it is a name:
 * a resource group or a storage account called `providers` is valid and ordinary. The earlier split on `/providers/` could not
 * tell the two apart, and an authorization object under a group named `providers` fell through unclassified (review
 * 6410149770, B3). Anything this grammar does not consume in full parses to undefined, and every caller fails closed on
 * undefined: the cleanup refuses to classify it, the reader refuses to ask about it.
 *
 * Pure: no I/O, no environment. Keywords are compared case-insensitively; namespaces, types and names are returned as written.
 */

export type ArmType = { namespace: string; typePath: string };
export type ParsedArmId = {
  /** The subscription the id lives in; undefined for a tenant-level id. */
  subscription?: string;
  /** The resource group's name when the id is under one. */
  resourceGroup?: string;
  /**
   * Every `/providers/` pair in order, each the namespace and the slash-joined type path (`Microsoft.Storage` +
   * `storageAccounts/blobServices/containers`). A resource group alone carries the one pair `Microsoft.Resources/resourceGroups`;
   * a bare subscription carries none. A provider block with a namespace and no type/name pair (a provider registration
   * `/subscriptions/<guid>/providers/Microsoft.ContainerService`, the `Microsoft.Features` block of a feature registration,
   * the `Microsoft.Marketplace` block of a marketplace-scope id) is a pair with an empty `typePath`: it names a scope or a
   * registration, never a resource (`isArmRegistrationId`).
   */
  pairs: ArmType[];
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A provider namespace: dotted (`Microsoft.Authorization`, `Wandisco.Fusion`), so a name that happens to sit in a namespace slot never reads as one. */
const NAMESPACE = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/;
/** A name or type segment: anything but a separator, a query or fragment start, a backslash, a percent escape, whitespace or a control character (the reader sends ids as written). */
const SEGMENT = /^[^/?#\\%\s\u0000-\u001f\u007f]+$/;
const keyword = (segment: string | undefined, word: string): boolean => segment !== undefined && segment.toLowerCase() === word;

/** The id parsed in full, or undefined when any part of it does not fit the grammar (a trailing slash, an empty segment, an odd pair, a bad GUID, garbage). */
export function parseArmId(id: string): ParsedArmId | undefined {
  if (typeof id !== "string" || !id.startsWith("/")) return undefined;
  const segments = id.slice(1).split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) return undefined;
  let at = 0;
  const parsed: ParsedArmId = { pairs: [] };
  if (keyword(segments[at], "subscriptions")) {
    const subscription = segments[at + 1];
    if (subscription === undefined || !GUID.test(subscription)) return undefined;
    parsed.subscription = subscription;
    at += 2;
    if (keyword(segments[at], "resourcegroups")) {
      const group = segments[at + 1];
      if (group === undefined) return undefined;
      parsed.resourceGroup = group;
      at += 2;
      if (at === segments.length) return { ...parsed, pairs: [{ namespace: "Microsoft.Resources", typePath: "resourceGroups" }] };
    }
  }
  // Every remaining segment belongs to a provider block: `providers`, a namespace, then one or more type/name pairs. A `providers`
  // in a type slot starts the next block; a `providers` in a name slot is a name. A block with no pair is allowed only where a
  // registration or a provider-level scope lives: as the first block at subscription scope (`/subscriptions/<guid>/providers/<Ns>`,
  // and the `Microsoft.Features` form that follows it with one more block) or at tenant scope (`/providers/Microsoft.Marketplace...`).
  // Under a resource group or after a resource, ARM has no such object, so the id is not parsed (review 6411080437, N4).
  while (at < segments.length) {
    if (!keyword(segments[at], "providers")) return undefined;
    const namespace = segments[at + 1];
    if (namespace === undefined || !NAMESPACE.test(namespace)) return undefined;
    at += 2;
    const types: string[] = [];
    while (at < segments.length && !keyword(segments[at], "providers")) {
      const name = segments[at + 1];
      if (name === undefined) return undefined;
      types.push(segments[at]!);
      at += 2;
    }
    if (types.length === 0 && (parsed.resourceGroup !== undefined || parsed.pairs.length > 0)) return undefined;
    parsed.pairs.push({ namespace, typePath: types.join("/") });
  }
  if (parsed.subscription === undefined && parsed.pairs.length === 0) return undefined;
  return parsed;
}

/** Whether a parsed id names a provider or feature registration, or a provider-level scope, rather than a resource: any block with no type/name pair. */
export const isArmRegistrationId = (parsed: ParsedArmId): boolean => parsed.pairs.some((pair) => pair.typePath === "");

/**
 * Every `/providers/` pair of an ARM id, in order (one for a tracked resource, two or more for an extension resource; the one
 * synthetic pair `Microsoft.Resources/resourceGroups` for a group alone). Undefined when the id does not parse in full or names
 * no resource type (a bare subscription). Compared case-insensitively by callers.
 */
export function armTypePairsOf(id: string): ArmType[] | undefined {
  const parsed = parseArmId(id);
  return parsed === undefined || parsed.pairs.length === 0 ? undefined : parsed.pairs;
}

/** The resource's own type: the last pair (`Microsoft.Authorization/roleAssignments` for a role assignment at any scope). Undefined when the id does not parse. */
export function armTypeOf(id: string): ArmType | undefined {
  const pairs = armTypePairsOf(id);
  return pairs === undefined ? undefined : pairs[pairs.length - 1];
}

/** An Azure region's programmatic name as ARM reports it (`eastus2`, `westeurope`): lowercase letters and digits only, no spaces. */
export const AZURE_LOCATION = /^[a-z][a-z0-9]{2,39}$/;

/**
 * One Azure location, however it is written (`East US 2`, `eastUS2`, `eastus2`), as its programmatic name for comparison: every
 * whitespace character removed and lowercased. Anything that is not text, or that does not then have the programmatic shape
 * (`AZURE_LOCATION`), is undefined, so an empty, missing or malformed location never equals a contract's.
 */
export function normalizeAzureLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/\s+/g, "").toLowerCase();
  return AZURE_LOCATION.test(name) ? name : undefined;
}
