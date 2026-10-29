/**
 * The account a provider qualification actually read, as its own discovery observed it: the AWS caller's account from
 * `sts get-caller-identity` (the discovery's account resource), or the Azure tenant and subscription `az account show`
 * returned. Ids only, never a token or a user name. The evidence runner compares these with the expected ids after the
 * producer ran, so a document produced in another account is never taken as evidence (docs/evidence-runner.md, "Identities").
 * Anything that is not a well-formed id is left out, so a missing observation reads as unobserved, never as a match.
 *
 * The principal (`roleName` for an assumed AWS role, `clientId` for an Azure service principal) is recorded too, as a
 * consistency check against the identity the run was configured with, not as proof of which principal signed in (review N9).
 */
export type ObservedIdentity = { accountId?: string; tenantId?: string; subscriptionId?: string; roleName?: string; clientId?: string };

const CALLER_ARN = /^arn:aws(?:-[a-z]+)*:(?:sts|iam)::(\d{12}):/;
/** An assumed role's caller ARN: `arn:aws:sts::<account>:assumed-role/<role name>/<session>`. */
const ASSUMED_ROLE = /^arn:aws(?:-[a-z]+)*:sts::\d{12}:assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\/[^/]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function awsObservedIdentity(callerArn: unknown): ObservedIdentity {
  const match = typeof callerArn === "string" ? CALLER_ARN.exec(callerArn) : null;
  if (!match) return {};
  const role = ASSUMED_ROLE.exec(callerArn as string);
  return { accountId: match[1], ...(role ? { roleName: role[1] } : {}) };
}

export function azureObservedIdentity(accountShow: string): ObservedIdentity {
  let value: unknown;
  try { value = JSON.parse(accountShow); } catch { return {}; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const id = (field: unknown): string | undefined => typeof field === "string" && GUID.test(field.toLowerCase()) ? field.toLowerCase() : undefined;
  const tenantId = id(record.tenantId);
  const subscriptionId = id(record.id);
  // For a service principal, az account show names its application (client) id as the user; a person's name is never kept.
  const user = typeof record.user === "object" && record.user !== null ? record.user as Record<string, unknown> : {};
  const clientId = user.type === "servicePrincipal" ? id(user.name) : undefined;
  return { ...(tenantId ? { tenantId } : {}), ...(subscriptionId ? { subscriptionId } : {}), ...(clientId ? { clientId } : {}) };
}
