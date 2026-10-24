import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isPracticeRole, type PracticeRole } from "./practice-roles.js";

const exec = promisify(execFile);
export const REGION = process.env.ALZ_ACCOUNT_FACTORY_REGION || "us-east-2";
export const DEFAULT_OU = process.env.ALZ_ACCOUNT_FACTORY_OU || "Workloads";
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const OU_ID = /^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,49}$/;
const ENVS = ["DEV", "QA", "STAGING", "PROD"] as const;
export type AccountEnvironment = typeof ENVS[number];

function object(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
}
function records(v: unknown): Record<string, any>[] {
  return Array.isArray(v) ? v.map(object) : [];
}
function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
function ensureRegion(region: string) {
  if (!AWS_REGION.test(region)) throw Error("AWS_REGION_INVALID");
}
function targetOu() {
  if (!DEFAULT_OU || DEFAULT_OU.length > 128 || /[\x00-\x1f]/.test(DEFAULT_OU))
    throw Error("TARGET_OU_INVALID");
  return DEFAULT_OU;
}
export type AwsCall = (profile: string, args: readonly string[]) => Promise<Record<string, any>>;
/** An explicitly named profile, not ambient AWS_* secrets, supplies the operator's AWS-native identity. */
export const awsAdminCall: AwsCall = async (profile, args) => {
  if (!PROFILE.test(profile)) throw Error("AWS_PROFILE_INVALID");
  ensureRegion(REGION);
  const { stdout } = await exec(
    "aws", [...args, "--profile", profile, "--region", REGION, "--output", "json", "--no-cli-pager"],
    {
      env: {
        HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        PATH: process.env.PATH, AWS_EC2_METADATA_DISABLED: "true",
        AWS_PAGER: "", AWS_DEFAULT_REGION: REGION,
        AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
        AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
      },
      shell: false, timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    },
  );
  return object(JSON.parse(stdout));
};
export type Intake = {
  profile: string; practiceRole: PracticeRole; environment: AccountEnvironment;
  name: string; email: string; ownerEmail: string; ownerFirst: string; ownerLast: string;
};
export function validateIntake(value: Intake): Intake {
  if (!PROFILE.test(value.profile)) throw Error("AWS_PROFILE_INVALID");
  if (!isPracticeRole(value.practiceRole)) throw Error("PRACTICE_ROLE_INVALID");
  if (!ENVS.includes(value.environment)) throw Error("ENVIRONMENT_INVALID");
  if (!ACCOUNT_NAME.test(value.name)) throw Error("ACCOUNT_NAME_INVALID");
  if (!EMAIL.test(value.email) || !EMAIL.test(value.ownerEmail)) throw Error("ACCOUNT_EMAIL_INVALID");
  if (!value.ownerFirst.trim() || !value.ownerLast.trim() ||
    value.ownerFirst.length > 64 || value.ownerLast.length > 64)
    throw Error("OWNER_NAME_INVALID");
  ensureRegion(REGION);
  targetOu();
  return value;
}
export type AwsIdentity = { Account: string; Arn: string };
export async function verifyAdministrator(profile: string, call: AwsCall = awsAdminCall): Promise<AwsIdentity> {
  if (!PROFILE.test(profile)) throw Error("AWS_PROFILE_INVALID");
  const identity = await call(profile, ["sts", "get-caller-identity"]);
  const account = String(identity.Account ?? "");
  const arn = String(identity.Arn ?? "");
  // Caller is the org's management-account assumed role. Effective permissions remain enforced by AWS IAM.
  if (!/^\d{12}$/.test(account) ||
      !new RegExp("^arn:aws(?:-us-gov)?:sts::" + account +
        ":assumed-role/[A-Za-z0-9+=,.@_-]+/[^/]+$").test(arn))
    throw Error("ASSUMED_ROLE_SESSION_REQUIRED");
  return { Account: account, Arn: arn };
}
async function discoverOrganization(profile: string, call: AwsCall, identity: AwsIdentity) {
  const org = object((await call(profile, ["organizations", "describe-organization"])).Organization);
  if (!/^o-[a-z0-9]{10,32}$/.test(String(org.Id ?? "")) ||
      (org.ManagementAccountId ?? org.MasterAccountId) !== identity.Account)
    throw Error("MANAGEMENT_ORGANIZATION_MISMATCH");
  return String(org.Id);
}
async function discoverOu(profile: string, call: AwsCall, organizationId: string) {
  const sought = targetOu();
  if (OU_ID.test(sought)) {
    const ou = object((await call(profile, ["organizations", "describe-organizational-unit",
      "--organizational-unit-id", sought])).OrganizationalUnit);
    if (ou.Id !== sought || !String(ou.Arn ?? "").includes(organizationId))
      throw Error("TARGET_OU_NOT_FOUND");
    return ou;
  }
  const roots = records((await call(profile, ["organizations", "list-roots"])).Roots);
  if (roots.length === 0) throw Error("ORGANIZATION_ROOT_MISSING");
  const queue = roots.map(root => String(root.Id ?? ""));
  const visited = new Set<string>();
  const matches: Record<string, any>[] = [];
  while (queue.length > 0 && visited.size < 256) {
    const parent = queue.shift()!;
    if (!/^(?:r|ou)-[a-z0-9-]+$/.test(parent) || visited.has(parent))
      throw Error("OU_HIERARCHY_INVALID");
    visited.add(parent);
    const ous = records((await call(profile, ["organizations", "list-organizational-units-for-parent",
      "--parent-id", parent])).OrganizationalUnits);
    for (const ou of ous) {
      if (ou.Name === sought && typeof ou.Arn === "string") matches.push(ou);
      queue.push(String(ou.Id ?? ""));
    }
  }
  if (queue.length > 0) throw Error("OU_HIERARCHY_TOO_LARGE");
  if (matches.length !== 1) throw Error("TARGET_OU_MISSING_OR_AMBIGUOUS");
  return matches[0]!;
}
async function healthyLandingZone(profile: string, call: AwsCall, identity: AwsIdentity) {
  const zones = records((await call(profile, ["controltower", "list-landing-zones"])).landingZones);
  const candidates = zones.filter(zone =>
    String(zone.arn ?? "").startsWith("arn:aws:controltower:" + REGION + ":" + identity.Account + ":landingzone/"));
  if (candidates.length !== 1) throw Error("LANDING_ZONE_MISSING_OR_AMBIGUOUS");
  const arn = String(candidates[0]!.arn);
  const zone = object((await call(profile, ["controltower", "get-landing-zone",
    "--landing-zone-identifier", arn])).landingZone);
  if (zone.arn !== arn || zone.status !== "ACTIVE" ||
    object(zone.driftStatus).status !== "IN_SYNC")
    throw Error("LANDING_ZONE_NOT_HEALTHY");
  return arn;
}
async function healthyBaseline(profile: string, call: AwsCall, ouArn: string) {
  const enabled = records((await call(profile, ["controltower", "list-enabled-baselines"])).enabledBaselines)
    .filter(x => x.targetIdentifier === ouArn && object(x.statusSummary).status === "SUCCEEDED");
  for (const candidate of enabled) {
    const id = String(candidate.baselineIdentifier ?? "");
    if (!id.includes(":baseline/")) continue;
    const baseline = await call(profile, ["controltower", "get-baseline", "--baseline-identifier", id]);
    if (baseline.name === "AWSControlTowerBaseline") return id;
  }
  throw Error("CONTROL_TOWER_OU_BASELINE_NOT_READY");
}
export type AccountProposal = {
  schema: 2; createdAt: string; expiresAt: string;
  identity: AwsIdentity; orgId: string; ouId: string; ouArn: string; ouName: string;
  landingZoneArn: string; accountName: string; accountEmail: string;
  environment: AccountEnvironment; requesterPracticeRole: PracticeRole;
  roleClassification: "DECLARED_NOT_AUTHORIZING";
  owner: { email: string; first: string; last: string };
  productId: string; artifactId: string; pathId: string;
  baseline: string; managementAccount: string; region: string;
  parameters: Array<{ Key: string; Value: string }>;
  proposalHash: string; status: "READY_FOR_CONFIRMATION"; infrastructureAct: "DISABLED";
};
export async function prepare(intake: Intake, call: AwsCall = awsAdminCall, now = new Date()): Promise<AccountProposal> {
  validateIntake(intake);
  const identity = await verifyAdministrator(intake.profile, call);
  const aws = (service: string, operation: string, ...args: string[]) =>
    call(intake.profile, [service, operation, ...args]);
  const orgId = await discoverOrganization(intake.profile, call, identity);
  const accounts = records((await aws("organizations", "list-accounts")).Accounts);
  if (accounts.some(x => String(x.Email ?? "").toLowerCase() === intake.email.toLowerCase() ||
    String(x.Name ?? "").toLowerCase() === intake.name.toLowerCase()))
    throw Error("ACCOUNT_ALREADY_EXISTS");
  const ou = await discoverOu(intake.profile, call, orgId);
  const ouArn = String(ou.Arn ?? "");
  const ouId = String(ou.Id ?? "");
  if (!OU_ID.test(ouId) || !ouArn.includes(orgId)) throw Error("TARGET_OU_INVALID");
  const landingZoneArn = await healthyLandingZone(intake.profile, call, identity);
  const baseline = await healthyBaseline(intake.profile, call, ouArn);
  // Enumerate the actual organization's available product, artifact, launch path and parameter schema.
  const listed = records((await aws("servicecatalog", "search-products-as-admin")).ProductViewDetails);
  const candidateProducts = listed.filter(x => String(object(x.ProductViewSummary).Name ?? "") ===
    "AWS Control Tower Account Factory");
  if (candidateProducts.length !== 1) throw Error("ACCOUNT_FACTORY_PRODUCT_MISSING_OR_AMBIGUOUS");
  const productId = String(object(candidateProducts[0]!.ProductViewSummary).ProductId ?? "");
  const details = await aws("servicecatalog", "describe-product-as-admin", "--id", productId);
  const active = records(details.ProvisioningArtifactSummaries).filter(x => x.Active === true);
  if (active.length !== 1) throw Error("ACCOUNT_FACTORY_ARTIFACT_REVIEW_REQUIRED");
  const paths = records((await aws("servicecatalog", "list-launch-paths",
    "--product-id", productId)).LaunchPathSummaries);
  if (paths.length !== 1) throw Error("ACCOUNT_FACTORY_LAUNCH_PATH_REVIEW_REQUIRED");
  const artifactId = String(active[0]!.Id ?? "");
  const pathId = String(paths[0]!.Id ?? "");
  if (!/^prod-[a-z0-9]+$/.test(productId) || !/^pa-[a-z0-9]+$/.test(artifactId) ||
      !/^lp(?:v[0-9]+)?-[a-z0-9]+$/.test(pathId))
    throw Error("ACCOUNT_FACTORY_IDENTIFIERS_INVALID");
  const keys = records((await aws("servicecatalog", "describe-provisioning-parameters",
    "--product-id", productId, "--provisioning-artifact-id", artifactId,
    "--path-id", pathId)).ProvisioningArtifactParameters)
    .map(x => String(object(x.Parameter).ParameterKey ?? ""));
  const required = ["AccountName", "AccountEmail", "SSOUserEmail", "SSOUserFirstName",
    "SSOUserLastName", "ManagedOrganizationalUnit"];
  if (!required.every(x => keys.includes(x))) throw Error("ACCOUNT_FACTORY_SCHEMA_UNEXPECTED");
  const parameters = [
    { Key: "AccountName", Value: intake.name },
    { Key: "AccountEmail", Value: intake.email },
    { Key: "SSOUserEmail", Value: intake.ownerEmail },
    { Key: "SSOUserFirstName", Value: intake.ownerFirst },
    { Key: "SSOUserLastName", Value: intake.ownerLast },
    { Key: "ManagedOrganizationalUnit", Value: String(ou.Name) + " (" + ouId + ")" },
  ];
  const draft = {
    schema: 2 as const, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    identity, orgId, ouId, ouArn, ouName: String(ou.Name), landingZoneArn,
    accountName: intake.name, accountEmail: intake.email,
    environment: intake.environment, requesterPracticeRole: intake.practiceRole,
    roleClassification: "DECLARED_NOT_AUTHORIZING" as const,
    owner: { email: intake.ownerEmail, first: intake.ownerFirst, last: intake.ownerLast },
    productId, artifactId, pathId, baseline, managementAccount: identity.Account,
    region: REGION, parameters,
  };
  return { ...draft, proposalHash: hash(draft),
    status: "READY_FOR_CONFIRMATION", infrastructureAct: "DISABLED" };
}
export function verifyProposal(proposal: AccountProposal, now = new Date()): string {
  const { proposalHash, status, infrastructureAct, ...draft } = proposal;
  if (proposal.schema !== 2 || hash(draft) !== proposalHash ||
    draft.managementAccount !== draft.identity.Account ||
    draft.region !== REGION || !AWS_REGION.test(draft.region) ||
    !/^\d{12}$/.test(draft.managementAccount) || !/^o-[a-z0-9]{10,32}$/.test(draft.orgId) ||
    !OU_ID.test(draft.ouId) || !String(draft.ouArn).includes(draft.orgId) ||
    !ENVS.includes(draft.environment) || !isPracticeRole(draft.requesterPracticeRole) ||
    draft.roleClassification !== "DECLARED_NOT_AUTHORIZING" ||
    draft.parameters.length !== 6 || !draft.parameters.some(p =>
      p.Key === "ManagedOrganizationalUnit" && p.Value === draft.ouName + " (" + draft.ouId + ")"))
    throw Error("PROPOSAL_TAMPERED_OR_WRONG_TARGET");
  if (Number.isNaN(Date.parse(draft.createdAt)) || Number.isNaN(Date.parse(draft.expiresAt)) ||
    now < new Date(draft.createdAt) || now > new Date(draft.expiresAt))
    throw Error("PROPOSAL_EXPIRED");
  return proposalHash;
}
export function writePrivateJson(file: string, value: unknown) {
  mkdirSync(dirname(resolve(file)), { recursive: true, mode: 0o700 });
  const fd = openSync(resolve(file), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); }
  finally { closeSync(fd); }
}
export function loadProposal(file: string): AccountProposal {
  const p = JSON.parse(readFileSync(resolve(file), "utf8")) as AccountProposal;
  verifyProposal(p);
  return p;
}
export type Submission = {
  schema: 2; requestHash: string; recordId: string; provisionedProductId?: string;
  createdAt: string; status: "SUBMITTED"; infrastructureAct: "DISABLED";
};
export async function submit(proposal: AccountProposal, profile: string, call: AwsCall = awsAdminCall): Promise<Submission> {
  verifyProposal(proposal);
  const current = await verifyAdministrator(profile, call);
  if (current.Arn !== proposal.identity.Arn) throw Error("AWS_IDENTITY_CHANGED");
  const org = await discoverOrganization(profile, call, current);
  if (org !== proposal.orgId) throw Error("ORGANIZATION_CHANGED");
  const accounts = records((await call(profile, ["organizations", "list-accounts"])).Accounts);
  if (accounts.some(a => String(a.Email ?? "").toLowerCase() === proposal.accountEmail.toLowerCase() ||
    String(a.Name ?? "").toLowerCase() === proposal.accountName.toLowerCase()))
    throw Error("ACCOUNT_ALREADY_EXISTS");
  const record = object((await call(profile, ["servicecatalog", "provision-product",
    "--product-id", proposal.productId, "--provisioning-artifact-id", proposal.artifactId,
    "--path-id", proposal.pathId, "--provisioned-product-name", proposal.accountName,
    "--provisioning-parameters", JSON.stringify(proposal.parameters),
    "--provision-token", proposal.proposalHash.slice(0, 32)])).RecordDetail);
  if (!/^rec-[a-z0-9]+$/.test(String(record.RecordId ?? "")))
    throw Error("ACCOUNT_FACTORY_RESPONSE_UNVERIFIED");
  return { schema: 2, requestHash: proposal.proposalHash, recordId: String(record.RecordId),
    ...(record.ProvisionedProductId ? { provisionedProductId: String(record.ProvisionedProductId) } : {}),
    createdAt: new Date().toISOString(), status: "SUBMITTED", infrastructureAct: "DISABLED" };
}
export async function status(profile: string, recordId: string, call: AwsCall = awsAdminCall) {
  if (!/^rec-[a-z0-9]+$/.test(recordId)) throw Error("RECORD_ID_INVALID");
  const identity = await verifyAdministrator(profile, call);
  await discoverOrganization(profile, call, identity);
  const record = object((await call(profile, ["servicecatalog", "describe-record",
    "--id", recordId])).RecordDetail);
  if (record.RecordId !== recordId) throw Error("RECORD_ID_MISMATCH");
  return { recordId, providerStatus: String(record.Status ?? "UNKNOWN"),
    recordType: String(record.RecordType ?? "UNKNOWN"), verified: false,
    accountProvisioningComplete: record.Status === "SUCCEEDED",
    note: "Service Catalog status is not proof of the new account's enrollment or readiness." };
}
export async function verifyProvisionedAccount(
  profile: string, name: string, email: string, call: AwsCall = awsAdminCall,
) {
  if (!ACCOUNT_NAME.test(name) || !EMAIL.test(email)) throw Error("ACCOUNT_IDENTIFIERS_INVALID");
  const identity = await verifyAdministrator(profile, call);
  const orgId = await discoverOrganization(profile, call, identity);
  const accounts = records((await call(profile, ["organizations", "list-accounts"])).Accounts);
  const matches = accounts.filter(x => String(x.Name) === name &&
    String(x.Email).toLowerCase() === email.toLowerCase());
  if (matches.length !== 1) throw Error("ACCOUNT_NOT_UNIQUELY_IDENTIFIED");
  const accountId = String(matches[0]!.Id ?? "");
  if (!/^\d{12}$/.test(accountId) || accountId === identity.Account ||
      (matches[0]!.State ?? matches[0]!.Status) !== "ACTIVE")
    throw Error("DEDICATED_MEMBER_ACCOUNT_NOT_ACTIVE");
  const parents = records((await call(profile, ["organizations", "list-parents",
    "--child-id", accountId])).Parents);
  const parent = parents.find(x => x.Type === "ORGANIZATIONAL_UNIT");
  if (!parent || !OU_ID.test(String(parent.Id ?? ""))) throw Error("ACCOUNT_NOT_IN_MANAGED_OU");
  const ou = object((await call(profile, ["organizations", "describe-organizational-unit",
    "--organizational-unit-id", String(parent.Id)])).OrganizationalUnit);
  if (!String(ou.Arn ?? "").includes(orgId)) throw Error("ACCOUNT_OU_ORGANIZATION_MISMATCH");
  await healthyLandingZone(profile, call, identity);
  const baseline = await healthyBaseline(profile, call, String(ou.Arn));
  return {
    status: "ACCOUNT_ORGANIZATION_AND_OU_VERIFIED" as const,
    accountId, name, organizationId: orgId, managementAccount: identity.Account,
    targetOuId: String(parent.Id), targetOuName: String(ou.Name),
    baseline, baselineStatus: "SUCCEEDED" as const,
    controlTowerAccountEnrollment: "NOT_INDEPENDENTLY_CONFIRMED" as const,
    infrastructureAct: "DISABLED" as const,
  };
}
