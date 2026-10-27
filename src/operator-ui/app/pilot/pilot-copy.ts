import type { ChangeCounts, PhraseKind, PilotEnvironment, PlanChange, PreflightCheck, RunResult } from "./pilot-api.js";

// Every sentence the pilot wizard shows, in one place, in plain U.S. English for a person who is not an engineer.
// Rules this file keeps (test/pilot-wizard.test.tsx enforces them):
//   - primary text never uses internal terms (see JARGON in that test); a code appears only inside a "Details" disclosure;
//   - every way the wizard can be stopped says why and says what to do next;
//   - every confirmation says what it will do in one sentence and asks for ONE exact phrase.
// The same words are used in docs/act-pilot-walkthrough.md.

export const STEP_TITLES = ["Choose a path", "Check readiness", "Prepare the change", "Review and approve", "Apply", "Results", "Check and clean up"] as const;
export const APPROVER_STEPS: readonly number[] = [1, 4];

export const COPY = {
  heading: "Pilot apply",
  intro: "This guided path takes one reviewed change from preparation to approval to a real change in one environment. " +
    "Every step tells you what it will do, and anything that changes real systems asks you to type an exact phrase first.",
  safetyLine: "Nothing happens without a person: you type each phrase yourself, nothing is filled in for you, and agents can never start this.",
  unlockTitle: "Unlock the wizard",
  unlockWhy: "The wizard only works for the person who started this console. When the console started, it printed a one-time session token in the terminal window where you launched it. It is not shown on this page, and it changes every time the console starts.",
  unlockLabel: "Session token from your terminal",
  unlockExample: "A long string of letters and numbers, printed after \"Pilot apply session token\".",
  unlockButton: "Unlock",
  unlockWrong: "That token was not accepted. Copy the token again from the terminal window where you started the console. If you restarted the console, use the new token it printed.",
  unlockChecking: "Checking the token...",
  roleLegend: "What is your part in this change?",
  roleOperator: "I am the operator. I prepare the change, collect approvals, and apply it.",
  roleApprover: "I am an approver. I only review what will change and sign my approval.",
  pathLegend: "How will this change be run?",
  pathUi: "In this web console, with this wizard.",
  pathCli: "On the command line, in a terminal.",
  pathRule: "Pick one. Everything for this change, including the approvals, then has to happen the same way. The two ways can never be mixed, and a change started one way is refused by the other.",
  pathContinue: "Continue",
  pathLocked: "This change is set to run in the web console. To use the command line instead, start over.",
  pathLockedCli: "This change is set to run on the command line, so the buttons in this wizard are switched off.",
  startOver: "Start over",
  startOverWhy: "Starting over clears the choice on this page so you can begin a new change. It does not undo anything that was already applied.",
  cliTitle: "Run these commands in your terminal, in this order",
  cliNote: "These are the exact commands. They are shown here to read and copy only. The buttons in this wizard stay off for this change.",
  cliWho: "Operator runs 1, 2, 3 and 5. Each approver runs 4 on their own computer with their own key.",
  readyTitle: "Check readiness",
  readyWhy: "This looks at this computer without changing anything: the pilot rules, the separate sign-ins, the tools and the emergency stop.",
  readyEnvironment: "Which environment are you preparing?",
  readyRun: "Run the readiness check",
  readyRerun: "Check again",
  readyRunning: "Checking...",
  readyAllGreen: "Everything needed on this computer is ready.",
  readySomeRed: "Some items are not ready. Fix each red item, then check again.",
  stateReady: "Ready",
  stateMissing: "Missing",
  stateInvalid: "Needs correcting",
  stateUnverified: "Not yet proven",
  stateUnavailable: "Not available here",
  stateBlocked: "Stopped on purpose",
  whoFixes: "Who can fix it:",
  partyOwner: "the pilot owner",
  partyOperator: "you, on this computer",
  partyTool: "installing the missing tool (./alz deps)",
  resume: "I already prepared a change: go to Review and approve",
  resumeWhy: "Use this if you reloaded the page or came back later. You will enter the locations of the files from your earlier work.",
  signing: "Working. Keep this page open.",
  readyContinue: "Continue to prepare the change",
  prepareWhy: "Start from your project folder. The console reads the owner's pilot rules and your project, and writes the two files the preview needs. It runs nothing and changes nothing.",
  prepareProjectLabel: "Project folder",
  prepareProjectHelp: "The folder that holds the project to deploy, for example your Terraform folder or the cdk.out folder.",
  egProject: "/home/you/pilot/landing-zone",
  prepareToolVersionLabel: "AWS CLI version on this computer",
  prepareToolVersionHelp: "Run aws --version in a terminal and enter the three numbers it shows.",
  egToolVersion: "2.27.10",
  prepareRun: "Get the files ready",
  prepareRunning: "Reading the project. This takes a few seconds.",
  prepareDone: "The files are ready, and the boxes below are filled in.",
  prepareLocalOnly: "These files were made on this computer only. They are not proof that anything works in the cloud.",
  prepareNextSeal: "Next: make the preview with the button below.",
  prepareNextCheck: "Next: before the first preview, a person runs the one-time DEV check in a terminal with the owner (see the walkthrough, \"Before your first change\"). Then come back and make the preview.",
  prepareNextOwner: "Next: the owner has to finish the DEV check first. You cannot do this from here.",
  prepareAdvanced: "Advanced: the saved files and their raw contents",
  prepareInputsLabel: "Settings it uses",
  prepareInputsNone: "none",
  prepareFromDefault: "its default in",
  prepareFromFile: "the file",
  prepareFromEnvironment: "the setting",
  prepareOr: "Or use files you already have",
  prepareThen: "Then make the preview",
  sealTitle: "Prepare the change",
  sealWhy: "Preparing makes a preview of exactly what would change and keeps it locked. It changes nothing yet.",
  sealRequestLabel: "Request file",
  sealRequestHelp: "The file that names the environment, the place to change and the project folder.",
  egRequest: "/home/you/pilot/request-dev.json",
  sealManifestLabel: "Project fingerprint file",
  sealManifestHelp: "The file that fingerprints the project so it cannot change after you prepare it.",
  egManifest: "/home/you/pilot/project-fingerprint.json",
  sealRequesterLabel: "Your requester name",
  sealRequesterHelp: "The name the owner listed for you. It becomes part of the change ID that every approver signs. In production, the person who requests a change cannot also approve it.",
  egRequester: "carol",
  sealKeyLabel: "Your requester key file",
  sealKeyHelp: "Your private key file on this computer, the same kind an approver uses. It signs this request; it is never uploaded or shown and must be readable only by you.",
  reviewRequestedBy: "Requested by",
  sealRun: "Prepare the change",
  sealRunning: "Preparing the change. This can take a few minutes; keep this page open.",
  sealDone: "The change is prepared.",
  sealKeep: "Note these two file locations. You need them if you come back later or reload this page.",
  sealNext: "Next, look at what will change and collect approvals.",
  reviewTitle: "Review and approve",
  reviewWhy: "Approvers read the plain list of what will change, then each signs for exactly this change. You only see names and kinds of things, never secret values.",
  reviewOperatorShare: "Send this review file to each approver. It holds no secrets, so any normal way of sending a file is fine.",
  reviewOperatorAsk: "Ask each approver to open the console on their own computer, choose \"I am an approver\", and sign. They send you back an approval file.",
  reviewNeeded: "How many approvals are needed: DEV and QA need at least one. PROD needs two different people. The owner's pilot rules can require more.",
  reviewApprovalsLabel: "Approval files (one location per line)",
  reviewApprovalsHelp: "One file per approver, as they sent it back to you.",
  egApproval: "/home/you/approvals/alice.json",
  reviewContinue: "Continue to apply",
  reviewDestructive: "Some things will be deleted or replaced. Approvers must have read these lines before signing.",
  approverBundleLabel: "Review file",
  approverBundleHelp: "The file the operator sent you.",
  egBundle: "/home/you/review/change-dev.review.json",
  approverLoad: "Show what will change",
  approverKeyLabel: "Your key file",
  approverKeyHelp: "Your private key file on this computer. It must be readable only by you. It is never uploaded or shown.",
  egKey: "/home/you/.keys/approver.pem",
  approverNameLabel: "Your approver name",
  approverNameHelp: "The name the owner listed for you.",
  egName: "alice",
  approverSign: "Sign my approval",
  approverSigned: "Your approval is signed and saved.",
  approverSendBack: "Send this file back to the operator. It holds no secrets.",
  applyTitle: "Apply",
  applyWhy: "This changes real systems. It uses the approvals you collected and can be done once for this change.",
  applySealedLabel: "Prepared change file",
  applySealedHelp: "Filled in from the preparation step.",
  egSealed: "/home/you/.runs/apply/sealed-plan-1234.json",
  applyRun: "Apply this change...",
  applyRunning: "Applying. Do not close this page or stop the console until it says it is done.",
  resultsTitle: "Results",
  detailsLabel: "Details",
  detailsWhy: "For the person helping you:",
  copy: "Copy",
  copied: "Copied.",
  copyFailed: "Could not copy. Select the text and copy it yourself.",
  supportNote: "Copy a note for the pilot owner",
  newChange: "Start a new change",
  tryAgain: "Go back and try again",
  back: "Back",
  next: "Next",
  sessionLost: "This page lost contact with the console. Close it and start the console again.",
  working: "Working...",
  noChanges: "No changes in this list.",
  reviewUnitLabel: "Cleanup marker on everything this change creates",
  reviewUnitWhat: "The console checked the preview: every created thing that can carry labels carries exactly these, so a later check can find everything this change made, even outside its records.",
  reviewUnitNone: "This build tool cannot stamp a cleanup marker. A later check can only confirm things by name.",
  reviewUnitUntagged: "These created things cannot carry labels and are tracked through the change's records only:",
  reviewToolLabel: "Build tool that made this preview",
  reviewToolVersion: "version",
  reviewToolProgram: "program ID",
  reviewTestedLabel: "Tested on the real cloud",
  reviewTestedYes: "Yes. This exact program passed the real-cloud test on",
  reviewTestedNo: "No. This exact program has not passed the real-cloud test for this place, so approvers are signing a preview from an untested program. The change can still only run with this same program.",
  omitted: "more lines are in the review file and are not shown here.",
  // Step 7: check what was created, propose and approve its removal, remove it, and check that it is gone.
  cleanupTitle: "Check and clean up",
  cleanupWhy: "First the console looks at the cloud, on its own and without the build tool, to see that each thing the change made is really there. " +
    "Then it writes down exactly which of them this change created and may be removed. Approvers sign that list, you remove exactly those things, and the console looks again to confirm they are gone.",
  cleanupSafety: "Nothing is removed without a signed approval of the exact list, and a list signed for a change never counts as a cleanup approval. Looking at the cloud changes nothing, so you can do it as often as you like.",
  cleanupSealedLabel: "Prepared change file",
  cleanupSealedHelp: "The locked change this cleanup belongs to. Filled in from the earlier steps when you did them in this session.",
  observeRun: "Look at what was created",
  observeRerun: "Look again",
  observeRunning: "Looking at the cloud. This reads and changes nothing.",
  observeDone: "The console looked at each thing the change left behind.",
  observeSynthetic: "These results come from this computer's own checks. They are not a record of a live account until the pilot owner records one.",
  observeVerdictGood: "Everything that could be checked is there.",
  observeVerdictPartial: "Everything that can be checked on its own is there. Some settings can only be judged through the thing they belong to, or this change carries no cleanup marker, so nothing outside its records was searched for.",
  observeVerdictBad: "Something is missing or unexpected. Do not propose a cleanup until the pilot owner has looked.",
  observeVerdictUnsure: "Some things could not be checked yet. Look again in a moment, or fix the reason shown.",
  observeColumns: "For each thing: its name in the project, its kind, its identifier in the cloud, where it came from, and what the check found.",
  proposeRun: "Write the cleanup proposal",
  proposeRunning: "Working out exactly what this change created.",
  proposeDone: "The cleanup proposal is written. Nothing is removed until it is approved and run.",
  proposeKeep: "Note this file location. Approvers need it, and so does the removal step.",
  proposeDeletes: "To be removed",
  proposeDeletesNone: "Nothing: everything this change created is already gone.",
  proposeAbsent: "Already gone",
  proposeKept: "Kept",
  proposeRisks: "Before anyone approves, read these",
  proposeApprovalsNeeded: "Approvals needed for this cleanup",
  proposeRequestedBy: "Cleanup requested by",
  proposeRequesterLabel: "Your requester name",
  proposeRequesterHelp: "The name the owner listed for you. It becomes part of the proposal ID that every approver signs. In production, the person who requests a cleanup cannot also approve it, and two other people must approve.",
  proposeKeyLabel: "Your requester key file",
  proposeKeyHelp: "Your private key file on this computer, the same kind an approver uses. It signs this cleanup request; it is never uploaded or shown and must be readable only by you.",
  proposeSend: "Send the proposal file to each approver. It holds names and identifiers only, no secrets.",
  proposeAsk: "Ask each approver to open the console on their own computer, choose \"I am an approver\" and \"A cleanup\", and sign. They send you back an approval file.",
  cleanupApprovalsLabel: "Cleanup approval files (one location per line)",
  cleanupApprovalsHelp: "One file per approver, as they sent it back to you for this cleanup. Approval files for the change itself are refused here.",
  egCleanupApproval: "/home/you/approvals/cleanup-alice.json",
  cleanupProposalLabel: "Cleanup proposal file",
  cleanupProposalHelp: "The file the console wrote when you wrote the proposal, or the one the operator sent you.",
  egProposal: "/home/you/.runs/apply/cleanup/0123456789ab.cleanup-proposal.json",
  cleanupNeedsApplyFiles: "The request and project fingerprint files from the earlier steps are needed too; enter them in the Apply step if you reloaded the page.",
  cleanupNeedsSealed: "The prepared change file above is needed too: the console checks the list against what that change really made before anything is removed.",
  cleanupRun: "Remove the listed things...",
  cleanupRunning: "Removing. Do not close this page or stop the console until it says it is done.",
  cleanupDoneGood: "The removal finished. Now check that everything is gone.",
  verifyRun: "Check that everything is gone",
  verifyRerun: "Check again",
  verifyRunning: "Looking at the cloud for anything left. This reads and changes nothing.",
  verifyKeptNotChecked: "Kept items were left in place and were not checked.",
  verifyRetirementTail: "Retiring the environment itself is a separate, reviewed action by the pilot owner, and it is still outstanding.",
  proposeWillDelete: "If approved, everything on the delete list above will be deleted, and nothing else.",
  verifyIncomplete: "Not finished yet. Nothing is reported as complete until every listed thing is confirmed gone.",
  verifyKnownConfirmed: "Everything on the list is confirmed gone, but this change carried no cleanup marker, so nothing outside its records could be searched for. This is not complete.",
  verifyNextLabel: "What to do now:",
  verifyNotSearched: "Things outside the project's own records were not searched for, because this change does not label what it makes.",
  approverSigningLegend: "What are you signing?",
  approverSignsChange: "A change (the operator sent me a review file).",
  approverSignsCleanup: "A cleanup (the operator sent me a cleanup proposal file).",
  approverLoadCleanup: "Show what will be removed",
  approverSignCleanup: "Sign my cleanup approval",
  cleanupReconnect: "If you reloaded the page, enter the file locations again. Looking and checking can be repeated safely; a removal already done is never done twice.",
  nextCleanup: "Next: check and clean up",
} as const;

