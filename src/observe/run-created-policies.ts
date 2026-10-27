import { parseArmId } from "./arm-id.js";

/**
 * Run-created policies (owner decision "Unpin the ACT decision", item 2 (c), issue #39): the closed list of policy types a pilot
 * cleanup may delete although they live in an identity or authorization service. Everything else in those services stays
 * PROTECTED_IDENTITY, and so does every one of these types unless all of its conditions hold: the identity rule runs first and keeps
 * the entry, and only a run-created policy that passes every check below is carved out of it. Identity principals (roles, users,
 * groups, service principals, managed identities) are never carved out.
 *
 * AWS. A customer-managed policy, an inline policy and a managed-policy attachment, each in its Terraform `aws_` form, the Cloud
 * Control provider's `awscc_` form and the CloudFormation form. The rules (applied in src/apply/cleanup-proposal.ts):
 *  - a customer-managed policy (never an AWS-managed one, `arn:aws:iam::aws:policy/...`) is deletable when this run created it and
 *    nothing this cleanup keeps still attaches it;
 *  - an inline policy is deletable when every principal it is on is a principal this run created (kept, as every principal is);
 *  - an attachment is deletable when every principal it is on is a principal this run created and the policy it attaches is a
 *    customer-managed policy this run created that this cleanup deletes too. So an attachment of a run-created policy to a
 *    pre-existing principal is held, and so is the policy;
 *  - a link that names a pilot identity (DISCOVERY, STATE, STATE_WRITE, APPLY, CHANGESET) is held by the identity rule, whatever
 *    else holds;
 *  - a link the state does not let the blueprint read (every CloudFormation form: a stack resource carries no properties in the
 *    blueprint) is held by the identity rule.
 * Principals are named in the state by name. The blueprint copies only the principal names and the policy ARN of these types
 * (`policyLinkOf`), never a policy document.
 *
 * Azure. A policy definition and a policy set definition at the target subscription's own scope, and a policy assignment at that
 * subscription, a resource group in it or a resource in it, when this run created it. A management-group scope, a built-in
 * definition, another subscription or an id that does not parse in full is never the contract's, so it stays PROTECTED_IDENTITY.
 *
 * UNVERIFIED (live): the attribute names are those of the AWS provider 5.x and the awscc provider 1.x schemas, from their documentation.
 */

export type PrincipalKind = "ROLE" | "USER" | "GROUP";
export type PolicyLink = {
  /** The principals the policy is on (inline), attaches to (attachment) or lists (an awscc managed policy's roles, users and groups). */
  principals: { kind: PrincipalKind; name: string }[];
  /** A managed policy's own ARN, or the ARN an attachment attaches; null for an inline policy. */
  policyArn: string | null;
};

export type AwsPolicyRole = "MANAGED_POLICY" | "INLINE_POLICY" | "ATTACHMENT";
export type AwsPolicyEntry = {
  type: string;
  role: AwsPolicyRole;
  what: string;
  /** Where the blueprint reads the link from the state's attributes; absent for a form whose state holds none (CloudFormation): always held. */
  read?: { principal?: [PrincipalKind, string]; principalLists?: [PrincipalKind, string][]; policyArn?: string };
};

