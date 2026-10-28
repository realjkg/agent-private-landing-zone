// ACT-DEV-1 AWS CDK canary: exactly one AWS::Logs::LogGroup, the same name scheme, retention and tags as the Terraform canary
// (qualification/aws/act-dev1-canary). The stack is environment-agnostic, synthesized without bootstrap (no BootstrapVersion
// parameter or rule, no asset to publish) and without AWS::CDK::Metadata, so the pilot's CDK engine can read cdk.out as is.
// Inputs are CDK context values (cdk.json holds EXAMPLE values): stackName, canaryName and owner. See README.md.
"use strict";
const { App, BootstraplessSynthesizer, Stack } = require("aws-cdk-lib");
const { CfnLogGroup } = require("aws-cdk-lib/aws-logs");

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const CANARY_NAME = /^\/alz\/act-dev-1\/[a-z0-9][a-z0-9-]{2,48}$/;
const OWNER = /^[A-Za-z0-9._@+-]{1,80}$/;

// No stack traces in the assembly metadata: they would record the build machine's paths and change with the checkout.
const app = new App({ stackTraces: false, context: { "aws:cdk:disable-creation-stack-traces": true } });
function input(key, pattern, hint) {
  const value = app.node.tryGetContext(key);
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("Context value " + key + " is missing or invalid: " + hint);
  return value;
}
const stackName = input("stackName", STACK_NAME, "the stack name in the reviewed contract's DEV target (backend).");
const canaryName = input("canaryName", CANARY_NAME, "the log group must stay under /alz/act-dev-1/.");
const owner = input("owner", OWNER, "provide an approved owner tag.");

const stack = new Stack(app, "ActDev1CdkCanary", {
  stackName,
  terminationProtection: true,
  analyticsReporting: false,
  synthesizer: new BootstraplessSynthesizer(),
});

// The L1 construct keeps CloudFormation's default deletion behavior (no DeletionPolicy), so a governed cleanup may remove it.
new CfnLogGroup(stack, "ActDev1", {
  logGroupName: canaryName,
  retentionInDays: 30,
  tags: [
    { key: "environment", value: "DEV" },
    { key: "managed-by", value: "sovereign-alz" },
    { key: "purpose", value: "act-dev-1" },
    { key: "owner", value: owner },
  ],
});

app.synth();