/** Where a thing in the state came from, in words. */
export function ownershipWord(ownership: string): string {
  switch (ownership) {
    case "RUN_CREATED": return "created by this change";
    case "PRE_EXISTING": return "existed before this change";
    case "REPLACED_PRE_EXISTING": return "replaced something that existed before";
    case "IMPORTED": return "brought under management, not created";
    case "NOT_IN_PLAN": return "not part of this change";
    case "TYPE_UNREVIEWED": return "created by this change, but of a kind not yet reviewed as safe to remove alone (or a setting on something that stays), so it is left for you to remove or keep by hand";
    case "PROTECTED_BACKEND": return "the storage the pilot itself runs on";
    case "PROTECTED_IDENTITY": return "an identity or access object (a role, a role or policy assignment, a role or policy definition, a managed identity, a sign-in trust, an exemption or a lock)";
    case "PROTECTED_DEPLOYMENT": return "deployment history";
    case "RETAINED_GROUP": return "a resource group, kept whole (a pilot cleanup removes only approved things inside it)";
    case "CONTAINS_OTHERS": return "a container that holds or serves other things (a subscription, management group or provider registration, or a deployment that creates a whole set of other resources)";
    default: return "unknown";
  }
}
/** Who keeps a thing the cleanup leaves, in words. */
export function retentionOwnerWord(owner: string): string {
  switch (owner) {
    case "PILOT_OWNER": return "kept by the pilot owner";
    case "ENVIRONMENT_OWNER": return "kept by the environment's owner";
    default: return "kept by an unknown owner";
  }
}
/** Why a check could not decide, in words: the record's reason code, never shown raw. */
export function reasonWord(reason: string): string {
  switch (reason) {
    case "ACCESS_DENIED": return "the discovery sign-in was not allowed to read it";
    case "CREDENTIALS": return "the discovery sign-in could not sign in";
    case "THROTTLED": return "the cloud asked us to slow down; check again later";
    case "TYPE_NOT_SUPPORTED": return "the cloud's read service does not know this kind of thing";
    case "CLI_ERROR": case "HTTP_ERROR": case "UNEXPECTED_RESPONSE": return "the read failed or answered in an unexpected way";
    case "CLI_NOT_RUN": case "HOST_REFUSED": case "READER_CLOSED": return "the read could not be sent";
    case "NOT_INDEPENDENTLY_CHECKABLE": case "NO_CLOUD_CONTROL_MAPPING": return "it cannot be checked on its own; only the thing it belongs to can be";
    case "DATA_BEARING_READ_EXCLUDED": return "reading it would return its data or secret contents, which discovery never reads, so its deletion cannot be confirmed here";
    case "NO_IDENTIFIER_IN_STATE": return "the project's records hold no identifier for it";
    case "NOT_AN_ARM_RESOURCE_ID": return "its identifier is not one the cloud can be asked about";
    case "OUTSIDE_TARGET_SUBSCRIPTION": return "it is outside the subscription this pilot works in";
    default: return "the check gave no usable answer";
  }
}

