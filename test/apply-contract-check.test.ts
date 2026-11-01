import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectPilotContract } from "../src/apply/contract.js";
import { checkDraftContract, contractCheckLines, shippedExampleValues, type ContractCheckReport } from "../src/apply/contract-check.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { keys } from "./helpers/apply-fixtures.js";

// The owner-input kit's offline draft check (docs/act-pilot-aws-terraform-g0.md). Fixtures only: fake account ids,
// fixture buckets and freshly generated test keys. Nothing here is a real contract, and nothing is pinned or enabled.

process.env.AGENTIC_EVIDENCE_KEY ??= randomBytes(32).toString("base64");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "alz-contract-check-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const file = (value: unknown, label = "draft"): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, label + ".json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
};

/**
 * A complete AWS Terraform DEV-only draft: fake ids (not the shipped example's repeated digits), a region, workspace and kill
 * switch path no shipped example uses, and test keys; enabled false as a draft is.
 */
/** What an APPLY may create (the legacy canary form; test/apply-limits.test.ts covers `limits`), an owner input of every target. */
const CANARY = { resources: [{ type: "aws_cloudwatch_log_group", count: 1 }] };
const completeDraft = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: false, provider: "AWS", engine: "TERRAFORM", policyVersion: "2026-10-11.1", enabledEnvironments: ["DEV"],
  targets: { DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev", canary: CANARY } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 30,
  approvers: [{ id: "pilot-owner", publicKeyPem: keys.alice.pub, environments: ["DEV"] }],
  killSwitchPath: ".runs/apply/STOP-DEV", embedStateWrite: true, ...over,
});
/** The three-stage chain with two production approvers. */
const chainDraft = () => ({
  ...completeDraft(), enabledEnvironments: undefined,
  targets: {
    DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev", canary: CANARY },
    QA: { accountId: "234567890123", region: "eu-central-1", backend: "fixture-qa-state/pilot/qa.tfstate", workspace: "pilot-qa", canary: CANARY },
    PROD: { accountId: "345678901234", region: "eu-central-1", backend: "fixture-prod-state/pilot/prod.tfstate", workspace: "pilot-prod", canary: CANARY },
  },
  requiredApprovals: { DEV: 1, QA: 1, PROD: 2 },
  approvers: [
    { id: "release-approver-1", publicKeyPem: keys.alice.pub, environments: ["DEV", "QA", "PROD"] },
    { id: "release-approver-2", publicKeyPem: keys.bob.pub, environments: ["DEV", "QA", "PROD"] },
  ],
});
const statusOf = (report: ContractCheckReport, field: string) => report.inputs.find((x) => x.field === field)?.status;
const notReady = (report: ContractCheckReport) => report.inputs.filter((x) => x.status !== "PRESENT").map((x) => x.field);

test("a complete draft with fake ids and test keys is COMPLETE, maps every owner input to its field, and enables nothing", () => {
  const draft = completeDraft();
  const report = checkDraftContract(draft);
  assert.equal(report.complete, true, JSON.stringify(notReady(report)));
  assert.deepEqual(report.shape, { ok: true });
  assert.equal(report.enabledAsWritten, false, "a draft is reported as written, never flipped");
  assert.deepEqual(report.scope, ["DEV"]);
  assert.deepEqual(report.inputs.map((x) => x.field), [
    "enabled", "provider", "engine", "policyVersion", "enabledEnvironments",
    "targets.DEV.accountId", "targets.DEV.region", "targets.DEV.backend", "targets.DEV.workspace", "targets.DEV.canary", "requiredApprovals.DEV",
    "maxApprovalAgeMinutes", "approvers[0].id", "approvers[0].publicKeyPem", "approvers[0].environments", "killSwitchPath", "embedStateWrite",
  ]);
  assert.ok(report.inputs.every((x) => x.input.length > 0 && x.status === "PRESENT"));
  // The STATE_WRITE binding is required for Terraform (owner decision 6486426552): a draft without it is never COMPLETE.
  const { embedStateWrite: _dropped, ...unbound } = completeDraft();
  const missing = checkDraftContract(unbound);
  assert.equal(missing.complete, false);
  assert.equal(missing.inputs.find((x) => x.field === "embedStateWrite")?.status, "MISSING");
  assert.equal(checkDraftContract(completeDraft({ embedStateWrite: false })).complete, false, "false is refused by the validator");
  // The inputs that are not contract fields are listed with where they are checked instead, naming the engine's four identities.
  assert.match(report.outsideContract[0].input, /DISCOVERY, STATE, STATE_WRITE, APPLY/);
  assert.ok(report.outsideContract.some((x) => /execution host/.test(x.input)) && report.outsideContract.some((x) => /cleanup owner/.test(x.input)));
  assert.ok(report.guarantees.some((line) => /never enables ACT and never writes the contract/.test(line)));
  // The report and its lines carry no key material: a public key is reported by field, never printed.
  const text = contractCheckLines(report, "draft.json").join("\n") + JSON.stringify(report);
  assert.ok(!text.includes(keys.alice.pub.split("\n")[1]), "no key material in the report");
  assert.match(text, /COMPLETE: every input is present/);
  // The draft's bytes are untouched by the check.
  assert.equal(draft.enabled, false);
});

