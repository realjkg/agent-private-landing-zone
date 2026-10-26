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
   * a bare subscription carries none.
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
  // in a type slot starts the next block; a `providers` in a name slot is a name.
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
    if (types.length === 0) return undefined;
    parsed.pairs.push({ namespace, typePath: types.join("/") });
  }
  if (parsed.subscription === undefined && parsed.pairs.length === 0) return undefined;
  return parsed;
}

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