/** The distinct ownership classes present in a kept list, each in words with who keeps it, in list order. */
function keptClassWords(kept: readonly { ownership: string; retainedBy: string }[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const item of kept) {
    const key = item.ownership + "|" + item.retainedBy;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(ownershipWord(item.ownership) + " (" + retentionOwnerWord(item.retainedBy) + ")");
  }
  return words;
}
/**
 * The note under a cleanup proposal, built from this proposal's own lists: what the delete list will do if approved, and which
 * kinds of thing this proposal keeps, with their owner. It promises nothing about kinds that are not in the records.
 */
export function retainedNoteFor(cleanup: { deletes: readonly unknown[]; excluded: readonly { ownership: string; retainedBy: string }[] }): string {
  const head = cleanup.deletes.length === 0 ? "Nothing is on the delete list, so an approval would delete nothing." : COPY.proposeWillDelete;
  const kept = keptClassWords(cleanup.excluded);
  const tail = kept.length === 0 ? "Nothing else from this change's records is kept." : "Kept, and never on that list: " + kept.join("; ") + ".";
  return head + " " + tail + " Retiring the environment itself is a separate, reviewed decision for the pilot owner.";
}
/** A kept leftover row's ownership class, from the record's reason (`CLASS: sentence`), and its owner. */
const keptClassOf = (item: { reason?: string; owner?: string }): { ownership: string; retainedBy: string } => ({ ownership: /^([A-Z][A-Z_]+): /.exec(item.reason ?? "")?.[1] ?? "UNKNOWN", retainedBy: item.owner ?? "UNKNOWN" });
/**
 * The headline of a COMPLETE leftover check, from the record: how many listed things are confirmed gone, whether an approved
 * cleanup ran at all (a record with no cleanup evidence means none did), and that kept things were left in place and not checked.
 */
export function completeHeadlineFor(leftovers: { resources: readonly { disposition: string }[]; cleanupEvidenceSha256?: string | null }): string {
  const gone = leftovers.resources.filter((item) => item.disposition === "CONFIRMED_DELETED").length;
  const head = gone === 0 ? "Nothing was on the delete list, so nothing was deleted."
    : leftovers.cleanupEvidenceSha256 === null ? "No cleanup ran; the " + gone + " listed thing(s) are confirmed gone anyway."
    : "Approved things deleted: " + gone + " listed thing(s) confirmed gone.";
  return head + " " + COPY.verifyKeptNotChecked;
}
/** The retirement line of a COMPLETE leftover check: which kinds this record kept, with their owner, and that the environment is not retired. */
export function retirementOutstandingFor(leftovers: { resources: readonly { disposition: string; reason?: string; owner?: string }[] }): string {
  const kept = keptClassWords(leftovers.resources.filter((item) => item.disposition === "INTENTIONALLY_RETAINED").map(keptClassOf));
  const body = kept.length === 0 ? "Nothing from this change's records was kept." : "Kept and left in place, not checked: " + kept.join("; ") + ".";
  return "The environment itself is not retired. " + body + " " + COPY.verifyRetirementTail;
}
/** What the independent check found, in words. */
export function verificationWord(result: string): string {
  switch (result) {
    case "VERIFIED": return "Found as expected";
    case "DIFFERENT_FROM_DESIRED": return "Found, but different from what was planned";
    case "MISSING": return "Missing";
    case "NOT_YET_OBSERVABLE": return "Could not be checked yet";
    case "UNVERIFIABLE": return "Cannot be checked on its own";
    default: return "Unknown";
  }
}
/** What the leftover check found, in words. */
export function dispositionWord(disposition: string): string {
  switch (disposition) {
    case "CONFIRMED_DELETED": return "Confirmed gone";
    case "INTENTIONALLY_RETAINED": return "Kept on purpose";
    case "STILL_PRESENT": return "Still there";
    case "DELETION_PENDING": return "Removal pending";
    default: return "Unresolved: not confirmed gone";
  }
}
/** The origin words for a thing the check looked at. */
export const originWord = (origin: string): string => origin === "IN_PLAN" ? "named by this change" : "not named by this change";

/** The commands for the cleanup half of the command-line path, in order; shown after the apply commands. */
export const CLEANUP_CLI_COMMANDS: readonly { who: string; what: string; command: string }[] = [
  { who: "Operator", what: "Look at what the change created", command: "./alz apply observe --sealed LOCKED_CHANGE" },
  { who: "Operator (the cleanup requester)", what: "Write the cleanup proposal, signed with the requester's key", command: "./alz apply propose-cleanup --sealed LOCKED_CHANGE --requester NAME --key REQUESTER_KEY.pem" },
  { who: "Each approver (in production, two people other than the requester)", what: "Review and sign the cleanup (on their own computer)", command: "./alz apply approve --bundle PROPOSAL.json --key APPROVER_KEY.pem --approver NAME" },
  { who: "Operator", what: "Remove exactly the listed things", command: "./alz apply cleanup --proposal PROPOSAL.json --request REQUEST.json --manifest MANIFEST.json --sealed LOCKED_CHANGE --approval APPROVAL.json" },
  { who: "Anyone", what: "Check that everything is gone", command: "./alz apply verify-cleanup --proposal PROPOSAL.json" },
];

/** What a finished removal means to the person: the same four endings as an apply, in the cleanup's words. */
export const CLEANUP_RESULT_COPY: Readonly<Record<ResultKind, { headline: string; what: string; next: string[]; tone: "good" | "caution" | "stop" }>> = {
  APPLIED: { tone: "good", headline: "Removed", what: "The listed things were removed as approved, and the record of it was saved.", next: ["Check that everything is gone with the button below. Nothing is complete until that check says so."] },
  NOTHING_CHANGED: { tone: "caution", headline: "Nothing was removed", what: "The step stopped before anything was removed, and nothing was used up.", next: ["Read the reason below, fix it, and run the step again."] },
  APPROVALS_SPENT: { tone: "caution", headline: "Nothing was removed, but the approvals are used up", what: "The removal did not run. The cleanup approvals were already used, and they cannot be used again.", next: ["Fix the cause below.", "Ask each approver to sign the same proposal again, then run the removal."] },
  NEEDS_REVIEW: { tone: "stop", headline: "A person must review this before anything else", what: "Some listed things may be gone and others not. It is not safe to assume either way.", next: ["DO NOT RETRY. Check that everything is gone with the button below: it only looks.", "Call the pilot owner now and tell them the time, the environment, and that the cleanup needs a manual review.", "Do not write another proposal until the owner says it is safe."] },
};