export const AWS_RUN_CREATED_POLICY_TYPES: readonly AwsPolicyEntry[] = [
  { type: "aws_iam_policy", role: "MANAGED_POLICY", what: "a customer-managed IAM policy", read: { policyArn: "arn" } },
  { type: "awscc_iam_managed_policy", role: "MANAGED_POLICY", what: "a customer-managed IAM policy",
    read: { policyArn: "policy_arn", principalLists: [["ROLE", "roles"], ["USER", "users"], ["GROUP", "groups"]] } },
  { type: "AWS::IAM::ManagedPolicy", role: "MANAGED_POLICY", what: "a customer-managed IAM policy" },
  { type: "aws_iam_role_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a role", read: { principal: ["ROLE", "role"] } },
  { type: "aws_iam_user_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a user", read: { principal: ["USER", "user"] } },
  { type: "aws_iam_group_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a group", read: { principal: ["GROUP", "group"] } },
  { type: "awscc_iam_role_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a role", read: { principal: ["ROLE", "role_name"] } },
  { type: "awscc_iam_user_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a user", read: { principal: ["USER", "user_name"] } },
  { type: "awscc_iam_group_policy", role: "INLINE_POLICY", what: "an inline IAM policy on a group", read: { principal: ["GROUP", "group_name"] } },
  { type: "AWS::IAM::Policy", role: "INLINE_POLICY", what: "an inline IAM policy" },
  { type: "AWS::IAM::RolePolicy", role: "INLINE_POLICY", what: "an inline IAM policy on a role" },
  { type: "AWS::IAM::UserPolicy", role: "INLINE_POLICY", what: "an inline IAM policy on a user" },
  { type: "AWS::IAM::GroupPolicy", role: "INLINE_POLICY", what: "an inline IAM policy on a group" },
  { type: "aws_iam_role_policy_attachment", role: "ATTACHMENT", what: "a managed policy's attachment to a role", read: { principal: ["ROLE", "role"], policyArn: "policy_arn" } },
  { type: "aws_iam_user_policy_attachment", role: "ATTACHMENT", what: "a managed policy's attachment to a user", read: { principal: ["USER", "user"], policyArn: "policy_arn" } },
  { type: "aws_iam_group_policy_attachment", role: "ATTACHMENT", what: "a managed policy's attachment to a group", read: { principal: ["GROUP", "group"], policyArn: "policy_arn" } },
];

/**
 * Types whose link the blueprint also records although they are never carved out: an exclusive attachment manages every attachment of
 * a policy, so it stays PROTECTED_IDENTITY, but a run-created policy it attaches must be held with it (or the destroy plan would take it along).
 */
const LINK_ONLY: Readonly<Record<string, NonNullable<AwsPolicyEntry["read"]>>> = {
  aws_iam_policy_attachment: { policyArn: "policy_arn", principalLists: [["ROLE", "roles"], ["USER", "users"], ["GROUP", "groups"]] },
};

/** The principal types, by kind; the id each records is the principal's name. */
export const AWS_PRINCIPAL_TYPES: Readonly<Record<PrincipalKind, readonly string[]>> = {
  ROLE: ["aws_iam_role", "awscc_iam_role", "AWS::IAM::Role"],
  USER: ["aws_iam_user", "awscc_iam_user", "AWS::IAM::User"],
  GROUP: ["aws_iam_group", "awscc_iam_group", "AWS::IAM::Group"],
};

/** Whether the blueprint records a policy link for this type. */
export const isPolicyLinkType = (type: string): boolean => awsPolicyEntryOf(type)?.read !== undefined || Object.hasOwn(LINK_ONLY, type);

export const awsPolicyEntryOf = (type: string): AwsPolicyEntry | undefined => AWS_RUN_CREATED_POLICY_TYPES.find((entry) => entry.type === type);

/** An IAM principal name as AWS allows it (no path, no ARN): anything else is not a name the cleanup can match, so the link is unreadable. */
const PRINCIPAL_NAME = /^[\w+=,.@-]{1,128}$/;
/** A customer-managed policy ARN: an account id, never `aws` (an AWS-managed policy), in any partition. */
export const CUSTOMER_POLICY_ARN = /^arn:aws(?:-[a-z]+)*:iam::[0-9]{12}:policy\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,128}$/;
const MAX_PRINCIPALS = 64;

/**
 * The policy link of one state instance, read from its attributes, for the reviewed types only: undefined for any other type, and for
 * a reviewed type whose attributes do not give a link the cleanup can match exactly (it is then held by the identity rule). Copies
 * only principal names and one ARN.
 */
export function policyLinkOf(type: string, values: Record<string, unknown>): PolicyLink | undefined {
  const read = awsPolicyEntryOf(type)?.read ?? LINK_ONLY[type];
  if (read === undefined) return undefined;
  const principals: PolicyLink["principals"] = [];
  if (read.principal) {
    const name = values[read.principal[1]];
    if (typeof name !== "string" || !PRINCIPAL_NAME.test(name)) return undefined;
    principals.push({ kind: read.principal[0], name });
  }
  for (const [kind, field] of read.principalLists ?? []) {
    const list = values[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || !list.every((name) => typeof name === "string" && PRINCIPAL_NAME.test(name))) return undefined;
    for (const name of list as string[]) principals.push({ kind, name });
  }
  if (principals.length > MAX_PRINCIPALS) return undefined;
  let policyArn: string | null = null;
  if (read.policyArn) {
    const arn = values[read.policyArn];
    if (typeof arn !== "string" || arn.length > 2048 || !arn.startsWith("arn:")) return undefined;
    policyArn = arn;
  }
  return { principals, policyArn };
}

