import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const completeDraft = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: false, provider: "AWS", engine: "TERRAFORM", policyVersion: "2026-10-11.1", enabledEnvironments: ["DEV"],
  targets: { DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev" } },
  requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 30,
  approvers: [{ id: "pilot-owner", publicKeyPem: keys.alice.pub, environments: ["DEV"] }],
  killSwitchPath: ".runs/apply/STOP-DEV", ...over,
});
/** The three-stage chain with two production approvers. */
const chainDraft = () => ({
  ...completeDraft(), enabledEnvironments: undefined,
  targets: {
    DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev" },
    QA: { accountId: "234567890123", region: "eu-central-1", backend: "fixture-qa-state/pilot/qa.tfstate", workspace: "pilot-qa" },
    PROD: { accountId: "345678901234", region: "eu-central-1", backend: "fixture-prod-state/pilot/prod.tfstate", workspace: "pilot-prod" },
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
    "targets.DEV.accountId", "targets.DEV.region", "targets.DEV.backend", "targets.DEV.workspace", "requiredApprovals.DEV",
    "maxApprovalAgeMinutes", "approvers[0].id", "approvers[0].publicKeyPem", "approvers[0].environments", "killSwitchPath",
  ]);
  assert.ok(report.inputs.every((x) => x.input.length > 0 && x.status === "PRESENT"));
  // The inputs that are not contract fields are listed with where they are checked instead, naming the engine's four identities.
  assert.match(report.outsideContract[0].input, /DISCOVERY, STATE, STATE_WRITE, APPLY/);
  assert.ok(report.outsideContract.some((x) => /execution host/.test(x.input)) && report.outsideContract.some((x) => /cleanup owner/.test(x.input)));
  assert.ok(report.guarantees.some((line) => /never enables ACT and never writes config\/act-pilot-contract.sha256/.test(line)));
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
    // The example's region, workspace and kill switch path copied verbatim are not decisions: EXAMPLE, never PRESENT.
    for (const field of ["targets.DEV.region", "targets.DEV.workspace", "killSwitchPath"]) assert.equal(statusOf(report, field), "EXAMPLE", name + " " + field);
    assert.ok(report.inputs.filter((x) => x.status !== "PRESENT").length >= 8, name + ": every placeholder is listed, not only the first");
    if (Object.hasOwn(example, "EXAMPLE")) assert.equal(statusOf(report, "EXAMPLE"), "PLACEHOLDER", name + ": the example marker is named");
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

test("a region, workspace or kill switch path copied verbatim from a shipped example is EXAMPLE, read from the example files themselves", () => {
  const shipped = shippedExampleValues();
  assert.ok(shipped.region.size > 0 && shipped.workspace.has("default") && shipped.killSwitchPath.has(".runs/apply/KILL"), "the repository's examples were read");
  for (const [field, over] of [
    ["targets.DEV.region", { targets: { DEV: { accountId: "123456789012", region: [...shipped.region][0], backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "pilot-dev" } } }],
    ["targets.DEV.workspace", { targets: { DEV: { accountId: "123456789012", region: "eu-central-1", backend: "fixture-dev-state/pilot/dev.tfstate", workspace: "default" } } }],
    ["killSwitchPath", { killSwitchPath: ".runs/apply/KILL" }],
  ] as const) {
    const r = checkDraftContract(completeDraft(over));
    assert.equal(r.shape.ok, true, field + ": the validator accepts the value; the kit is what refuses the copy");
    assert.equal(statusOf(r, field), "EXAMPLE", field);
    assert.match(r.inputs.find((x) => x.field === field)!.detail!, /copied verbatim from a shipped example/);
    assert.equal(r.complete, false, field);
  }
  // The example values come from the files, not from this module: with no example files nothing is EXAMPLE on those fields.
  const none = shippedExampleValues(join(root, "no-examples"));
  assert.deepEqual([none.region.size, none.workspace.size, none.killSwitchPath.size], [0, 0, 0]);
  const fromNowhere = checkDraftContract(completeDraft({ killSwitchPath: ".runs/apply/KILL" }), none);
  assert.equal(statusOf(fromNowhere, "killSwitchPath"), "PRESENT");
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
  assert.match(example.term.out.join(""), /EXAMPLE\s+killSwitchPath/);
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

test("the command enables nothing: the repository's shipped pin stays empty, no file is written beside the draft, and the draft is unchanged", async () => {
  const path = file(completeDraft());
  const before = readFileSync(path, "utf8");
  const dir = join(path, "..");
  const listing = () => readFileSync(path, "utf8") + JSON.stringify(readdirSync(dir));
  const first = listing();
  await cli(["contract-check", "--file", path]);
  assert.equal(listing(), first, "nothing written in the draft's folder");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readFileSync(join(ROOT, "config", "act-pilot-contract.sha256"), "utf8").trim(), "", "the shipped pin is empty and the check never writes it");
});