// --- confirmation dialogs ---------------------------------------------------------------------------------------

export type DialogCopy = { title: string; consequence: string; inputLabel: string; cancel: string; confirm: string; jargonOk?: true };

export function dialogCopy(kind: PhraseKind, environment: PilotEnvironment | undefined): DialogCopy {
  const where = environment ?? "this environment";
  switch (kind) {
    case "TARGET":
      return {
        title: "Confirm where this will run",
        consequence: "You are about to prepare a preview against " + where + ". It changes nothing yet; typing the place exactly proves it is the one you mean.",
        inputLabel: "Type the place exactly as shown", cancel: "Cancel", confirm: "Confirm the place",
      };
    case "RUN_PROJECT_CODE":
      return {
        title: "Allow the project's own code to run",
        consequence: "Preparing the preview runs the project's own code on this computer, so only continue if you trust this project.",
        inputLabel: "Type the phrase exactly as shown", cancel: "Cancel", confirm: "Allow it to run",
      };
    case "EMBED_STATE_WRITE":
      return {
        title: "Extra confirmation: the storage sign-in",
        consequence: "The pilot rules ask the preparation step to carry the settings of the sign-in that is allowed to write the saved record of your infrastructure " +
          "(the rules file calls it STATE_WRITE). That means preparing the preview becomes able to write to that record, although it only reads, and the locked plan stays encrypted. " +
          "Whether the cloud really signs in as intended is not proven yet.",
        inputLabel: "Type the phrase exactly as shown", cancel: "Cancel", confirm: "Accept this and continue", jargonOk: true,
      };
    case "ATTEST":
      return {
        title: "Confirm what the cloud logs showed",
        consequence: "You are stating that the cloud's own logs show the sign-ins stayed separate in this run.",
        inputLabel: "Type the phrase exactly as shown", cancel: "Cancel", confirm: "Confirm",
      };
    case "APPROVE":
      return {
        title: "Sign your approval",
        consequence: "Your signature allows exactly this change to be applied to " + where + ". It is valid for a limited time and can be used once.",
        inputLabel: "Type the phrase exactly as shown", cancel: "Cancel", confirm: "Sign my approval",
      };
    case "APPROVE_CLEANUP":
      return {
        title: "Sign your approval of this cleanup",
        consequence: "You are signing for the removal of exactly the listed resources in " + where + ", and nothing else. Your signature works once and only for this list; an approval of a change never counts as an approval of a cleanup.",
        inputLabel: "Type the line exactly as shown", cancel: "Cancel", confirm: "Sign the cleanup approval",
      };
    case "CLEANUP":
      return {
        title: "Remove the listed resources from " + where,
        consequence: "This deletes real resources in " + where + ": exactly the ones on the approved list, and nothing else. There is no undo button here.",
        inputLabel: "Type the line exactly as shown", cancel: "Cancel", confirm: "Remove them now",
      };
    case "APPLY":
    default:
      return {
        title: "Apply this change to " + where,
        consequence: "This changes real systems in " + where + ", and there is no undo button here.",
        inputLabel: "Type the line exactly as shown", cancel: "Cancel", confirm: "Apply now",
      };
  }
}

/** What is wrong with what was typed so far, in words. Empty when it matches. Never reveals more than the phrase already on screen. */
export function describeMismatch(typed: string, phrase: string): string {
  if (typed === phrase) return "";
  if (typed === "") return "Nothing typed yet. Copy the phrase above, or type it exactly.";
  if (typed.trim() === phrase) return typed.startsWith(" ") || typed.startsWith("\t") ? "There is a space at the start. Remove it." : "There is a space at the end. Remove it.";
  if (typed.toLowerCase() === phrase.toLowerCase()) return "The letters match but not the capitals. It must match exactly, capitals included.";
  let index = 0;
  while (index < typed.length && index < phrase.length && typed[index] === phrase[index]) index += 1;
  if (index === typed.length) return "So far it matches. " + (phrase.length - typed.length) + " more characters to go.";
  return "Not a match yet: it first differs at character " + (index + 1) + ". Check that spot against the phrase above.";
}

// --- every way a step can end ------------------------------------------------------------------------------------

export type Reason = { why: string; next: string };