test("the three-stage chain is complete only with enough PROD approvers: the second production approver is an owner input", () => {
  const chain = chainDraft();
  const two = checkDraftContract(chain);
  assert.equal(two.complete, true, JSON.stringify(notReady(two)));
  assert.deepEqual(two.scope, ["DEV", "QA", "PROD"]);
  assert.equal(statusOf(two, "approvers (PROD quorum)"), "PRESENT");
  const one = checkDraftContract({ ...chain, approvers: [chain.approvers[0]] });
  assert.equal(one.shape.ok, true, "the validator accepts one approver; the kit still names the missing second production approver");
  assert.equal(one.complete, false);
  assert.deepEqual(notReady(one), ["approvers (PROD quorum)"]);
  assert.match(one.inputs.find((x) => x.field === "approvers (PROD quorum)")!.detail!, /1 approver\(s\) may sign for PROD; 2 distinct/);
});

test("the shipped AWS examples are refused as placeholders and example values, every one named, and neither is complete", () => {
  for (const name of ["act-pilot-contract.aws-dev.example.json", "act-pilot-contract.aws.example.json"]) {
    const example = JSON.parse(readFileSync(join(ROOT, "config", name), "utf8")) as Record<string, unknown>;
    const report = checkDraftContract(example);
    assert.equal(report.complete, false, name);
    assert.equal(statusOf(report, "policyVersion"), "PLACEHOLDER", name);
    assert.equal(statusOf(report, "targets.DEV.accountId"), "EXAMPLE", name);
    assert.equal(statusOf(report, "targets.DEV.backend"), "EXAMPLE", name);
    assert.equal(statusOf(report, "approvers[0].id"), "PLACEHOLDER", name);
    assert.equal(statusOf(report, "approvers[0].publicKeyPem"), "PLACEHOLDER", name);
    // The example's region, workspace and kill switch path are legitimate defaults: PRESENT with a review notice, never EXAMPLE.
    for (const field of ["targets.DEV.region", "targets.DEV.workspace", "killSwitchPath"]) {
      assert.equal(statusOf(report, field), "PRESENT", name + " " + field);
      assert.match(report.inputs.find((x) => x.field === field)!.notice!, /confirm this value is intended/, name + " " + field);
    }
    assert.ok(report.notices >= 3, name + ": one notice per copied region, workspace and kill switch path");
    assert.ok(report.inputs.filter((x) => x.status !== "PRESENT").length >= 5, name + ": every placeholder is listed, not only the first");
    if (Object.hasOwn(example, "EXAMPLE")) assert.equal(statusOf(report, "EXAMPLE"), "PLACEHOLDER", name + ": the example marker is named");
  }
});

