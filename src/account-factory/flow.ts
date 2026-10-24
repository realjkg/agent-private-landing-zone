import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";

const exec = promisify(execFile);
export const MANAGEMENT_ACCOUNT = "973471129135";
export const WORKLOADS_OU = "ou-dnkl-3tbf48bv";
export const REGION = "us-east-2";
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{1,49}$/;
const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const array = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(obj) : [];
const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export type AwsCall = (profile: string, args: readonly string[]) => Promise<Record<string, any>>;

/** Administrative SSO API boundary: shell-free, fixed process and arguments, credential values never returned to agents. */
export const awsAdminCall: AwsCall = async (profile, args) => {
  if (!PROFILE.test(profile)) throw Error("AWS_PROFILE_INVALID");
  // A specifically selected operator profile is an administrative account-vending identity,
  // NOT a DISCOVERY/STATE/APPLY identity and NOT a general-purpose model tool.
  const { stdout } = await exec("aws", [...args, "--profile", profile, "--region", REGION, "--output", "json"], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "", AWS_DEFAULT_REGION: REGION,
    }, shell: false, timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return obj(JSON.parse(stdout));
};
export type Intake = {
  profile: string; name: string; email: string; ownerEmail: string;
  ownerFirst: string; ownerLast: string;
};
export function validateIntake(value: Intake): Intake {
  if (!PROFILE.test(value.profile)) throw Error("AWS_PROFILE_INVALID");
  if (!ACCOUNT_NAME.test(value.name)) throw Error("ACCOUNT_NAME_INVALID");
  if (!EMAIL.test(value.email) || !EMAIL.test(value.ownerEmail)) throw Error("ACCOUNT_EMAIL_INVALID");
  if (value.ownerFirst.trim().length < 1 || value.ownerFirst.length > 64 ||
      value.ownerLast.trim().length < 1 || value.ownerLast.length > 64) throw Error("OWNER_NAME_INVALID");
  return value;
}
export type AccountProposal = {
  schema: 1; createdAt: string; expiresAt: string; identity: { Account: string; Arn: string };
  orgId: string; ouId: string; ouArn: string; accountName: string; accountEmail: string;
  owner: { email: string; first: string; last: string };
  productId: string; artifactId: string; pathId: string;
  baseline: string; managementAccount: string; region: string;
  parameters: Array<{ Key: string; Value: string }>;
  proposalHash: string; status: "AWAITING_OWNER_AND_FINANCE_APPROVAL";
  financialEvidence: "UNVERIFIED"; pilotCeilingUsd: 80; infrastructureAct: "DISABLED";
};
export async function verifyAdministrator(profile: string, call: AwsCall = awsAdminCall) {
  const identity = await call(profile, ["sts", "get-caller-identity"]);
  const arn = String(identity.Arn ?? "");
  if (identity.Account !== MANAGEMENT_ACCOUNT ||
      !new RegExp("^arn:aws:sts::" + MANAGEMENT_ACCOUNT +
        ":assumed-role/AWSReservedSSO_AWSAdministratorAccess_[A-Za-z0-9]+/[^/]+$").test(arn))
    throw Error("MANAGEMENT_SSO_ADMIN_REQUIRED");
  return { Account: String(identity.Account), Arn: arn };
}
export async function prepare(intake: Intake, call: AwsCall = awsAdminCall, now = new Date()): Promise<AccountProposal> {
  validateIntake(intake);
  const identity = await verifyAdministrator(intake.profile, call);
  const aws = (service: string, operation: string, ...args: string[]) =>
    call(intake.profile, [service, operation, ...args]);
  const org = obj((await aws("organizations", "describe-organization")).Organization);
  if (org.Id !== "o-0u6mts6li3" || (org.ManagementAccountId ?? org.MasterAccountId) !== MANAGEMENT_ACCOUNT)
    throw Error("ORGANIZATION_MISMATCH");
  const accounts = array((await aws("organizations", "list-accounts")).Accounts);
  if (accounts.some(x => String(x.Email ?? "").toLowerCase() === intake.email.toLowerCase() ||
    String(x.Name ?? "").toLowerCase() === intake.name.toLowerCase()))
    throw Error("ACCOUNT_ALREADY_EXISTS");
  const ou = obj((await aws("organizations", "describe-organizational-unit",
    "--organizational-unit-id", WORKLOADS_OU)).OrganizationalUnit);
  if (ou.Id !== WORKLOADS_OU || ou.Name !== "Workloads" || typeof ou.Arn !== "string")
    throw Error("WORKLOADS_OU_UNVERIFIED");
  const landingZones = array((await aws("controltower", "list-landing-zones")).landingZones);
  if (!landingZones.some(x => x.arn ===
    "arn:aws:controltower:us-east-2:973471129135:landingzone/253WW1B5S01IEWOT"))
    throw Error("CONTROL_TOWER_NOT_FOUND");
  const lz = await aws("controltower", "get-landing-zone", "--landing-zone-identifier",
    "arn:aws:controltower:us-east-2:973471129135:landingzone/253WW1B5S01IEWOT");
  if (obj(lz.landingZone).status !== "ACTIVE" ||
      obj(obj(lz.landingZone).driftStatus).status !== "IN_SYNC")
    throw Error("LANDING_ZONE_NOT_HEALTHY");
  const baselines = array((await aws("controltower", "list-enabled-baselines")).enabledBaselines);
  const verifiedBaseline = baselines.find(x => x.targetIdentifier === ou.Arn &&
    obj(x.statusSummary).status === "SUCCEEDED");
  if (!verifiedBaseline) throw Error("OU_BASELINE_NOT_HEALTHY");
  // Fetch the currently offered Service Catalog Account Factory product rather than invent IDs.
  const listed = array((await aws("servicecatalog", "search-products-as-admin")).ProductViewDetails);
  const candidates = listed.filter(x => /AWS Control Tower Account Factory/i.test(
    String(obj(x.ProductViewSummary).Name ?? "")));
  if (candidates.length !== 1) throw Error("ACCOUNT_FACTORY_PRODUCT_AMBIGUOUS_OR_MISSING");
  const productId = String(obj(candidates[0].ProductViewSummary).ProductId ?? "");
  const details = await aws("servicecatalog", "describe-product-as-admin", "--id", productId);
  const artifacts = array(details.ProvisioningArtifactSummaries);
  const active = artifacts.filter(x => x.Active === true);
  if (active.length !== 1) throw Error("ACCOUNT_FACTORY_ARTIFACT_REVIEW_REQUIRED");
  const paths = array((await aws("servicecatalog", "list-launch-paths", "--product-id", productId)).LaunchPathSummaries);
  if (paths.length !== 1) throw Error("ACCOUNT_FACTORY_LAUNCH_PATH_REVIEW_REQUIRED");
  const artifactId = String(active[0].Id ?? ""), pathId = String(paths[0].Id ?? "");
  if (!/^prod-[a-z0-9]+$/.test(productId) ||
      !/^pa-[a-z0-9]+$/.test(artifactId) || !/^lp-[a-z0-9]+$/.test(pathId))
    throw Error("ACCOUNT_FACTORY_IDENTIFIERS_INVALID");
  const keys = array((await aws("servicecatalog", "describe-provisioning-parameters",
    "--product-id", productId, "--provisioning-artifact-id", artifactId,
    "--path-id", pathId)).ProvisioningArtifactParameters).map(x => String(obj(x.Parameter).ParameterKey ?? ""));
  const required = ["AccountName", "AccountEmail", "SSOUserEmail", "SSOUserFirstName",
    "SSOUserLastName", "ManagedOrganizationalUnit"];
  if (!required.every(x => keys.includes(x))) throw Error("ACCOUNT_FACTORY_SCHEMA_UNEXPECTED");
  const parameters = [
    { Key: "AccountName", Value: intake.name },
    { Key: "AccountEmail", Value: intake.email },
    { Key: "SSOUserEmail", Value: intake.ownerEmail },
    { Key: "SSOUserFirstName", Value: intake.ownerFirst },
    { Key: "SSOUserLastName", Value: intake.ownerLast },
    { Key: "ManagedOrganizationalUnit", Value: ou.Name + " (" + ou.Id + ")" },
  ];
  const draft = {
    schema: 1 as const, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    identity, orgId: String(org.Id), ouId: WORKLOADS_OU, ouArn: String(ou.Arn),
    accountName: intake.name, accountEmail: intake.email,
    owner: { email: intake.ownerEmail, first: intake.ownerFirst, last: intake.ownerLast },
    productId, artifactId, pathId, baseline: String(verifiedBaseline.baselineIdentifier),
    managementAccount: MANAGEMENT_ACCOUNT, region: REGION, parameters,
  };
  return { ...draft, proposalHash: digest(draft),
    status: "AWAITING_OWNER_AND_FINANCE_APPROVAL", financialEvidence: "UNVERIFIED",
    pilotCeilingUsd: 80, infrastructureAct: "DISABLED" };
}
export function verifyProposal(proposal: AccountProposal, now = new Date()) {
  const { proposalHash, status, financialEvidence, pilotCeilingUsd, infrastructureAct, ...draft } = proposal;
  if (digest(draft) !== proposalHash || draft.managementAccount !== MANAGEMENT_ACCOUNT ||
    draft.ouId !== WORKLOADS_OU || draft.region !== REGION ||
    draft.parameters.length !== 6 || draft.identity.Account !== MANAGEMENT_ACCOUNT)
    throw Error("PROPOSAL_TAMPERED_OR_WRONG_TARGET");
  if (Number.isNaN(Date.parse(draft.createdAt)) || Number.isNaN(Date.parse(draft.expiresAt)) ||
      now < new Date(draft.createdAt) || now > new Date(draft.expiresAt))
    throw Error("PROPOSAL_EXPIRED");
  return proposalHash;
}
export function writePrivateJson(file: string, value: unknown) {
  mkdirSync(dirname(resolve(file)), { recursive: true, mode: 0o700 });
  const descriptor = openSync(resolve(file), "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n"); }
  finally { closeSync(descriptor); }
}
export function loadProposal(file: string): AccountProposal {
  const v = JSON.parse(readFileSync(resolve(file), "utf8")) as AccountProposal;
  verifyProposal(v);
  return v;
}
export type Submission = {
  schema: 1; requestHash: string; recordId: string; provisionedProductId?: string;
  createdAt: string; status: "SUBMITTED"; infrastructureAct: "DISABLED";
};
export async function submit(
  proposal: AccountProposal, profile: string, acceptedHash: string,
  financiallyAuthorized: boolean, caller: AwsCall = awsAdminCall,
): Promise<Submission> {
  verifyProposal(proposal);
  if (!financiallyAuthorized || acceptedHash !== proposal.proposalHash)
    throw Error("OWNER_AND_FINANCE_APPROVAL_REQUIRED");
  const current = await verifyAdministrator(profile, caller);
  if (current.Arn !== proposal.identity.Arn) throw Error("ADMIN_SESSION_CHANGED");
  // Recheck account uniqueness immediately before the mutation.
  const accounts = array((await caller(profile, ["organizations", "list-accounts"])).Accounts);
  if (accounts.some(a => String(a.Email ?? "").toLowerCase() === proposal.accountEmail.toLowerCase() ||
    String(a.Name ?? "").toLowerCase() === proposal.accountName.toLowerCase()))
    throw Error("ACCOUNT_ALREADY_EXISTS");
  const result = await caller(profile, ["servicecatalog", "provision-product",
    "--product-id", proposal.productId,
    "--provisioning-artifact-id", proposal.artifactId,
    "--path-id", proposal.pathId, "--provisioned-product-name", proposal.accountName,
    "--provisioning-parameters", JSON.stringify(proposal.parameters),
    "--provision-token", proposal.proposalHash.slice(0, 32)]);
  const record = obj(result.RecordDetail);
  if (typeof record.RecordId !== "string" || !record.RecordId.startsWith("rec-"))
    throw Error("ACCOUNT_FACTORY_RESPONSE_UNVERIFIED");
  return { schema: 1, requestHash: proposal.proposalHash, recordId: record.RecordId,
    ...(record.ProvisionedProductId ? { provisionedProductId: String(record.ProvisionedProductId) } : {}),
    createdAt: new Date().toISOString(), status: "SUBMITTED", infrastructureAct: "DISABLED" };
}
export async function status(profile: string, recordId: string, call: AwsCall = awsAdminCall) {
  if (!/^rec-[a-z0-9]+$/.test(recordId)) throw Error("RECORD_ID_INVALID");
  await verifyAdministrator(profile, call);
  const record = obj((await call(profile, ["servicecatalog", "describe-record", "--id", recordId])).RecordDetail);
  if (record.RecordId !== recordId) throw Error("RECORD_ID_MISMATCH");
  return { recordId, providerStatus: String(record.Status ?? "UNKNOWN"),
    recordType: String(record.RecordType ?? "UNKNOWN"),
    verified: false, accountProvisioningComplete: record.Status === "SUCCEEDED",
    note: "Service Catalog record status is not independent Organizations and Control Tower account verification." };
}

