import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRACTICE_ROLES } from "../account-factory/practice-roles.js";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { isPracticeRole } from "../account-factory/practice-roles.js";
import {
  prepare, submit, follow, status, verifyProvisionedAccount, loadProposal, writePrivateJson,
  verifyAdministrator, type AccountEnvironment, type Intake,
  type AccountProposal, type Submission,
} from "../account-factory/flow.js";

const HELP = [
  "Sovereign ALZ Builder — provision DEV, QA, STAGING or PROD through your existing Control Tower",
  "alz account-factory inspect PROFILE",
  "alz account-factory create PROFILE  (guided end-to-end account request)",
  "alz account-factory prepare PROFILE PRACTICE_ROLE DEV|QA|STAGING|PROD NAME EMAIL OWNER_EMAIL FIRST LAST OUTPUT.json",
  "alz account-factory submit PROFILE PROPOSAL.json RECEIPT.json",
  "alz account-factory status PROFILE RECORD_ID",
  "alz account-factory follow PROFILE PROPOSAL.json RECEIPT.json",
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
  if (action === "create" && rest.length === 1) {
    if (!stdin.isTTY || !stdout.isTTY) throw Error("INTERACTIVE_TERMINAL_REQUIRED");
    const profile = rest[0]!;
    const identity = await verifyAdministrator(profile);
    console.log("New AWS account via the existing Control Tower Account Factory");
    console.log("Signed in as " + identity.Arn + " (management account " + identity.Account + ")");
    console.log("A new account may incur AWS charges. No workload infrastructure is deployed.");
    const prompt = createInterface({ input: stdin, output: stdout });
    const required = async (label: string) => {
      const response = (await prompt.question(label + ": ")).trim();
      if (!response) throw Error("REQUIRED_FIELD_MISSING");
      return response;
    };
    try {
      console.log("Practice: " + PRACTICE_ROLES.map((role, i) =>
        String(i + 1) + "=" + role.label).join(", "));
      const choice = (await prompt.question("Practice [2]: ")).trim() || "2";
      const selectedRole = PRACTICE_ROLES[Number(choice) - 1];
      if (!selectedRole) throw Error("PRACTICE_ROLE_INVALID");
      const environmentRaw = ((await prompt.question("Environment DEV/QA/STAGING/PROD [DEV]: ")).trim() || "DEV").toUpperCase();
      if (!isEnvironment(environmentRaw)) throw Error("ENVIRONMENT_INVALID");
      const name = await required("New member account name, e.g. ALZ-" + environmentRaw + "-01");
      const email = await required("Unique AWS account email");
      const ownerEmail = await required("Account administrator email");
      const ownerFirst = await required("Administrator first name");
      const ownerLast = await required("Administrator last name");
      const intake: Intake = {
        profile, practiceRole: selectedRole.id, environment: environmentRaw,
        name, email, ownerEmail, ownerFirst, ownerLast,
      };
      console.log("Discovering existing organization, landing zone, OU and Account Factory...");
      const proposal = await prepare(intake);
      console.log(JSON.stringify({
        environment: proposal.environment, accountName: proposal.accountName,
        accountEmail: proposal.accountEmail, organizationId: proposal.orgId,
        managementAccount: proposal.managementAccount, region: proposal.region,
        targetOu: proposal.ouName + " (" + proposal.ouId + ")",
        landingZone: proposal.landingZoneArn, ssoAdmin: proposal.owner.email,
        practice: selectedRole.label, proposalHash: proposal.proposalHash,
        note: "This creates a real AWS account, not a preview.",
      }, null, 2));
      const confirmation = "CREATE " + proposal.environment + " " + proposal.accountName;
      if ((await prompt.question("Confirm by typing " + confirmation + ": ")) !== confirmation)
        throw Error("ACCOUNT_CREATION_NOT_CONFIRMED");
      const base = join(".runs", "account-factory", "request-" + randomUUID());
      writePrivateJson(base + ".proposal.json", proposal);
      writePrivateJson(base + ".intent.json", {
        proposalHash: proposal.proposalHash, createdAt: new Date().toISOString(),
        status: "REQUEST_STARTED", note: "Before retrying, inspect Service Catalog.",
      });
      const record = await submit(proposal, profile);
      writePrivateJson(base + ".receipt.json", record);
      console.log(JSON.stringify({
        status: "SUBMITTED", environment: proposal.environment,
        recordId: record.recordId, proposalPath: base + ".proposal.json",
        receiptPath: base + ".receipt.json",
        next: "./alz account-factory status " + profile + " " + record.recordId,
        verification: "./alz account-factory verify " + profile + " " +
          proposal.accountName + " " + proposal.accountEmail,
      }, null, 2));
      console.log("Tracking the Service Catalog request and reading back the member account...");
      const tracked = await follow(profile, proposal, record, undefined, {
        maxPolls: 20, intervalMs: 15_000,
      });
      writePrivateJson(base + ".tracking.json", tracked);
      console.log(JSON.stringify(tracked, null, 2));
      if (tracked.status !== "MEMBER_ACCOUNT_VERIFIED")
        console.log("Account provisioning is still underway. Resume with: ./alz account-factory follow " +
          profile + " " + base + ".proposal.json " + base + ".receipt.json");
    } finally { prompt.close(); }
    return;
  }
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
  if (action === "follow" && rest.length === 3) {
    const [profile, proposalFile, receiptFile] = rest;
    const proposal = JSON.parse(readFileSync(proposalFile!, "utf8")) as AccountProposal;
    const receipt = JSON.parse(readFileSync(receiptFile!, "utf8")) as Submission;
    const result = await follow(profile!, proposal, receipt);
    writePrivateJson(receiptFile! + ".tracking-" + randomUUID() + ".json", result);
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