/** Plain words for every code a step can end with. A code the table lacks falls back to UNKNOWN_CODE, and a test fails first. */
export const CODE_COPY: Readonly<Record<string, Reason>> = {
  // The guided AWS connection uses the same plain-language refusal catalog.
  AWS_SETUP_INPUT_INVALID: { why: "The account number or saved connection name could not be accepted.", next: "Enter the dedicated DEV member account number and the name of an approved saved AWS connection." },
  AWS_ACCOUNT_NOT_VERIFIED: { why: "The DEV account, its enrollment, or its AWS connection could not be confirmed.", next: "Ask your AWS administrator to check the saved connection, Workloads enrollment and account status. Then check again." },
  // the driver's refusals
  ACT_DISABLED: { why: "The pilot is switched off. It only works while the owner's pilot rules are switched on and approved.", next: "Ask the pilot owner to switch on and approve the pilot rules. You cannot do this from here." },
  CONTRACT_INVALID: { why: "The pilot rules file has a mistake, or it was changed after the owner approved it.", next: "Ask the pilot owner to fix it and approve it again. Nothing was changed." },
  IDENTITY_TARGET_MISMATCH: { why: "One of the separate sign-ins points at a different account than the pilot rules name for this environment.", next: "Correct that sign-in's account in the terminal where you started the console, restart the console, then run the readiness check again." },
  KILL_SWITCH_ACTIVE: { why: "The emergency stop is on, so every change is blocked.", next: "Only the pilot owner turns it off. Ask them, and do not remove the stop file yourself." },
  KILL_SWITCH_AFTER_APPROVALS: { why: "The emergency stop was turned on just as the change was about to start. Nothing was changed, but the approvals were used up.", next: "Wait until the owner says the stop is off, then collect new approvals for the same prepared change." },
  HUMAN_INVOCATION_REQUIRED: { why: "A person has to start this step, and it could not be confirmed that one did.", next: "Start the step again from the wizard yourself." },
  LIVE_RECORD_UNAVAILABLE: { why: "There is no finished, successful change on record for this prepared change, so it cannot be recorded as live.", next: "Record it only after the change was applied and its result said it succeeded. Nothing was written." },
  LIVE_ATTESTATION_MISMATCH: { why: "What you typed did not match the phrase shown. Nothing was written.", next: "Type the phrase only if the change really ran against the real account, and use the Copy button so it is exact." },
  LIVE_RECORD_EXISTS: { why: "This change is already recorded as live. A record is never replaced.", next: "Use the record that is already there. Nothing was changed." },
  PREVIEW_ATTESTATION_MISMATCH: { why: "What you typed was neither the attestation phrase shown nor the word SYNTHETIC. Nothing was written.", next: "Type the phrase only if the preview really ran the approved, checked build tool against the real account; type SYNTHETIC to record a rehearsal or a test, which never passes the release check." },
  PREVIEW_EVIDENCE_EXISTS: { why: "Evidence for this release check and this prepared change is already written. It is never replaced.", next: "Use the evidence that is already there, or prepare and seal a new change to record again. Nothing was changed." },
  PREVIEW_EVIDENCE_LIVE: { why: "The preview evidence is recorded as live: every condition held and you attested the real account.", next: "Review the evidence file, keep it with the release candidate, and add the printed record to the release review's list. The release check closes only when that review accepts it." },
  PREVIEW_EVIDENCE_SYNTHETIC: { why: "The preview evidence is recorded as synthetic: at least one condition failed, or it was not attested. It never passes the release check.", next: "Read the reasons in the evidence. Seal the preview with the approved, checked build tool against the real account from the release commit, then record it again." },
  GATE_UNKNOWN: { why: "The release check named is not a preview check. Nothing was written.", next: "Use one of the preview checks listed in the release status." },
  SCENARIO_MISMATCH: { why: "The release check is about another cloud or build tool than this prepared change. Evidence of one never stands for another. Nothing was written.", next: "Record this change against its own release check, or seal a change of the kind the check is about." },
  RECOVERY_RECORD_UNAVAILABLE: { why: "One of the two prepared changes named has no finished run on record, so there is nothing recorded to make a recovery record from. Nothing was written.", next: "Name the prepared change whose run was interrupted and the later one that finished; both must have run and been recorded." },
  RECOVERY_NOT_INTERRUPTED: { why: "The first run named was not interrupted; it finished on its own. A recovery record is about a run that stopped part way and was reviewed from its records. Nothing was written.", next: "Name the prepared change whose run stopped part way as the first one." },
  RECOVERY_RESUME_MISMATCH: { why: "The later run named is not a fresh continuation of the interrupted one: it is the same prepared change, it ran against another account or environment, or it did not finish. Nothing was written.", next: "Name the new prepared change that was sealed, approved and finished after the interruption, for the same account and environment." },
  RECOVERY_APPROVAL_REUSED: { why: "The later run used an approval given before the interruption ended, or fewer approvals than required. A continuation after an interruption needs fresh approvals. Nothing was written.", next: "A recovery record cannot be made from these runs. Tell the pilot owner; a continuation must be approved anew." },
  RECOVERY_ATTESTATION_MISMATCH: { why: "What was typed is not the attestation shown. Nothing was written.", next: "Type the attestation exactly as shown, only if both runs reached the real account." },
  RECOVERY_RECORD_EXISTS: { why: "A recovery record for this interrupted change is already written. It is never overwritten.", next: "Review the existing record; keep it with the release candidate." },
  RECOVERY_EVIDENCE_RECORDED: { why: "The recovery record is written.", next: "Review it, keep it with the release candidate, and list it in the release admission file." },
  CONTRACT_MISMATCH: { why: "The prepared change was sealed under other pilot settings than the ones in force now. Nothing was written.", next: "Seal the change again under the current settings, then record it." },
  CHANGES_UNAUTHORIZED: { why: "The prepared change would remove or replace something, or holds a change the release check cannot review. A release check is about a preview that creates, updates or adopts only. Nothing was written.", next: "Ask the pilot owner to review that change on its own. Record a prepared change that only creates, updates or adopts." },
  SOURCE_UNVERIFIED: { why: "This copy of the app has changes that are not saved in its history, or its version cannot be read, so a record could not say which version ran. Nothing ran or was used up.", next: "Save (commit) or remove the local changes, or use the packaged app, then try again." },
  ENGINE_BINARY_CHANGED: { why: "The build tool program on this computer is not the one that made the preview the approvers signed. A change only runs with that exact program. Nothing was used up.", next: "Put the same build tool version back, or prepare the change again with this one and collect new approvals." },
  SOURCE_CHANGED: { why: "The app was updated after this change was prepared. A change only runs on the exact app version that prepared it. Nothing was used up.", next: "Run it from the app version shown on the review, or prepare the change again and collect new approvals." },
  CHANNEL_MISMATCH: { why: "This change was started the other way, on the command line or in the console, and has to be finished the same way. Nothing was used up.", next: "Finish it where it was started, or start a new change here." },
  TARGET_NOT_IN_CONTRACT: { why: "The place you named is not one the pilot rules allow, or the project points somewhere else.", next: "Check the account, storage and workspace in your request file against the pilot rules, or ask the owner. Nothing was changed." },
  ARTIFACT_INVALID: { why: "The prepared change, or one of the files it needs, is missing, damaged, or was prepared for something else.", next: "Go back to Prepare the change, make a new one, and collect new approvals." },
  ARTIFACT_TAMPERED: { why: "A file changed after it was prepared or approved, so it can no longer be trusted.", next: "Do not use these files. Prepare a new change and collect new approvals, and tell the pilot owner if you did not change anything yourself." },
  APPROVAL_INSUFFICIENT: { why: "There are not enough approvals. Production needs two different people.", next: "Collect the missing approvals from other approvers and add their files." },
  APPROVAL_UNVERIFIED: { why: "An approval file could not be checked as a real signature.", next: "Ask that approver to sign again with their own key." },
  APPROVER_NOT_ALLOWED: { why: "An approver is not on the owner's list for this environment.", next: "Ask someone who is on the list, or ask the owner to update the list." },
  APPROVAL_EXPIRED: { why: "An approval ran out of time.", next: "Ask the approver to sign again, then apply soon after." },
  APPROVAL_REPLAYED: { why: "An approval was already used once. Each one works one time only.", next: "Ask for a fresh approval." },
  APPROVAL_MISBOUND: { why: "An approval was signed for a different change, environment or place.", next: "Ask the approver to review this change and sign it again." },
  SAME_APPROVER_TWICE: { why: "The same approver was added twice. Two different people are needed.", next: "Add an approval from a second person." },
  APPROVER_IS_REQUESTER: { why: "This approval comes from the person who requested the change or the cleanup (their name or their key). In production the requester and the approvers must be different people.", next: "Ask another person on the owner's list to approve. In DEV and QA the requester may approve." },
  REQUESTER_NOT_ALLOWED: { why: "The requester name is not on the owner's list, so the request cannot be signed.", next: "Use a name the owner listed, or ask the owner to add you. Nothing ran." },
  REQUESTER_KEY_MISMATCH: { why: "The key file is not the key the owner listed for that requester name.", next: "Use your own key file, the one whose public half the owner listed for you. Nothing ran." },
  REQUESTER_SIGNATURE_MISSING: { why: "This prepared change or cleanup proposal carries no requester signature, so nobody is on record as having asked for it.", next: "Prepare the change, or write the cleanup proposal, again with your requester name and key file. Nothing was used up." },
  REQUESTER_SIGNATURE_UNVERIFIED: { why: "The requester signature on this prepared change or cleanup proposal could not be checked against the owner's list. A change's signature never counts for a cleanup, and a cleanup's never counts for a change.", next: "Prepare the change, or write the cleanup proposal, again with your own listed key. Nothing was used up." },
  REQUESTER_MISBOUND: { why: "The requester signature belongs to a different change, cleanup, environment or requester than this one.", next: "Prepare the change, or write the cleanup proposal, again; a signature is never moved. Nothing was used up." },
  ARTIFACT_ALREADY_APPLIED: { why: "This exact change was already applied, or an earlier try stopped part way. A change can only run once.", next: "Do not retry. If you need another change, prepare a new one. If an earlier try failed, the pilot owner must review it first." },
  ENGINE_NOT_QUALIFIED: { why: "The deployment tool has not passed its one-time check on this computer, or that check is out of date.", next: "A person runs the one-time check in a terminal against DEV (see the walkthrough, \"Before your first change\"), then try again. It is not done in this wizard." },
  PROMOTION_EVIDENCE_MISSING: { why: "This release has not succeeded in the earlier environment yet. QA needs DEV first, and production needs QA first.", next: "Finish the earlier environment with this same release, then come back." },
  IDENTITY_NOT_CONFIGURED: { why: "A required separate sign-in is missing, or one that should not be set is set.", next: "Set exactly the sign-ins the readiness check lists, restart the console, and check again." },
  IDENTITY_COLLAPSED: { why: "Two sign-ins are the same, or one could fall back to your own account.", next: "Give each sign-in its own details, remove any shared or personal ones, restart the console, and check again." },
  PLAN_STALE: { why: "The cloud changed after the preview was made, so the prepared change is out of date. Nothing was applied.", next: "Prepare a new preview and collect new approvals." },
  APPLY_FAILED: { why: "The change could not be started, or did not finish.", next: "Read the result before doing anything else. If it says a person must review, do not retry." },
  APPROVALS_SPENT: { why: "The change could not start after the approvals were used up. Nothing was changed.", next: "Fix the cause, for example free disk space, then collect new approvals for the same prepared change." },
  EVIDENCE_REJECTED: { why: "The record of the change could not be saved.", next: "Do not retry. Write down what happened and tell the pilot owner right away, because the change may have happened." },
  // observing and cleaning up
  RUN_RECORD_MISSING: { why: "The records this step needs are missing: the change has no finished result, or its list of created things could not be read when it ended, or it has not been looked at yet.", next: "Do the earlier step first (apply, then look at what was created). If the change itself ended badly, the pilot owner reviews it by hand." },
  OWNERSHIP_AMBIGUOUS: { why: "The console cannot tell for sure which things this change created, for example because the change did not finish cleanly or something it planned never got recorded.", next: "Do not clean up from here. Ask the pilot owner to review the records and the cloud by hand." },
  OBSERVATION_INCONCLUSIVE: { why: "The last look at the cloud could not decide about something this change created, or found something unexpected.", next: "Look at what was created again. If the same thing cannot be checked, fix the discovery sign-in's access, or ask the pilot owner." },
  PROPOSAL_INVALID: { why: "The cleanup proposal file is damaged, was edited after it was written, or belongs to another change, place or environment.", next: "Write the proposal again from this change and send the new file to the approvers." },
  PROPOSAL_SCOPE_MISMATCH: { why: "Removing the listed things would also touch something not on the list, or something on the list is no longer there. Nothing was removed and no approval was used.", next: "Look at what was created again, write a new proposal, and collect new cleanup approvals." },
  PROPOSAL_ALREADY_EXECUTED: { why: "This cleanup proposal was already run once, or an earlier try stopped part way. A proposal runs once only.", next: "Check that everything is gone. If something is left, a new proposal is needed after the pilot owner has reviewed." },
  CLEANUP_NOT_SUPPORTED: { why: "The build tool this pilot uses has no cleanup step yet.", next: "Ask the pilot owner; removing what this tool made needs its own decision." },
  CLEANUP_WOULD_EMPTY_STACK: { why: "Removing everything on the list would leave the stack with nothing in it, which the cloud does not allow. A cleanup never removes the stack itself. Nothing was removed and no approval was used.", next: "The last things in a stack go with the stack. Retiring the stack is the pilot owner's separate, reviewed decision; ask them." },
  CLEANUP_RETAIN_POLICY: { why: "Something on the list is set to be kept even when it is taken out of the stack, so removing it this way would leave it behind unrecorded. Nothing was removed and no approval was used.", next: "Ask the pilot owner to decide about that thing by hand; the rest can be proposed again without it." },
  CLEANUP_DEPENDENT_REFERENCED: { why: "Something that stays in the stack still depends on something on the list, so removing the list would break or take along a thing nobody approved. Nothing was removed and no approval was used.", next: "Look at what was created again and write a new proposal that includes or leaves out the dependent thing." },
  OBSERVED: { why: "The console looked at each thing the change left behind.", next: "Read the list, then write the cleanup proposal if everything is as expected." },
  CLEANUP_PROPOSED: { why: "The cleanup proposal is written.", next: "Send it to the approvers, collect their cleanup approval files, then remove the listed things." },
  CLEANED_UP: { why: "The removal finished.", next: "Check that everything is gone." },
  CLEANUP_COMPLETE: { why: "Everything on the list is confirmed gone; kept items were left in place and were not checked.", next: "Nothing further for this change's listed resources. The environment itself is not retired; that is the pilot owner's separate, reviewed action." },
  CLEANUP_INCOMPLETE: { why: "Something on the list is not confirmed gone yet.", next: "Follow the next step shown with the list." },
  WORKSPACE_REMOVED: { why: "This change's working files on this computer were removed; its records were kept.", next: "Nothing further. The removal record sits with the change's records." },
  REMOVAL_NOT_AUTHORIZED: { why: "Removing this change's working files is not allowed right now (for example, the stop switch is on).", next: "Ask the pilot owner, then try again." },
  REMOVAL_RUN_IN_PROGRESS: { why: "A change or a cleanup is still running, and its working files may be in use.", next: "Wait for it to end, then try again." },
  REMOVAL_PATH_REFUSED: { why: "A working file is a link or is outside the folders this product owns, so nothing was removed.", next: "Ask the pilot owner to look at the path shown." },
  REMOVAL_RECORD_INVALID: { why: "The record of an earlier removal cannot be read, so nothing was removed.", next: "Ask the pilot owner to look at the removal record." },
  REMOVAL_FAILED: { why: "The removal stopped part-way; the record says what is left, and the approvals are used up.", next: "Get new approvals for the same proposal and run the removal again; it picks up where it stopped." },
  WORKSPACE_REMOVAL_PROPOSED: { why: "The list of this change's working files to remove is ready; nothing is removed yet.", next: "Ask the approvers to approve the removal, then run it." },
  REMOVAL_SCOPE_CHANGED: { why: "What would be removed changed after it was shown, so nothing was removed and no approval was used.", next: "Run the removal again to see the current list." },
  REMOVAL_STOPPED: { why: "The stop switch was turned on during the removal; the record says what is left, and the approvals are used up.", next: "When the pilot owner clears the stop switch, get new approvals for the same proposal and run it again." },
  REMOVAL_PATH_CHANGED: { why: "A working file changed into a link or moved during the removal, so it was left alone; the approvals are used up.", next: "Ask the pilot owner to look at the path the record names." },
  REMOVAL_RECORD_CHANGED: { why: "The removal record changed while the removal was being prepared, so nothing was removed; the approvals are used up.", next: "Ask the pilot owner to look at the removal record." },
  CLEANUP_KNOWN_CONFIRMED: { why: "Everything on the list is confirmed gone, but the change carried no cleanup marker, so things outside its records could not be searched for.", next: "Ask the pilot owner to confirm by hand that nothing else of this change remains, or apply with the cleanup marker so the search can run." },
  // the command line's own errors, as the wizard reaches them
  APPLY_FLAG_UNKNOWN: { why: "The wizard sent something the command did not understand. This should not happen.", next: "Reload the page and try again. If it repeats, tell the pilot owner." },
  APPLY_ARGUMENT_INVALID: { why: "The wizard sent something the command did not understand. This should not happen.", next: "Reload the page and try again. If it repeats, tell the pilot owner." },
  APPLY_ARGUMENT_REQUIRED: { why: "A required box was left empty.", next: "Fill in every box and try again." },
  APPLY_SUBCOMMAND_UNKNOWN: { why: "The wizard asked for a step that does not exist. This should not happen.", next: "Reload the page and try again. If it repeats, tell the pilot owner." },
  APPLY_INPUT_INVALID: { why: "A file you pointed to is missing, cannot be read, or does not have the expected contents.", next: "Check the file locations and the examples under each box, then try again. Nothing was changed." },
  APPLY_KEY_INVALID: { why: "Your key file cannot be used. It has to be your private key, in a file only you can read.", next: "Choose the right file, or make it private to you (on Mac and Linux: chmod 600 and the file name). This page never uploads or shows your key." },
  HUMAN_TERMINAL_REQUIRED: { why: "The console could not confirm that you unlocked it.", next: "Unlock the wizard again with the session token from your terminal, then retry." },
  HUMAN_CONFIRMATION_MISMATCH: { why: "What you typed did not match the place shown. Nothing ran.", next: "Try again, and use the Copy button so the place is exact." },
  PROJECT_CODE_CONFIRMATION_MISMATCH: { why: "What you typed did not match the phrase shown. Nothing ran.", next: "Try again, and use the Copy button so the phrase is exact." },
  EMBED_STATE_WRITE_CONFIRMATION_MISMATCH: { why: "What you typed did not match the phrase shown. Nothing ran.", next: "Try again, and use the Copy button so the phrase is exact." },
  QUALIFICATION_ATTESTATION_MISMATCH: { why: "What you typed did not match the phrase shown. Nothing was recorded.", next: "Try again, and use the Copy button so the phrase is exact." },
  APPLY_CONFIRMATION_MISMATCH: { why: "What you typed did not match the phrase shown. Nothing was signed or applied.", next: "Try again, and use the Copy button so the phrase is exact." },
  APPLY_UNEXPECTED_ERROR: { why: "Something unexpected stopped this step before it could say why.", next: "Do not assume it worked or that it did not. Tell the pilot owner, and check the Results before trying again." },
  // getting the files ready (./alz apply prepare)
  INPUT_UNSET: { why: "The project needs settings that have no value yet. The Details name them; their values are never asked for or shown here.", next: "Give each one a default or an entry in the project's settings file, or set it where the console runs, then get the files ready again." },
  MODULE_REMOTE: { why: "The project uses a building block (module) downloaded from outside the project, so its code is not fingerprinted and cannot be locked for review.", next: "Copy that module into the project folder and point to it with a ./ path, then get the files ready again." },
  MODULE_OUTSIDE_PROJECT: { why: "The project points to a building block (module) folder outside the project folder, or to one that does not exist.", next: "Move that module inside the project folder, then get the files ready again." },
  TERRAFORM_CONFIG_UNREADABLE: { why: "A project file could not be read, for example because a quote, comment or text block is not closed.", next: "Fix the file the Details name, then get the files ready again." },
  PREPARED: { why: "The files for this change are ready on this computer.", next: "Make the preview with the button under the filled-in boxes." },
  CONTRACT_DISABLED: { why: "The owner's pilot rules are not switched on and approved, so there is nothing to prepare against.", next: "Ask the pilot owner to approve the pilot rules. You cannot do this from here." },
  POLICY_VERSION_MISSING: { why: "The owner's pilot rules do not say which reviewed policy version applies, and the console never guesses it.", next: "Ask the pilot owner to add the policy version to the pilot rules and approve them again." },
  ENVIRONMENT_INVALID: { why: "The environment was not one of DEV, QA or PROD.", next: "Choose DEV, QA or PROD and try again." },
  PROJECT_INVALID: { why: "The project folder does not exist, or it is not a folder.", next: "Check the folder location against the example and try again. Nothing was changed." },
  PROJECT_ENGINE_MISMATCH: { why: "This folder is not the kind of project the pilot rules use, for example a CDK folder where Terraform is expected.", next: "Choose the folder for the build tool the pilot rules name. The console never switches tools for you." },
  PROJECT_NOT_CLEAN: { why: "The project folder still holds files from an earlier local run.", next: "Remove the .terraform folder from the project, then try again." },
  PROJECT_SNAPSHOT_REFUSED: { why: "The project folder holds something that cannot be fingerprinted safely, such as a link, a saved cloud record or a very large file.", next: "Remove what the Details name from the project folder, then try again." },
  LOCK_FILE_MISSING: { why: "The project has no .terraform.lock.hcl file, which pins the exact provider versions.", next: "Run terraform init once in the project, review the file it writes, keep it with the project, and try again." },
  LOCK_FILE_UNREADABLE: { why: "The project's .terraform.lock.hcl file cannot be read.", next: "Run terraform init again to rewrite it, review it, and try again." },
  ENGINE_VERSION_REQUIRED: { why: "The console needs the version of the AWS CLI on this computer, and no earlier check recorded it.", next: "Enter the version in the box that appeared, then try again." },
  TOOL_UNAVAILABLE: { why: "A tool this change needs is not installed in the approved place on this computer.", next: "Install it with ./alz deps, or ask the owner about the other supported way. A different tool needs its own approved rules and approvals." },
  MANIFEST_INVALID: { why: "The project fingerprint file is not valid, or was never finalized.", next: "Choose the right file or ask whoever made it to create it again." },
  // the console's own refusals
  PILOT_PATH_NOT_CHOSEN: { why: "You have not chosen how this change will run yet.", next: "Go back to step 1 and choose the console or the command line." },
  PILOT_PATH_CLI: { why: "This change is set to run on the command line, so the console buttons are off.", next: "Use the commands shown in step 1, or start over to run a new change in the console." },
  PILOT_PATH_LOCKED: { why: "This change already runs the other way, and one change never mixes both.", next: "Start over to begin a new change." },
  PILOT_RUN_ACTIVE: { why: "Something is already running.", next: "Wait for it to finish, or cancel the question it is asking." },
  PILOT_TOKEN_REQUIRED: { why: "The session token is missing or wrong.", next: "Paste the token printed in the terminal where you started the console." },
  PILOT_ORIGIN_REQUIRED: { why: "The request did not come from the console page.", next: "Use the console in your own browser window at the address it printed." },
  PILOT_JSON_REQUIRED: { why: "The request was not in the form the console expects. This should not happen.", next: "Reload the page and try again." },
  PILOT_REQUEST_INVALID: { why: "One of the boxes holds something that cannot be used.", next: "Check each box against its example and try again. Nothing ran." },
  PILOT_REQUEST_TOO_LARGE: { why: "That request is too large.", next: "Shorten the entries and try again." },
  PILOT_METHOD_NOT_ALLOWED: { why: "That kind of request is not allowed here.", next: "Reload the page and try again." },
  PILOT_ENVIRONMENT_MISMATCH: { why: "The request file is for a different environment than the one you picked.", next: "Pick the environment the request file is for, or choose another request file." },
  PILOT_NO_SUCH_QUESTION: { why: "That question is not waiting any more.", next: "Look at the screen for the current question." },
  PILOT_NOTHING_TO_CANCEL: { why: "No question is waiting, so there is nothing to cancel.", next: "Wait for the step to finish." },
  PILOT_FAILED: { why: "The console could not complete that request. Nothing was run.", next: "Try again. If it repeats, tell the pilot owner." },
  PILOT_UNREACHABLE: { why: "This page cannot reach the console.", next: "Make sure the console is still running in its terminal, then reload this page." },
  LOCAL_HOST_ONLY: { why: "The console only answers on this computer's own address.", next: "Open the address the console printed, exactly as printed." },
  NOT_FOUND: { why: "The console does not know that request.", next: "Reload the page and try again." },
  UNKNOWN_CODE: { why: "The step stopped for a reason this page does not have words for.", next: "Nothing should be assumed. Tell the pilot owner what the Details say." },
};

