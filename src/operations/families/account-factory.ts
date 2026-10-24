import type { OperationSpec } from "../types.js";

/** Only HANDOFF cards: the generic browser operations job runner must never submit AWS mutations. */
export const accountFactoryOperations: readonly OperationSpec[] = [
  {
    id: "account-factory-inspect", family: "governance", title: "Connect existing AWS access",
    summary: "Use your current signed-in AWS role and the organization’s existing management account.",
    cli: "./alz account-factory inspect", safety: "HANDOFF",
    inputs: [{ kind: "text", name: "profile", label: "Saved SSO profile",
      pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}", maxLength: 64, example: "adaptcloud-admin" }],
    evidenceBasis: "LIVE AWS STS — existing named SSO role, no new IAM role or model credentials",
    cliScript: "src/cli/account-factory.ts", command: { group: "account-factory", sub: "inspect" },
    handoff: { reason: "Identity Center SSO session is used only in your local terminal; it is never handed to a model.",
      command: "./alz account-factory inspect {profile}", env: ["AWS_CONFIG_FILE"] },
  },
  {
    id: "account-factory-prepare", family: "governance", title: "Plan a customer environment",
    summary: "Discover the signed-in organization and prepare a DEV, QA, STAGING or PROD account using existing guardrails.",
    cli: "./alz account-factory prepare", safety: "HANDOFF",
    inputs: [
      { kind: "text", name: "profile", label: "Saved SSO profile", pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}", maxLength: 64, example: "adaptcloud-admin" },
      { kind: "enum", name: "practiceRole", label: "Your practice role", options: ["MODERN_PLATFORMS_PRESALES", "MODERN_PLATFORMS_DELIVERY", "DIGITAL_PRESALES", "DIGITAL_DELIVERY"] },
      { kind: "enum", name: "environment", label: "Environment", options: ["DEV", "QA", "STAGING", "PROD"] },
      { kind: "text", name: "name", label: "Account name", pattern: "[A-Za-z0-9][A-Za-z0-9 _.-]{1,49}", maxLength: 50, example: "ALZ-DEV-01" },
      { kind: "text", name: "email", label: "Unique account email", pattern: "[^ @]+@[^ @]+[.][^ @]+", maxLength: 120, example: "dev-accounts@example.org" },
      { kind: "text", name: "ownerEmail", label: "Identity Center owner email", pattern: "[^ @]+@[^ @]+[.][^ @]+", maxLength: 120, example: "owner@example.org" },
      { kind: "text", name: "ownerFirst", label: "Owner first name", pattern: "[A-Za-z -]{1,64}", maxLength: 64, example: "Example" },
      { kind: "text", name: "ownerLast", label: "Owner last name", pattern: "[A-Za-z -]{1,64}", maxLength: 64, example: "Owner" },
      { kind: "text", name: "output", label: "Private output path", pattern: "[A-Za-z0-9_./-]{1,200}", maxLength: 200, example: ".runs/account-factory/dev-proposal.json" },
    ],
    evidenceBasis: "LIVE AWS — read existing organization, OU, Control Tower and Service Catalog; no cloud change",
    cliScript: "src/cli/account-factory.ts", command: { group: "account-factory", sub: "prepare" },
    handoff: { reason: "Uses a separately authenticated admin SSO session and writes a private proposal. No account is created.",
      command: "./alz account-factory prepare {profile} {practiceRole} {environment} {name} {email} {ownerEmail} {ownerFirst} {ownerLast} {output}" },
  },
  {
    id: "account-factory-submit", family: "governance", title: "Create the reviewed account",
    summary: "Create one reviewed AWS member account with a single human confirmation and the existing SSO permissions.",
    cli: "./alz account-factory submit", safety: "HANDOFF",
    inputs: [
      { kind: "text", name: "profile", label: "Saved SSO profile", pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}", maxLength: 64, example: "adaptcloud-admin" },
      { kind: "text", name: "proposal", label: "Approved proposal", pattern: "[A-Za-z0-9_./-]{1,200}", maxLength: 200, example: ".runs/account-factory/dev-proposal.json" },
      { kind: "text", name: "receipt", label: "Receipt output", pattern: "[A-Za-z0-9_./-]{1,200}", maxLength: 200, example: ".runs/account-factory/dev-submission.json" },
    ],
    evidenceBasis: "LIVE AWS ACCOUNT CREATION — one human confirmation, AWS-native permissions, recorded request",
    cliScript: "src/cli/account-factory.ts", command: { group: "account-factory", sub: "submit" },
    handoff: { reason: "Confirm one AWS account creation in your trusted terminal. The console never silently creates accounts.",
      command: "./alz account-factory submit {profile} {proposal} {receipt}" },
  },
  {
    id: "account-factory-status", family: "governance", title: "Check environment creation progress",
    summary: "Read the real asynchronous Service Catalog provisioning record; does not claim Control Tower enrollment is complete.",
    cli: "./alz account-factory status", safety: "HANDOFF",
    inputs: [
      { kind: "text", name: "profile", label: "Saved SSO profile", pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,63}", maxLength: 64, example: "adaptcloud-admin" },
      { kind: "text", name: "recordId", label: "AWS provisioning record", pattern: "rec-[a-z0-9]+", maxLength: 120, example: "rec-example123" },
    ],
    evidenceBasis: "LIVE SERVICE CATALOG READ — PROVIDER STATUS ONLY; INDEPENDENT ACCOUNT VERIFY STILL REQUIRED",
    cliScript: "src/cli/account-factory.ts", command: { group: "account-factory", sub: "status" },
    handoff: { reason: "Uses the named short-lived SSO session to query the AWS Service Catalog record.",
      command: "./alz account-factory status {profile} {recordId}" },
  },
  {
    id: "account-factory-verify", family: "governance", title: "View created member account",
    summary: "Independently check active member account, direct Workloads OU membership and effective OU baseline.",
    cli: "./alz account-factory verify", safety: "HANDOFF",
    inputs: [
      {kind:"text",name:"profile",label:"Saved SSO profile",pattern:"[A-Za-z0-9][A-Za-z0-9._-]{0,63}",maxLength:64,example:"adaptcloud-admin"},
      {kind:"text",name:"name",label:"Account name",pattern:"[A-Za-z0-9][A-Za-z0-9 _.-]{1,49}",maxLength:50,example:"ALZ-DEV-01"},
      {kind:"text",name:"email",label:"Account email",pattern:"[^ @]+@[^ @]+[.][^ @]+",maxLength:120,example:"dev-accounts@example.org"}
    ],
    evidenceBasis: "LIVE AWS ORGANIZATIONS AND CONTROL TOWER — READ-ONLY MEMBER-ACCOUNT CHECK, NOT A PRODUCTION RELEASE CLAIM",
    cliScript:"src/cli/account-factory.ts",command:{group:"account-factory",sub:"verify"},
    handoff:{reason:"After provisioning, verify the actual account using the approved SSO administrator session.",
      command:"./alz account-factory verify {profile} {name} {email}"}
  },
];
