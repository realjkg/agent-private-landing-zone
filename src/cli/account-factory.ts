import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  prepare, submit, status, loadProposal, writePrivateJson, verifyAdministrator,
  type Intake, MANAGEMENT_ACCOUNT,
} from "../account-factory/flow.js";

const HELP = [
  "Sovereign ALZ Account Factory — explicitly authorized administrative workflow",
  "alz account-factory inspect PROFILE",
  "alz account-factory prepare PROFILE ACCOUNT_NAME ACCOUNT_EMAIL OWNER_EMAIL OWNER_FIRST OWNER_LAST OUTPUT.json",
  "alz account-factory submit PROFILE PROPOSAL.json SUBMISSION.json",
  "alz account-factory status PROFILE RECORD_ID",
  "The console's operation catalog offers a guided handoff. These are owner-run commands.",
  "ProvisionProduct is a governance account-vending mutation; workload ACT remains DISABLED.",
].join("\n");

export async function run(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "inspect" && rest.length === 1) {
    const identity = await verifyAdministrator(rest[0]!);
    console.log(JSON.stringify({ status: "AUTHORIZED_ADMIN_SESSION", identity,
      account: MANAGEMENT_ACCOUNT, infrastructureAct: "DISABLED" }, null, 2));
    return;
  }
  if (action === "prepare" && rest.length === 7) {
    const [profile, name, email, ownerEmail, ownerFirst, ownerLast, path] = rest;
    const intake: Intake = { profile: profile!, name: name!, email: email!,
      ownerEmail: ownerEmail!, ownerFirst: ownerFirst!, ownerLast: ownerLast! };
    const proposal = await prepare(intake);
    writePrivateJson(path!, proposal);
    console.log(JSON.stringify({
      status: proposal.status, proposalFile: path, proposalHash: proposal.proposalHash,
      accountName: proposal.accountName, ouId: proposal.ouId, productId: proposal.productId,
      pilotCeilingUsd: 80, financialEvidence: "UNVERIFIED",
      infrastructureAct: "DISABLED", next: "Submit requires operator/finance authorization",
    }, null, 2));
    return;
  }
  if (action === "submit" && rest.length === 3) {
    if (!stdin.isTTY || !stdout.isTTY) throw Error("INTERACTIVE_HUMAN_TERMINAL_REQUIRED");
    const [profile, path, receiptPath] = rest;
    const proposal = loadProposal(path!);
    // Never allow a model, unattended job, CI, connector or injected stdin to grant authority.
    console.log("ACCOUNT FACTORY OWNER REVIEW");
    console.log(JSON.stringify({
      proposalHash: proposal.proposalHash, account: proposal.accountName,
      accountEmail: proposal.accountEmail, owner: proposal.owner.email,
      targetOU: proposal.ouId, principal: proposal.identity.Arn, region: proposal.region,
      pilotCeilingUsd: proposal.pilotCeilingUsd,
      financialEvidence: proposal.financialEvidence, runtimeAct: proposal.infrastructureAct,
    }, null, 2));
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const consent = await prompt.question(
        "Confirm that you separately verified billing/credits and authorized possible AWS charges (type AUTHORIZE ACCOUNT COST): ");
      if (consent !== "AUTHORIZE ACCOUNT COST") throw Error("FINANCIAL_APPROVAL_NOT_GRANTED");
      const exact = await prompt.question("Type the full proposal SHA-256 to authorize exactly this account: ");
      if (exact !== proposal.proposalHash) throw Error("REQUEST_HASH_NOT_APPROVED");
      const phrase = await prompt.question("Type CREATE " + proposal.accountName + " to submit one Account Factory request: ");
      if (phrase !== "CREATE " + proposal.accountName) throw Error("ACCOUNT_FACTORY_EXECUTION_NOT_AUTHORIZED");
    } finally { prompt.close(); }
    // Write an intent marker before external execution; never retry blindly.
    writePrivateJson(receiptPath! + ".intent", {
      proposalHash: proposal.proposalHash, at: new Date().toISOString(),
      status: "SUBMISSION_INTENT_RECORDED", note: "Check Service Catalog before any retry",
    });
    const result = await submit(proposal, profile!, proposal.proposalHash, true);
    writePrivateJson(receiptPath!, result);
    console.log(JSON.stringify(result, null, 2));
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
  run(process.argv.slice(2)).catch((error) => {
    // Don't copy AWS CLI stderr or provider payloads to the operator console.
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ?
      error.message : "ACCOUNT_FACTORY_OPERATION_FAILED";
    console.error("ACCOUNT_FACTORY_BLOCKED: " + code);
    console.error("No workload ACT was invoked. On submission errors inspect Service Catalog before retry.");
    process.exitCode = 2;
  });