/** Independent Organizations and Control Tower read-back after Account Factory completes. */
export async function verifyProvisionedAccount(
  profile: string, name: string, email: string, call: AwsCall = awsAdminCall,
) {
  if (!ACCOUNT_NAME.test(name) || !EMAIL.test(email)) throw Error("ACCOUNT_IDENTIFIERS_INVALID");
  const identity = await verifyAdministrator(profile, call);
  const aws = (service: string, operation: string, ...args: string[]) =>
    call(profile, [service, operation, ...args]);
  const matches = array((await aws("organizations", "list-accounts")).Accounts).filter(x =>
    String(x.Name) === name && String(x.Email).toLowerCase() === email.toLowerCase());
  if (matches.length !== 1) throw Error("ACCOUNT_NOT_UNIQUELY_IDENTIFIED");
  const account = matches[0]!;
  const accountId = String(account.Id ?? "");
  if (!/^\d{12}$/.test(accountId) || accountId === MANAGEMENT_ACCOUNT ||
      (account.State ?? account.Status) !== "ACTIVE")
    throw Error("DEDICATED_MEMBER_ACCOUNT_NOT_ACTIVE");
  const parents = array((await aws("organizations", "list-parents", "--child-id", accountId)).Parents);
  if (!parents.some(x => x.Id === WORKLOADS_OU && x.Type === "ORGANIZATIONAL_UNIT"))
    throw Error("ACCOUNT_NOT_IN_WORKLOADS");
  const ou = obj((await aws("organizations", "describe-organizational-unit",
    "--organizational-unit-id", WORKLOADS_OU)).OrganizationalUnit);
  if (ou.Id !== WORKLOADS_OU || typeof ou.Arn !== "string")
    throw Error("WORKLOADS_OU_UNVERIFIED");
  const enabled = array((await aws("controltower", "list-enabled-baselines")).enabledBaselines);
  if (!enabled.some(x => x.targetIdentifier === ou.Arn && obj(x.statusSummary).status === "SUCCEEDED"))
    throw Error("WORKLOADS_BASELINE_NOT_HEALTHY");
  return {
    status: "ACCOUNT_ORGANIZATION_AND_OU_VERIFIED" as const,
    accountId, name, managementAccount: identity.Account,
    targetOuId: WORKLOADS_OU, baseline: "SUCCEEDED" as const,
    controlTowerAccountEnrollment: "NOT_INDEPENDENTLY_CONFIRMED" as const,
    finances: "UNVERIFIED" as const, infrastructureAct: "DISABLED" as const,
  };
}
