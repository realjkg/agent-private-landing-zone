import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ACCOUNT = /^[0-9]{12}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const AWS_MANAGEMENT = "973471129135";
export const AWS_DEV_OU = "ou-dnkl-3tbf48bv";
export const AWS_REGION = "us-east-2";
export const AWS_BASELINE = "arn:aws:controltower:us-east-2::baseline/17BSJV3IGJ2QSGA2";

export type AdminReadiness = {
  status: "ACCOUNT_VERIFIED";
  account: string;
  checks: { name: string; status: "VERIFIED" | "NOT_CHECKED"; next: string }[];
  action: "NONE";
  actEnabled: false;
};
export type AwsRead = (args: readonly string[]) => Promise<unknown>;

export function validatedAccountRequest(value: unknown): { profile: string; account: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("REQUEST_INVALID");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "account,profile") throw Error("REQUEST_INVALID");
  if (typeof input.profile !== "string" || !PROFILE.test(input.profile)) throw Error("AWS_CONNECTION_NAME_INVALID");
  if (typeof input.account !== "string" || !ACCOUNT.test(input.account) || input.account === AWS_MANAGEMENT)
    throw Error("DEDICATED_DEV_ACCOUNT_REQUIRED");
  return { profile: input.profile, account: input.account };
}

/** Only fixed, read-only AWS CLI commands are constructed by checkDevAccount. No user-supplied flags or shell. */
export async function awsRead(args: readonly string[]): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR, AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "",
  };
  const { stdout } = await execute("aws", [...args], {
    env, shell: false, windowsHide: true, timeout: 25_000, maxBuffer: 512 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}
const record = (name: string, next: string) => ({ name, status: "VERIFIED" as const, next });
const jsonObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(jsonObject) : [];

/** Verifies account scope. A successful result never marks financial, bootstrap, approvals or ACT ready. */
export async function checkDevAccount(input: { profile: string; account: string }, read: AwsRead = awsRead): Promise<AdminReadiness> {
  const request = validatedAccountRequest(input);
  const run = (service: string, method: string, ...args: string[]) =>
    read([service, method, ...args, "--profile", request.profile, "--region", AWS_REGION, "--output", "json"]);
  const caller = jsonObject(await run("sts", "get-caller-identity"));
  if (caller.Account !== AWS_MANAGEMENT) throw Error("WRONG_MANAGEMENT_CONNECTION");
  const account = jsonObject(jsonObject(await run("organizations", "describe-account",
    "--account-id", request.account)).Account);
  if (account.Id !== request.account || (account.State ?? account.Status) !== "ACTIVE")
    throw Error("ACCOUNT_NOT_ACTIVE");
  const parents = objects(jsonObject(await run("organizations", "list-parents", "--child-id", request.account)).Parents);
  if (!parents.some((p) => p.Id === AWS_DEV_OU && p.Type === "ORGANIZATIONAL_UNIT"))
    throw Error("ACCOUNT_NOT_IN_WORKLOADS");
  const ou = jsonObject(jsonObject(await run("organizations", "describe-organizational-unit",
    "--organizational-unit-id", AWS_DEV_OU)).OrganizationalUnit);
  if (typeof ou.Arn !== "string" || !ou.Arn.endsWith("/" + AWS_DEV_OU))
    throw Error("WORKLOAD_OU_UNVERIFIED");
  // Control Tower paginates; AWS CLI auto-paginates list-enabled-baselines.
  const baselines = objects(jsonObject(await run("controltower", "list-enabled-baselines")).enabledBaselines);
  if (!baselines.some((entry) =>
    entry.baselineIdentifier === AWS_BASELINE && entry.targetIdentifier === ou.Arn &&
    jsonObject(entry.statusSummary).status === "SUCCEEDED"))
    throw Error("BASELINE_NOT_VERIFIED");
  return {
    status: "ACCOUNT_VERIFIED", account: request.account,
    checks: [
      record("AWS sign-in", "Signed in to the organization account."),
      record("DEV account", "Dedicated member account is active."),
      record("Governance", "Account is in the expected governed Workloads area."),
    ],
    action: "NONE", actEnabled: false,
  };
}

export const ADMIN_NEXT = [
  { id: "account", title: "Connect AWS", detail: "Verify the DEV account and its safeguards." },
  { id: "cost", title: "Confirm spending", detail: "Review alerts, service limits, and owner-approved maximum spend." },
  { id: "access", title: "Set up access", detail: "Prepare four separate short-lived access roles and a protected state store." },
  { id: "identity", title: "Check sign-ins", detail: "Validate independent access for each role." },
  { id: "change", title: "Review changes", detail: "Confirm new, modified, and terminated resources against policy." },
  { id: "approval", title: "Approve and apply", detail: "An authorized person reviews and confirms the exact change." },
  { id: "verify", title: "Verify the result", detail: "Read the resource back independently and record the outcome." },
] as const;