test("the Azure Terraform DEV example (docs/act-pilot-azure-terraform-g0.md) names every owner input, and a filled copy is COMPLETE for Azure Terraform DEV", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "act-pilot-contract.azure-dev.example.json"), "utf8")) as Record<string, unknown>;
  const report = checkDraftContract(example);
  assert.deepEqual([report.provider, report.engine, report.enabledAsWritten, report.scope], ["AZURE", "TERRAFORM", false, ["DEV"]]);
  assert.equal(report.complete, false);
  // The DEV target only, with the Azure spec's account fields (no region, no QA or PROD) and its authorized location (owner
  // decision of 2026-10-28: every Azure Terraform APPLY plan is judged against it).
  assert.deepEqual(report.inputs.map((x) => x.field), [
    "enabled", "provider", "engine", "policyVersion", "enabledEnvironments",
    "targets.DEV.tenantId", "targets.DEV.subscriptionId", "targets.DEV.backend", "targets.DEV.workspace", "targets.DEV.location", "targets.DEV.canary", "requiredApprovals.DEV",
    "maxApprovalAgeMinutes", "approvers[0].id", "approvers[0].publicKeyPem", "approvers[0].environments", "killSwitchPath", "embedStateWrite",
  ]);
  // Every value that only the owner can supply is refused as a placeholder or the example's fake backend, each by its field.
  // The DEV-only scope itself is accepted for Azure Terraform (#298, owner decision 6442856302).
  assert.deepEqual(notReady(report), ["policyVersion", "targets.DEV.tenantId", "targets.DEV.subscriptionId", "targets.DEV.backend", "targets.DEV.location", "approvers[0].id", "approvers[0].publicKeyPem"]);
  assert.equal(statusOf(report, "enabledEnvironments"), "PRESENT");
  assert.equal(statusOf(report, "targets.DEV.location"), "PLACEHOLDER");
  assert.equal(statusOf(report, "targets.DEV.tenantId"), "PLACEHOLDER");
  assert.equal(statusOf(report, "targets.DEV.subscriptionId"), "PLACEHOLDER");
  assert.equal(statusOf(report, "targets.DEV.backend"), "EXAMPLE");
  assert.match(report.outsideContract[0].input, /DISCOVERY, STATE, STATE_WRITE, APPLY/);

  // A copy filled with fixture values (fake ids, a fixture storage account, a freshly generated test key) passes the
  // offline check as Azure Terraform DEV: every input present, the validator's shape accepted, COMPLETE. It enables nothing.
  const filled = {
    ...example, policyVersion: "2026-10-11.1",
    targets: { DEV: { tenantId: "4b1d7c2e-9a3f-4e6b-8c5d-2f7a9e1b3c4d", subscriptionId: "7e8f9a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b", backend: "fixturedevstate/tfstate/dev.tfstate", workspace: "pilot-dev", location: "westeurope",
      canary: { resources: [{ type: "azurerm_virtual_network", count: 1 }] } } },
    approvers: [{ id: "pilot-owner", publicKeyPem: keys.alice.pub, environments: ["DEV"] }], killSwitchPath: ".runs/apply/STOP-DEV",
  };
  const draft = checkDraftContract(filled);
  assert.deepEqual(notReady(draft), [], "every owner input is present");
  assert.deepEqual(draft.shape, { ok: true });
  assert.equal(draft.complete, true);
  assert.deepEqual(draft.scope, ["DEV"]);
  assert.equal(draft.enabledAsWritten, false, "a draft is reported as written, never flipped");
  // The DEV-only scope stays exactly DEV: a QA target beside it is refused by the validator, not ignored.
  const extra = checkDraftContract({ ...filled, targets: { ...filled.targets, QA: { ...filled.targets.DEV, subscriptionId: "8f9a0b1c-2d3e-4f5a-8b6c-7d8e9f0a1b2c", backend: "fixtureqastate/tfstate/qa.tfstate" } } });
  assert.equal(extra.shape.ok, false);
  assert.equal(extra.complete, false);
  // A tenant or subscription that is not a GUID is INVALID on its field, in the validator's words.
  const notGuid = checkDraftContract({ ...filled, targets: { DEV: { ...filled.targets.DEV, subscriptionId: "dev-subscription" } } });
  assert.equal(statusOf(notGuid, "targets.DEV.subscriptionId"), "INVALID");
  assert.equal(notGuid.complete, false);
  // The location is ARM's programmatic name: a display name ("West Europe") is INVALID on its field, and a draft without one is not COMPLETE.
  const display = checkDraftContract({ ...filled, targets: { DEV: { ...filled.targets.DEV, location: "West Europe" } } });
  assert.equal(statusOf(display, "targets.DEV.location"), "INVALID");
  assert.equal(display.complete, false);
  const { location: _location, ...unlocated } = filled.targets.DEV;
  const missing = checkDraftContract({ ...filled, targets: { DEV: unlocated } });
  assert.equal(statusOf(missing, "targets.DEV.location"), "MISSING");
  assert.equal(missing.complete, false);
});