/** Shape check for a stored link (src/apply/run-records.ts). */
export function policyLinkOk(value: unknown): value is PolicyLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  return Object.keys(link).sort().join() === "policyArn,principals" && Array.isArray(link.principals) && link.principals.length <= MAX_PRINCIPALS &&
    link.principals.every((p) => typeof p === "object" && p !== null && Object.keys(p).sort().join() === "kind,name" && ["ROLE", "USER", "GROUP"].includes((p as { kind: string }).kind) &&
      typeof (p as { name: unknown }).name === "string" && PRINCIPAL_NAME.test((p as { name: string }).name)) &&
    (link.policyArn === null || (typeof link.policyArn === "string" && link.policyArn.startsWith("arn:") && link.policyArn.length <= 2048));
}

// --- Azure ----------------------------------------------------------------------------------------------------------------

export type AzurePolicyEntry = { type: string; what: string; armType: "policyDefinitions" | "policySetDefinitions" | "policyAssignments"; scope: "SUBSCRIPTION" | "UNDER_SUBSCRIPTION" };

export const AZURE_RUN_CREATED_POLICY_TYPES: readonly AzurePolicyEntry[] = [
  { type: "azurerm_policy_definition", what: "a custom policy definition", armType: "policyDefinitions", scope: "SUBSCRIPTION" },
  { type: "azurerm_policy_set_definition", what: "a custom policy set definition (initiative)", armType: "policySetDefinitions", scope: "SUBSCRIPTION" },
  { type: "azurerm_subscription_policy_assignment", what: "a policy assignment at the subscription", armType: "policyAssignments", scope: "SUBSCRIPTION" },
  { type: "azurerm_resource_group_policy_assignment", what: "a policy assignment at a resource group", armType: "policyAssignments", scope: "UNDER_SUBSCRIPTION" },
  { type: "azurerm_resource_policy_assignment", what: "a policy assignment at a resource", armType: "policyAssignments", scope: "UNDER_SUBSCRIPTION" },
  // A management group is never a scope the contract owns: listed so the type is reviewed, and always held.
  { type: "azurerm_management_group_policy_assignment", what: "a policy assignment at a management group", armType: "policyAssignments", scope: "SUBSCRIPTION" },
];

const PROTECTED_PAIR = (namespace: string, typePath: string): boolean =>
  /^Microsoft\.(?:Authorization|ManagedIdentity)$/i.test(namespace) || (/^Microsoft\.Resources$/i.test(namespace) && /^deployments(?:\/|$)/i.test(typePath)) || typePath === "";

/**
 * Why a run-created Azure policy object is not one the cleanup may delete, or undefined when it is: its type is reviewed, its id parses
 * in full as that type's object, and its scope is the target subscription (`subscriptionId`, the proposal's target account) or a
 * resource group or a resource in it, with no other authorization, identity or deployment segment on the way.
 */
export function azurePolicyProblem(type: string, id: string | null, subscriptionId: string): string | undefined {
  const entry = AZURE_RUN_CREATED_POLICY_TYPES.find((x) => x.type === type);
  if (entry === undefined) return "its type is not on the reviewed run-created policy list";
  if (id === null) return "the state records no id, so its scope cannot be read";
  const parsed = parseArmId(id);
  if (parsed === undefined) return "its id does not parse in full";
  const last = parsed.pairs[parsed.pairs.length - 1];
  if (last === undefined || !/^Microsoft\.Authorization$/i.test(last.namespace) || last.typePath.toLowerCase() !== entry.armType.toLowerCase()) return "its id is not a " + entry.armType + " object";
  if (parsed.subscription === undefined || parsed.subscription.toLowerCase() !== subscriptionId.toLowerCase()) return "its scope is not the target subscription the pilot contract owns";
  const before = parsed.pairs.slice(0, -1);
  if (entry.scope === "SUBSCRIPTION" && (parsed.resourceGroup !== undefined || before.length > 0)) return "it is not at the subscription's own scope";
  if (before.some((pair) => PROTECTED_PAIR(pair.namespace, pair.typePath))) return "its scope is itself an authorization, identity or deployment object";
  return undefined;
}
