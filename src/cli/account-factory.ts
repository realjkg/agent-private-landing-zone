import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { isPracticeRole } from "../account-factory/practice-roles.js";
import {
  prepare, submit, status, verifyProvisionedAccount, loadProposal, writePrivateJson,
  verifyAdministrator, type AccountEnvironment, type Intake,
} from "../account-factory/flow.js";

const HELP = [
  "Sovereign ALZ Builder — provision DEV, QA, STAGING or PROD through your existing Control Tower",
  "alz account-factory inspect PROFILE",
  "alz account-factory prepare PROFILE PRACTICE_ROLE DEV|QA|STAGING|PROD NAME EMAIL OWNER_EMAIL FIRST LAST OUTPUT.json",
  "alz account-factory submit PROFILE PROPOSAL.json RECEIPT.json",
  "alz account-factory status PROFILE RECORD_ID",
  "alz account-factory verify PROFILE ACCOUNT_NAME ACCOUNT_EMAIL",
  "AWS credentials and permissions come from the named, signed-in AWS SSO profile, not the model.",
  "Each account is its own member account under the discovered management account and configured OU.",
  "The final submission asks for one clear confirmation; no extra internal finance gate.",
  "Set ALZ_ACCOUNT_FACTORY_REGION and ALZ_ACCOUNT_FACTORY_OU to select another Control Tower region/OU.",
  "Infrastructure workload ACT remains DISABLED.",
].join("\n");

function isEnvironment(value: unknown): value is AccountEnvironment {
  return value === "DEV" || value === "QA" || value === "STAGING" || value === "PROD";
}

export async function run(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "inspect" && rest.length === 1) {
    const identity = await verifyAdministrator(rest[0]!);
    console.log(JSON.stringify({
      status: "AWS_ROLE_ACTIVE", identity,
      region: process.env.ALZ_ACCOUNT_FACTORY_REGION ?? "us-east-2",
      infrastructureAct: "DISABLED",
    }, null, 2));
    return;
  }
  if (action === "prepare" && rest.length === 9) {
    const [profile, practiceRole, environment, name, email, ownerEmail, ownerFirst, ownerLast, path] = rest;
    if (!isPracticeRole(practiceRole)) throw Error("PRACTICE_ROLE_INVALID");
    if (!isEnvironment(environment)) throw Error("ENVIRONMENT_INVALID");
    const intake: Intake = {
      profile: profile!, practiceRole, environment, name: name!, email: email!,
      ownerEmail: ownerEmail!, ownerFirst: ownerFirst!, ownerLast: ownerLast!,
    };
    const proposal = await prepare(intake);
    writePrivateJson(path!, proposal);
    console.log(JSON.stringify({
      status: proposal.status, file: path, hash: proposal.proposalHash,
      environment: proposal.environment, accountName: proposal.accountName,
      accountEmail: proposal.accountEmail, organization: proposal.orgId,
      managementAccount: proposal.managementAccount, region: proposal.region,
      ou: proposal.ouName + " (" + proposal.ouId + ")",
      landingZone: proposal.landingZoneArn, role: proposal.requesterPracticeRole,
      next: "Review this plan, then submit once from your own AWS SSO session.",
      infrastructureAct: "DISABLED",
    }, null, 2));
    return;
  }
  if (action === "submit" && rest.length === 3) {
    if (!stdin.isTTY || !stdout.isTTY) throw Error("INTERACTIVE_TERMINAL_REQUIRED");
    const [profile, path, receiptPath] = rest;
    const proposal = loadProposal(path!);
    console.log("REVIEW ACCOUNT FACTORY REQUEST");
    console.log(JSON.stringify({
      environment: proposal.environment, name: proposal.accountName,
      email: proposal.accountEmail, administrator: proposal.owner.email,
      organization: proposal.orgId, managementAccount: proposal.managementAccount,
      managementRole: proposal.identity.Arn, landingZone: proposal.landingZoneArn,
      ou: proposal.ouName + " (" + proposal.ouId + ")",
      region: proposal.region, practiceRole: proposal.requesterPracticeRole,
      note: "A new AWS account may incur charges; account creation is a real cloud action.",
      infrastructureAct: "DISABLED",
    }, null, 2));
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const exact = "CREATE " + proposal.environment + " " + proposal.accountName;
      if ((await prompt.question("To submit this exact account request, type " + exact + ": ")) !== exact)
        throw Error("ACCOUNT_CREATION_NOT_CONFIRMED");
    } finally { prompt.close(); }
    // Exclusive intent is the crash/retry lock. Do not silently retry a network timeout.
    writePrivateJson(receiptPath! + ".intent", {
      proposalHash: proposal.proposalHash, createdAt: new Date().toISOString(),
      status: "REQUEST_STARTED", note: "Inspect Service Catalog before attempting to resubmit.",
    });
    const result = await submit(proposal, profile!);
    writePrivateJson(receiptPath!, result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "verify" && rest.length === 3) {
    console.log(JSON.stringify(await verifyProvisionedAccount(rest[0]!, rest[1]!, rest[2]!), null, 2));
    return;
  }
  if (action === "status" && rest.length === 2) {
    console.log(JSON.stringify(await status(rest[0]!, rest[1]!), null, 2));
    return;
  }
  console.log(HELP);
  if (!args.includes("--help")) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ?
      error.message : "ACCOUNT_FACTORY_OPERATION_FAILED";
    console.error("ACCOUNT_FACTORY_BLOCKED: " + code);
    console.error("If a submission may have started, inspect Service Catalog before retrying.");
    process.exitCode = 2;
  });