test("RB6: the AWS CDK DEV example names every owner input, is never COMPLETE as shipped, carries no authorization, and a filled copy is COMPLETE for AWS CDK DEV", () => {
  const text = readFileSync(join(ROOT, "config", "act-pilot-contract.aws-cdk-dev.example.json"), "utf8");
  const example = JSON.parse(text) as Record<string, unknown> & { targets: { DEV: Record<string, unknown> } };
  assert.equal(example.enabled, false);
  assert.equal(Object.hasOwn(example, "authorize"), false, "the example authorizes nothing");
  assert.deepEqual(example.targets.DEV.capabilities, [], "no IAM capability without an explicit owner decision");
  assert.match(String(example.EXAMPLE), /CLEANUP_WOULD_EMPTY_STACK/, "the retained empty stack is named where the owner reads it");
  const report = checkDraftContract(example);
  assert.deepEqual([report.provider, report.engine, report.enabledAsWritten, report.scope], ["AWS", "CDK", false, ["DEV"]]);
  assert.equal(report.complete, false);
  assert.equal(report.shape.ok, false, "the example marker alone keeps the validator from accepting it");
  // Every value that only the owner can supply is refused as a placeholder or the example's fake account, each by its field.
  assert.deepEqual(notReady(report), ["EXAMPLE", "policyVersion", "targets.DEV.accountId", "targets.DEV.backend", "approvers[0].id", "approvers[0].publicKeyPem"]);
  assert.equal(statusOf(report, "targets.DEV.accountId"), "EXAMPLE");
  assert.equal(statusOf(report, "targets.DEV.backend"), "PLACEHOLDER");
  assert.equal(statusOf(report, "enabledEnvironments"), "PRESENT");
  // Flipping the flag on the shipped bytes never yields a valid contract.
  assert.equal(checkDraftContract({ ...example, enabled: true }).shape.ok, false);
  const { EXAMPLE: _marker, ...unmarked } = example;
  assert.equal(checkDraftContract({ ...unmarked, enabled: true }).complete, false, "without the marker the placeholders still block");

  // A copy filled with fixture values (a fake account, a fixture stack name, a freshly generated test key) passes the offline
  // check as AWS CDK DEV: every input present, the validator's shape accepted, COMPLETE. It enables nothing.
  const filled = {
    ...unmarked, policyVersion: "2026-10-11.1",
    targets: { DEV: { ...example.targets.DEV, accountId: "123456789012", region: "eu-central-1", backend: "FixturePilotStack" } },
    approvers: [{ id: "pilot-owner", publicKeyPem: keys.alice.pub, environments: ["DEV"] }], killSwitchPath: ".runs/apply/STOP-DEV",
  };
  const draft = checkDraftContract(filled);
  assert.deepEqual(notReady(draft), [], "every owner input is present");
  assert.deepEqual(draft.shape, { ok: true });
  assert.equal(draft.complete, true);
  assert.deepEqual(draft.scope, ["DEV"]);
  assert.equal(draft.enabledAsWritten, false, "a draft is reported as written, never flipped");
});

test("a repeated-digit GUID tenant or subscription (11111111-1111-…, 00000000-…-0000) is an example value, never COMPLETE; a real-looking GUID stays PRESENT", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "act-pilot-contract.azure-dev.example.json"), "utf8")) as Record<string, unknown>;
  const dev = { tenantId: "4b1d7c2e-9a3f-4e6b-8c5d-2f7a9e1b3c4d", subscriptionId: "7e8f9a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b", backend: "fixturedevstate/tfstate/dev.tfstate", workspace: "pilot-dev", location: "westeurope",
    canary: { resources: [{ type: "azurerm_virtual_network", count: 1 }] } };
  const filled = { ...example, policyVersion: "2026-10-11.1", targets: { DEV: dev }, approvers: [{ id: "pilot-owner", publicKeyPem: keys.alice.pub, environments: ["DEV"] }], killSwitchPath: ".runs/apply/STOP-DEV" };
  assert.equal(checkDraftContract(filled).complete, true, "the control: a filled draft with real-looking GUIDs is COMPLETE");
  for (const [field, value] of [
    ["tenantId", "11111111-1111-1111-1111-111111111111"], ["subscriptionId", "00000000-0000-0000-0000-000000000000"],
    ["tenantId", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"], ["subscriptionId", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
  ] as const) {
    const report = checkDraftContract({ ...filled, targets: { DEV: { ...dev, [field]: value } } });
    assert.deepEqual(report.shape, { ok: true }, value + " is a well-formed GUID, so only the example rule can catch it");
    assert.equal(statusOf(report, "targets.DEV." + field), "EXAMPLE", value);
    assert.match(report.inputs.find((x) => x.field === "targets.DEV." + field)!.detail!, /shipped example's fake identifier/);
    assert.equal(report.complete, false, value + " is never COMPLETE");
  }
});