export const reasonFor = (code: string | undefined): Reason => CODE_COPY[code ?? ""] ?? CODE_COPY.UNKNOWN_CODE;

// --- places the wizard itself is stopped ---------------------------------------------------------------------------

export type BlockedState = "LOCKED" | "PATH_NOT_CHOSEN" | "PATH_IS_CLI" | "NOT_READY" | "FIELDS_MISSING" | "REVIEW_NOT_LOADED" | "NO_APPROVALS_YET" | "NOTHING_PREPARED" | "RUN_ACTIVE" | "SESSION_LOST" | "APPROVER_ONLY_SIGNS";

export const BLOCKED: Readonly<Record<BlockedState, Reason>> = {
  LOCKED: { why: "The wizard is locked until you paste the session token.", next: "Copy the token from the terminal where you started the console and paste it above." },
  PATH_NOT_CHOSEN: { why: "You have not chosen how this change will run.", next: "Go to step 1 and choose the console or the command line." },
  PATH_IS_CLI: { why: "This change is set to run on the command line, so these buttons are off.", next: "Use the commands in step 1, or start over to run a new change in the console." },
  NOT_READY: { why: "The readiness check has not passed for this environment.", next: "Run the check, fix each red item it lists, and check again." },
  FIELDS_MISSING: { why: "A required box is empty.", next: "Fill in every box. The example under each one shows what goes there." },
  REVIEW_NOT_LOADED: { why: "You have not loaded the review yet, so there is nothing to sign.", next: "Enter the review file location and choose Show what will change." },
  NO_APPROVALS_YET: { why: "No approval files have been added yet.", next: "Collect an approval file from each approver and add its location, one per line." },
  NOTHING_PREPARED: { why: "No change has been prepared in this session.", next: "Go back to Prepare the change, or enter the locations of an existing prepared change." },
  RUN_ACTIVE: { why: "A step is already running.", next: "Wait for it to finish, or cancel the question it is asking." },
  SESSION_LOST: { why: "This page lost contact with the console.", next: "Close this page, start the console again, and unlock the wizard with the new token." },
  APPROVER_ONLY_SIGNS: { why: "As an approver you only review and sign. Preparing and applying are the operator's steps.", next: "Send your approval file back to the operator, or choose \"I am the operator\" in step 1." },
};