test("each missing owner input is reported by its field in plain words, and the validator's refusal is attached to its field", () => {
  const missing = checkDraftContract({ ...completeDraft(), policyVersion: undefined, killSwitchPath: undefined, approvers: [] });
  assert.deepEqual(notReady(missing), ["policyVersion", "approvers", "killSwitchPath"]);
  assert.match(missing.inputs.find((x) => x.field === "policyVersion")!.input, /reviewed policy version/);
  assert.match(missing.inputs.find((x) => x.field === "approvers")!.input, /never by this tool/);
  // A value the validator refuses is INVALID on that field, with the validator's own words: no second rule book.
  const bad = checkDraftContract(completeDraft({ targets: { DEV: { accountId: "12345", region: "us-east-2", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "default" } } }));
  assert.equal(bad.shape.ok, false);
  assert.equal(statusOf(bad, "targets.DEV.accountId"), "INVALID");
  assert.match(bad.inputs.find((x) => x.field === "targets.DEV.accountId")!.detail!, /^targets\.DEV\.accountId: invalid/);
  const notKey = checkDraftContract(completeDraft({ approvers: [{ id: "pilot-owner", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n", environments: ["DEV"] }] }));
  assert.equal(statusOf(notKey, "approvers[0].publicKeyPem"), "INVALID");
  // A shape refusal that names no input field stays on the shape; the inputs are still listed.
  const wrongVersion = checkDraftContract(completeDraft({ schemaVersion: 2 }));
  assert.equal(wrongVersion.shape.ok, false);
  assert.equal(wrongVersion.complete, false);
  assert.ok(wrongVersion.inputs.every((x) => x.status === "PRESENT"));
  // An unsupported pairing is reported on the shape with the validator's words.
  const pairing = checkDraftContract(completeDraft({ provider: "AZURE", engine: "CDK" }));
  assert.equal(pairing.shape.ok, false);
  assert.match((pairing.shape as { reason: string }).reason, /engine: CDK is valid only with AWS/);
  // Not an object at all: invalid shape, no inputs, never complete.
  for (const raw of [null, "text", [], 42]) {
    const r = checkDraftContract(raw);
    assert.equal(r.shape.ok, false);
    assert.deepEqual(r.inputs, []);
    assert.equal(r.complete, false);
  }
});

test("a missing or non-boolean enabled flag is never COMPLETE, as the loader refuses it, even though the shape check overrides it", () => {
  const absent = checkDraftContract(completeDraft({ enabled: undefined }));
  assert.equal(absent.shape.ok, true, "the validator sees enabled: true substituted");
  assert.equal(statusOf(absent, "enabled"), "MISSING");
  assert.equal(absent.enabledAsWritten, null);
  assert.equal(absent.complete, false);
  for (const value of ["true", "yes", 1, null, {}]) {
    const r = checkDraftContract(completeDraft({ enabled: value }));
    assert.equal(statusOf(r, "enabled"), "INVALID", JSON.stringify(value));
    assert.equal(r.complete, false, JSON.stringify(value));
  }
  assert.equal(checkDraftContract(completeDraft({ enabled: true })).complete, true, "a boolean either way is an explicit decision");
});

test("a region, workspace or kill switch path that equals a shipped example's value is PRESENT with a review notice that never blocks COMPLETE (#277 round 2)", () => {
  const shipped = shippedExampleValues();
  assert.ok(shipped.region.size > 0 && shipped.workspace.has("default") && shipped.killSwitchPath.has(".runs/apply/KILL"), "the repository's examples were read");
  for (const [field, over] of [
    ["targets.DEV.region", { targets: { DEV: { accountId: "123456789012", region: [...shipped.region][0], backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev", canary: CANARY } } }],
    ["targets.DEV.workspace", { targets: { DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "default", canary: CANARY } } }],
    ["killSwitchPath", { killSwitchPath: ".runs/apply/KILL" }],
  ] as const) {
    const r = checkDraftContract(completeDraft(over));
    assert.equal(r.shape.ok, true, field);
    assert.equal(statusOf(r, field), "PRESENT", field);
    assert.match(r.inputs.find((x) => x.field === field)!.notice!, /equals a shipped example's default; confirm/);
    assert.equal(r.notices, 1, field);
    assert.equal(r.complete, true, field + ": a notice never counts against COMPLETE");
  }
  // A legitimate AWS Terraform draft with the usual defaults (us-east-1, default, .runs/apply/KILL) is COMPLETE, with three notices.
  const usual = checkDraftContract(completeDraft({ targets: { DEV: { accountId: "123456789012", region: "us-east-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "default", canary: CANARY } }, killSwitchPath: ".runs/apply/KILL" }));
  assert.equal(usual.complete, true, JSON.stringify(notReady(usual)));
  assert.equal(usual.notices, 3);
  assert.match(contractCheckLines(usual, "usual.json").join("\n"), /COMPLETE: every input is present and the shape is valid, with 3 notice\(s\) above/);
  // A valid CDK draft (the stack name is the backend, the workspace must be default, capabilities per environment) is COMPLETE.
  const cdk = checkDraftContract({
    ...chainDraft(), engine: "CDK", embedStateWrite: undefined,
    targets: {
      DEV: { accountId: "123456789012", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: [], canary: { resources: [{ type: "AWS::Logs::LogGroup", count: 1 }] } },
      QA: { accountId: "234567890123", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: [], canary: { resources: [{ type: "AWS::Logs::LogGroup", count: 1 }] } },
      PROD: { accountId: "345678901234", region: "us-east-1", backend: "PilotStack", workspace: "default", capabilities: ["CAPABILITY_IAM"], canary: { resources: [{ type: "AWS::Logs::LogGroup", count: 1 }] } },
    },
  });
  assert.equal(cdk.shape.ok, true, JSON.stringify(cdk.shape));
  assert.equal(cdk.complete, true, JSON.stringify(notReady(cdk)));
  assert.ok(cdk.notices >= 3, "the CDK defaults carry notices only");
  // The example values come from the files, not from this module: with no example files there is no notice on those fields.
  const none = shippedExampleValues(join(root, "no-examples"));
  assert.deepEqual([none.region.size, none.workspace.size, none.killSwitchPath.size], [0, 0, 0]);
  const fromNowhere = checkDraftContract(completeDraft({ killSwitchPath: ".runs/apply/KILL" }), none);
  assert.equal(statusOf(fromNowhere, "killSwitchPath"), "PRESENT");
  assert.equal(fromNowhere.notices, 0);
  // And a fixture example directory is honored.
  const dir = join(root, "examples");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "act-pilot-contract.fixture.example.json"), JSON.stringify({ targets: { DEV: { region: "ap-south-1", workspace: "copied" } }, killSwitchPath: "/stop" }));
  writeFileSync(join(dir, "act-pilot-contract.broken.example.json"), "{");
  const fixture = shippedExampleValues(dir);
  assert.deepEqual([[...fixture.region], [...fixture.workspace], [...fixture.killSwitchPath]], [["ap-south-1"], ["copied"], ["/stop"]]);
});

// --- the command ---------------------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[] };
const terminal = (tty = true): Terminal => {
  const out: string[] = [];
  return { stdinIsTTY: tty, stdoutIsTTY: tty, out, write: (text: string) => { out.push(text); }, ask: async () => "" };
};
async function cli(args: string[], tty = true) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const term = terminal(tty);
  const reports: { code: string }[] = [];
  // No contract path, pin, vault, identity or tool directory is handed in: the command must need none of them.
  const code = await runApplyCommand(args, { terminal: term, env: {}, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, report: (e) => { reports.push(e); } });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, reports };
}

test("./alz apply contract-check reads one draft file offline: exit 0 complete, exit 2 incomplete, exit 1 for a bad file, a person at a terminal always", async () => {
  const complete = await cli(["contract-check", "--file", file(completeDraft())]);
  assert.equal(complete.code, 0, complete.stderr);
  const report = JSON.parse(complete.stdout) as ContractCheckReport & { file: string };
  assert.equal(report.complete, true);
  assert.deepEqual(complete.reports.map((r) => r.code), ["CONTRACT_DRAFT_COMPLETE"]);
  assert.match(complete.term.out.join(""), /DRAFT CONTRACT CHECK \(offline; enables nothing, writes nothing\)/);
  assert.match(complete.term.out.join(""), /PRESENT\s+targets\.DEV\.accountId/);

  const example = await cli(["contract-check", "--file", join(ROOT, "config", "act-pilot-contract.aws-dev.example.json")]);
  assert.equal(example.code, 2, "placeholders remain: BLOCKED, nothing spent");
  assert.deepEqual(example.reports.map((r) => r.code), ["CONTRACT_DRAFT_INCOMPLETE"]);
  assert.match(example.term.out.join(""), /PLACEHOLDER\s+policyVersion/);
  assert.match(example.term.out.join(""), /PRESENT\s+killSwitchPath.*\[NOTICE: equals a shipped example's default/);
  assert.match(example.term.out.join(""), /INCOMPLETE: \d+ input\(s\) above are not ready/);

  const unreadable = await cli(["contract-check", "--file", file("{", "broken")]);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.stderr, /APPLY_INPUT_INVALID: --file cannot be read as a JSON file/);
  assert.equal((await cli(["contract-check", "--file", join(root, "absent.json")])).code, 1);
  // The flag is required, and no other flag exists.
  assert.equal((await cli(["contract-check"])).code, 1);
  assert.equal((await cli(["contract-check", "--file", file(completeDraft()), "--enable", "yes"])).code, 1);
  // A person at a terminal, as for every pilot command.
  const piped = await cli(["contract-check", "--file", file(completeDraft())], false);
  assert.equal(piped.code, 1);
  assert.match(piped.stderr, /HUMAN_TERMINAL_REQUIRED/);
});

test("the command enables nothing: the repository's contract (present or not) and config/ are unchanged, no pin appears, no file is written beside the draft, and the draft is unchanged", async () => {
  const path = file(completeDraft());
  const before = readFileSync(path, "utf8");
  const dir = join(path, "..");
  const listing = () => readFileSync(path, "utf8") + JSON.stringify(readdirSync(dir));
  // The repository may hold the owner's reviewed contract; the check must leave it, and the rest of config/, exactly as found.
  const contract = join(ROOT, "config", "act-pilot-contract.json");
  const repository = () => ({ contract: existsSync(contract) ? readFileSync(contract, "utf8") : null, config: readdirSync(join(ROOT, "config")).sort() });
  const first = listing();
  const repoBefore = repository();
  await cli(["contract-check", "--file", path]);
  // The check run on the repository's own contract path writes nothing either, whether a contract is there or not.
  await cli(["contract-check", "--file", contract]);
  assert.equal(listing(), first, "nothing written in the draft's folder");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(repository(), repoBefore, "the check never writes, creates or changes the contract or anything else in config/");
  assert.equal(existsSync(join(ROOT, "config", "act-pilot-contract.sha256")), false, "the retired pin is never recreated");
});

test("the Azure Bicep DEV example (owner decision E2) names every owner input, its resource group and location included, and a filled copy loads for Azure Bicep DEV", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config", "act-pilot-contract.azure-bicep-dev.example.json"), "utf8")) as Record<string, unknown>;
  const report = checkDraftContract(example);
  assert.deepEqual([report.provider, report.engine, report.enabledAsWritten, report.scope], ["AZURE", "BICEP", false, ["DEV"]]);
  assert.equal(report.complete, false);
  for (const field of ["policyVersion", "targets.DEV.tenantId", "targets.DEV.subscriptionId", "targets.DEV.resourceGroup", "targets.DEV.location", "approvers[0].id", "approvers[0].publicKeyPem"]) {
    assert.ok(notReady(report).includes(field), field + " is the owner's input");
  }
  // Filled with explicit fake values, it is an Azure Bicep DEV contract whose target binds the group and the location.
  const filled = JSON.parse(JSON.stringify(example)) as { enabled: boolean; policyVersion: string; targets: { DEV: Record<string, unknown> }; approvers: { id: string; publicKeyPem: string }[] };
  Object.assign(filled, { enabled: true, policyVersion: "policy-2026-10" });
  Object.assign(filled.targets.DEV, { tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", resourceGroup: "alz-pilot-dev", location: "eastus2" });
  filled.approvers = [{ ...filled.approvers[0]!, id: "owner", publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() }];
  const loaded = inspectPilotContract(filled);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.reason);
});