// --- readiness items -----------------------------------------------------------------------------------------------

export type CheckCopy = { label: string; wrong: string; fix: string; informational?: true; known: boolean };

/** Turns one line of the readiness check into words. `known` is false only for a line this page has no words for. */
export function describeCheck(item: PreflightCheck, environment: PilotEnvironment): CheckCopy {
  const name = item.check;
  if (name.startsWith("contract shape")) {
    return { known: true, label: "The pilot rules file is complete and well formed", wrong: "The pilot rules file is missing, unreadable, or has a mistake.", fix: "Ask the pilot owner to correct the pilot rules file, then check again." };
  }
  if (name.startsWith("pilot contract pinned and enabled")) {
    return { known: true, label: "The pilot is switched on and approved by the owner", wrong: "The pilot is switched off, or the rules file was changed after the owner approved it. This is the normal state until the owner switches the pilot on.", fix: "Ask the pilot owner to review the rules and switch the pilot on. Nothing you do here can switch it on." };
  }
  if (name.startsWith("identities configured")) {
    return { known: true, label: "Each separate sign-in is set up on its own", wrong: "A sign-in is missing, two are the same, or one could fall back to your own account.", fix: "In the terminal where you started the console, set the missing sign-in details (the walkthrough lists them), restart the console, and check again." };
  }
  if (name.startsWith("identities aimed at the")) {
    return { known: true, label: "The sign-ins point at the " + environment + " account", wrong: "A sign-in points at a different account than the one the pilot rules name for " + environment + ".", fix: "Correct that sign-in's account details in the terminal where you started the console, restart the console, and check again." };
  }
  if (name.startsWith("plan will embed STATE_WRITE settings")) {
    return { known: true, informational: true, label: name.endsWith("yes") ? "Preparing will ask one extra question about the storage sign-in" : "Preparing will not ask the extra storage sign-in question", wrong: "", fix: "" };
  }
  const tool = /^tool (\S+) installed/.exec(name);
  if (tool) {
    return { known: true, label: "The tool \"" + tool[1] + "\" is installed in an approved folder", wrong: "The tool \"" + tool[1] + "\" was not found in a folder the pilot allows.", fix: "Install it in a standard system folder (the walkthrough lists them), restart the console, and check again." };
  }
  if (name.startsWith("engine qualified in DEV")) {
    return { known: true, label: "The one-time DEV check has been done and still matches this computer", wrong: "The one-time DEV check has not been done, or it was done with a different tool, sign-in or account than this computer now uses, or it is more than 30 days old.", fix: "A person runs the one-time check in a terminal against DEV with the owner (see the walkthrough, \"Before your first change\"), then check again here." };
  }
  if (name.startsWith("identity separation attested")) {
    return { known: true, label: "The separate sign-ins were shown to stay separate on the real cloud", wrong: "Nobody has confirmed yet, from the cloud's own records, that the separate sign-ins really stay separate. This is confirmed during the one-time DEV check.", fix: "It turns ready when the one-time DEV check is done and still matches this computer." };
  }
  if (name.startsWith("kill switch absent")) {
    return { known: true, label: "The emergency stop is off", wrong: "The emergency stop is on, so every change is blocked.", fix: "Only the pilot owner turns it off. Ask them, and do not remove the stop file yourself." };
  }
  return { known: false, label: name, wrong: "This check did not pass.", fix: "Tell the pilot owner what the Details say." };
}

// --- results -----------------------------------------------------------------------------------------------------------

export type ResultKind = "APPLIED" | "NOTHING_CHANGED" | "APPROVALS_SPENT" | "NEEDS_REVIEW";

export const RESULT_COPY: Readonly<Record<ResultKind, { headline: string; what: string; next: string[]; tone: "good" | "caution" | "stop" }>> = {
  APPLIED: {
    tone: "good",
    headline: "Applied",
    what: "The change was applied, and the record of it was saved.",
    next: ["Keep the saved record. It is what later environments rely on.", "For the next environment (QA after DEV, production after QA), prepare a new change with the same release."],
  },
  NOTHING_CHANGED: {
    tone: "caution",
    headline: "Nothing changed",
    what: "The step stopped before anything was changed, and nothing was used up.",
    next: ["Read the reason below, fix it, and run the step again."],
  },
  APPROVALS_SPENT: {
    tone: "caution",
    headline: "Nothing changed, but the approvals are used up",
    what: "The change was not applied. The approvals were already used, and they cannot be used again.",
    next: ["Fix the cause below.", "Ask each approver to sign again. Then apply the same prepared change."],
  },
  NEEDS_REVIEW: {
    tone: "stop",
    headline: "A person must review this before anything else",
    what: "The change may be partly done, or it was stopped half way. It is not safe to assume either way.",
    next: [
      "DO NOT RETRY. Trying again could make it worse.",
      "Call the pilot owner now and tell them the time, the environment, and that the apply needs a manual review.",
      "Keep this page open and do not start another change until the owner says it is safe.",
    ],
  },
};

/** What a finished step means to the person. Only the apply step has more than two endings. */
export function classifyResult(step: string, result: RunResult): ResultKind {
  const outcome = result.outcome ?? (typeof result.data === "object" && result.data !== null ? (result.data as { outcome?: string }).outcome : undefined);
  if (result.exit === 0) return "APPLIED";
  if (outcome === "PARTIAL_REQUIRES_REVIEW" || outcome === "KILLED") return "NEEDS_REVIEW";
  if (result.code === "EVIDENCE_REJECTED") return "NEEDS_REVIEW";
  if (outcome === "FAILED_NO_CHANGE") return "APPROVALS_SPENT";
  if (result.code === "APPROVALS_SPENT" || result.code === "KILL_SWITCH_AFTER_APPROVALS") return "APPROVALS_SPENT";
  if (result.exit === 3) return "NEEDS_REVIEW";
  return "NOTHING_CHANGED";
}

// --- the change list, in words -----------------------------------------------------------------------------------------

const plural = (count: number, one: string, many: string): string => count + " " + (count === 1 ? one : many);

/** "3 things will be created, 1 changed ..." */
export function describeCounts(counts: ChangeCounts): string[] {
  const lines: string[] = [];
  if (counts.create > 0) lines.push(plural(counts.create, "thing will be created", "things will be created"));
  if (counts.update > 0) lines.push(plural(counts.update, "thing will be changed in place", "things will be changed in place"));
  if (counts.replace > 0) lines.push(plural(counts.replace, "thing will be replaced (removed and made again)", "things will be replaced (removed and made again)"));
  if (counts.delete > 0) lines.push(plural(counts.delete, "thing will be deleted", "things will be deleted"));
  if (counts.forget > 0) lines.push(plural(counts.forget, "thing will stop being tracked but keep running", "things will stop being tracked but keep running"));
  if (counts.other > 0) lines.push(plural(counts.other, "other change", "other changes"));
  return lines.length === 0 ? ["Nothing will change."] : lines;
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  CREATE: "Create", UPDATE: "Change", REPLACE: "Replace", REPLACE_CONDITIONAL: "Maybe replace", DELETE: "Delete", FORGET: "Stop tracking", IMPORT: "Bring under management", DYNAMIC: "Decided while applying",
};
export const actionWord = (action: string): string => ACTION_WORDS[action] ?? "Other (" + action.slice(0, 24) + ")";
export const changeNotes = (change: PlanChange): string[] => [
  ...(change.importing ? ["an existing thing is being brought under management"] : []),
  ...(change.previousAddress ? ["moved from " + change.previousAddress] : []),
  ...(change.action === "FORGET" ? ["the real thing keeps running"] : []),
];

/** The commands for the command-line path, in the order they are run. */
export const CLI_COMMANDS: readonly { who: string; what: string; command: string }[] = [
  { who: "Operator", what: "Check this computer is ready", command: "./alz apply preflight --environment DEV" },
  { who: "Operator", what: "Get the files ready from your project folder", command: "./alz apply prepare --environment DEV --project PROJECT_FOLDER" },
  { who: "Operator (the requester)", what: "Prepare the change and lock it, signed with the requester's key", command: "./alz apply seal --request REQUEST.json --manifest MANIFEST.json --requester NAME --key REQUESTER_KEY.pem" },
  { who: "Each approver", what: "Review and sign (on their own computer)", command: "./alz apply approve --bundle REVIEW_FILE.json --key APPROVER_KEY.pem --approver NAME" },
  { who: "Operator", what: "Apply the locked change", command: "./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed LOCKED_CHANGE --approval APPROVAL.json" },
  { who: "Anyone", what: "Look at the status afterward", command: "./alz apply status --sealed LOCKED_CHANGE" },
];

export const SUPPORT_NOTE = (step: string, code: string | undefined, message: string | undefined): string =>
  ["Pilot apply note for the owner", "Step: " + step, "Reference: " + (code ?? "none"), "Message: " + (message ?? "none"), "When: " + new Date().toISOString()].join("\n");
