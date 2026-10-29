import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { runEvidenceCommand } from "../src/cli/evidence.js";
import { observationSummaryOf } from "../src/evidence-runner/act.js";
import { spawnChild, type ChildRequest } from "../src/evidence-runner/child.js";
import { Journal, readJournal, type JournalIdentity } from "../src/evidence-runner/journal.js";
import {
  ACT, ARTIFACT, AWS_CONTRACT, artifactOf, CANARY, CANDIDATE, MUTATION_ENV, OPERATOR_SESSION, actRoot, applyScript, fakeSpawner, fixtureDeps, fixtureRoot, scriptedTerminal, validConfig,
  write, writeConfig, type FakeChild,
} from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the guided stages (S5) against a scripted fake `./alz apply`. The runner only sequences: these tests pin the
// order, that every child shares the person's terminal (the runner writes nothing to it), that the runner stops at the
// first refusal, never repeats a step that can change the account, and runs nothing without an enabled contract for the path
// or without delivered identities. No cloud, no engine, no real key: the "key file" is an empty file the runner never reads.

const C12 = CANDIDATE.slice(0, 12);
/** The person at the terminal answers the runner's own questions (file paths) only; the fake children ask nothing. */
const person = (root: string, ...extra: string[]) => scriptedTerminal([join(root, ".runs/keys/requester.pem"), ".runs/approvals/apply-1.json", "", ...extra]);

function actDeps(root: string, script: Record<string, FakeChild | number>, answers = person(root)) {
  const spawn = fakeSpawner(script);
  const deps = fixtureDeps(root, { env: { ...OPERATOR_SESSION, ...MUTATION_ENV, PATH: "/usr/bin" }, terminal: answers, spawn });
  return { deps, spawn, answers };
}

const PROPOSAL12 = createHash("sha256").update("proposal aws-terraform").digest("hex").slice(0, 12);
const GATES = ["apply contract-check", "apply identity-check", "apply preflight"];
const sub = (call: ChildRequest) => call.args.slice(0, 2).join(" ");
const journalOf = (root: string) => readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl"));

test("act:aws-terraform runs the documented ./alz apply steps in order, each at the person's terminal, and records what each producer wrote", async () => {
  const root = actRoot();
  const { deps, spawn, answers } = actDeps(root, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], deps), 0, deps.lines.join("\n"));
  assert.deepEqual(spawn.calls.map(sub), ["apply contract-check", "apply identity-check", "apply prepare", "apply qualify", "apply preflight", "apply seal", "apply apply", "apply observe"]);
  for (const call of spawn.calls) {
    assert.equal(call.io.kind, "TERMINAL", sub(call) + ": the child shares the person's terminal; the runner holds no pipe to its input");
    for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(name in call.env, false, name + " reached " + sub(call));
    assert.equal(call.env.ALZ_APPLY_AWS_ROLE_ARN, MUTATION_ENV.ALZ_APPLY_AWS_ROLE_ARN, "the federated identities are the person's to configure, and reach the driver");
  }
  const args = Object.fromEntries(spawn.calls.map((call) => [sub(call), call.args.slice(2)]));
  assert.deepEqual(args["apply identity-check"], ["--path", "aws-terraform", "--repository", "owner/repo", "--phase", "delivered"]);
  assert.deepEqual(args["apply prepare"], ["--environment", "DEV", "--project", "/srv/canary/aws"]);
  // qualify and seal take prepare's seal request; apply takes its apply request (environment, target and project only).
  const request = [".runs/pilot/DEV/request-aaaaaaaaaaaaaaaa.json", ".runs/pilot/DEV/manifest-aaaaaaaaaaaaaaaa.json", ".runs/pilot/DEV/apply-request-aaaaaaaaaaaaaaaa.json"];
  assert.deepEqual(args["apply qualify"], ["--request", request[0], "--manifest", request[1]]);
  assert.deepEqual(args["apply seal"], ["--request", request[0], "--manifest", request[1], "--requester", "owner", "--key", join(root, ".runs/keys/requester.pem")]);
  assert.deepEqual(args["apply apply"], ["--request", request[2], "--manifest", request[1], "--sealed", ".runs/apply/evidence/" + ARTIFACT + ".sealed", "--approval", ".runs/approvals/apply-1.json"]);
  // No flag pre-answers or forces anything, and no phrase appears in any argument.
  for (const call of spawn.calls) assert.ok(!call.args.some((arg) => /^--(yes|force|confirm|phrase|answer|approve|skip)/.test(arg) || /^(APPLY|APPROVE|LIVE|RUN PROJECT CODE|SEPARATED|CLEANUP) /.test(arg)), call.args.join(" "));
  // The runner asked the person only for the key file and the approval files, never a product phrase.
  assert.equal(answers.asked.length, 3);
  assert.ok(answers.asked.every((question) => /key file|approval file/.test(question)));
  const seal = journalOf(root).find((line) => line.step === "seal" && line.event === "finish")!;
  assert.deepEqual(seal.documents?.map((document) => document.name), ["review-bundle", "sealed-plan"]);
  const prepared = journalOf(root).find((line) => line.step === "prepare" && line.event === "finish")!;
  assert.deepEqual(prepared.documents?.map((document) => document.name), ["request", "apply-request", "manifest"]);
  for (const line of journalOf(root)) assert.ok(!JSON.stringify(line).includes("requester.pem"), "a key file's path is never journaled");
  for (const file of [join(root, ".runs/evidence/synthetic", C12, "journal.jsonl"), join(root, ".runs/evidence/synthetic", C12, "act-aws-terraform/stage.json")]) {
    assert.ok(!readFileSync(file, "utf8").includes(CANARY));
  }
});

test("act:aws-terraform stops at prepare when prepare wrote no apply request, and never hands the seal request to apply", async () => {
  const root = actRoot();
  const sealOnly = applyScript({
    "apply prepare": (request) => {
      write(request.cwd, ".runs/pilot/DEV/request-" + ARTIFACT.slice(0, 16) + ".json");
      write(request.cwd, ".runs/pilot/DEV/manifest-" + ARTIFACT.slice(0, 16) + ".json");
      return { exitCode: 0, signal: null };
    },
  });
  const { deps, spawn } = actDeps(root, sealOnly);
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], deps), 2, deps.lines.join("\n"));
  assert.match(deps.lines.join("\n"), /EVIDENCE_DOCUMENT_NOT_FOUND/);
  assert.equal(sub(spawn.calls.at(-1)!), "apply prepare", "nothing runs after a prepare that wrote no apply request");
});

test("a refusal at any step stops the sequence and is journaled; nothing after it starts", async () => {
  for (const [refusing, exitCode] of [["apply contract-check", 2], ["apply identity-check", 2], ["apply preflight", 2], ["apply qualify", 1]] as const) {
    const root = actRoot();
    const { deps, spawn } = actDeps(root, applyScript({ [refusing]: exitCode }));
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], deps), 2, refusing);
    assert.equal(sub(spawn.calls.at(-1)!), refusing, refusing + " was the last child");
    assert.ok(!spawn.calls.some((call) => sub(call) === "apply seal" || sub(call) === "apply apply"), refusing);
    const finished = journalOf(root).filter((line) => line.event === "finish" && line.stage === "act:aws-terraform");
    const last = finished.at(-1)!;
    assert.deepEqual([last.step, last.outcome, last.code], ["act:aws-terraform", exitCode === 2 ? "BLOCKED" : "FAIL", exitCode === 2 ? "CHILD_REFUSED" : "CHILD_FAILED"], refusing);
  }
});

test("no delivered identities: identity-check --phase delivered refuses, and nothing is prepared, sealed or applied", async () => {
  const root = actRoot();
  const { deps, spawn } = actDeps(root, applyScript({ "apply identity-check": 2 }));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], deps), 2);
  assert.deepEqual(spawn.calls.map(sub), ["apply contract-check", "apply identity-check"]);
});

test("without an enabled contract for this path, or without a terminal, or without the act targets, the stage starts no child", async () => {
  const cases: [unknown, Record<string, unknown> | undefined, boolean, RegExp][] = [
    [undefined, ACT, true, /ACT_DISABLED/],
    [{ ...AWS_CONTRACT, enabled: false }, ACT, true, /ACT_DISABLED/],
    [{ ...AWS_CONTRACT, authorize: {} }, ACT, true, /ACT_DISABLED/],
    [{ ...AWS_CONTRACT, authorize: { DEV: ["CLEANUP"] } }, ACT, true, /ACT_NOT_AUTHORIZED/],
    [{ ...AWS_CONTRACT, engine: "CDK" }, ACT, true, /CONTRACT_NOT_FOR_PATH/],
    [{ ...AWS_CONTRACT, provider: "AZURE" }, ACT, true, /CONTRACT_NOT_FOR_PATH/],
    [AWS_CONTRACT, undefined, true, /OWNER_INPUT_ACT_TARGETS/],
    [AWS_CONTRACT, ACT, false, /EVIDENCE_TERMINAL_REQUIRED/],
  ];
  for (const [contract, act, tty, expected] of cases) {
    const root = fixtureRoot(contract);
    writeConfig(root, validConfig({ aws: undefined, azure: undefined, ...(act ? { act } : {}) }));
    const spawn = fakeSpawner(applyScript());
    const deps = fixtureDeps(root, { spawn, terminal: scriptedTerminal([], tty) });
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], deps), 2, String(expected));
    assert.match(deps.lines.join("\n"), expected);
    assert.deepEqual(spawn.calls, [], String(expected));
  }
});

test("resume skips passed steps and never repeats a step that can change the account: a spent apply, or one that never finished, is not started again", async () => {
  const root = actRoot();
  const first = actDeps(root, applyScript({ "apply apply": 3 }));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], first.deps), 2);
  assert.equal(first.spawn.calls.filter((call) => sub(call) === "apply apply").length, 1);
  const second = actDeps(root, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], second.deps), 2);
  assert.deepEqual(second.spawn.calls.map(sub), GATES, "only the read-only gates run again (review N3); passed steps are reused and the spent apply is never started again");
  assert.deepEqual(second.answers.asked, [], "nothing is asked for a step that will not run");
  assert.match(second.deps.lines.join("\n"), /EVIDENCE_STEP_NOT_REPEATED — apply ended FAIL CHILD_SPENT earlier in this run/);
  // An apply that was started and never finished (the runner was killed) is not started again either.
  const killed = actRoot();
  const upToApply = actDeps(killed, applyScript({ "apply apply": () => { throw new Error("killed"); } }));
  await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], upToApply.deps);
  const file = join(killed, ".runs/evidence/synthetic", C12, "journal.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  // Drop the apply's finish and the stage's finish, as if the runner had been killed while the apply ran.
  writeFileSync(file, lines.filter((line) => !/"step":"apply","event":"finish"|"step":"act:aws-terraform","event":"finish"/.test(line)).join("\n") + "\n");
  const head = readJournal(file)[0];
  const identity: JournalIdentity = { sourceCommit: head.sourceCommit, configSha256: head.configSha256, targetHardwareId: head.targetHardwareId, label: head.label, host: head.host, identityHash: head.identityHash };
  assert.equal(new Journal(file, identity).record("act:aws-terraform", "apply").status, "INTERRUPTED");
  const resumed = actDeps(killed, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], resumed.deps), 2);
  assert.ok(!resumed.spawn.calls.some((call) => sub(call) === "apply apply"));
  assert.match(resumed.deps.lines.join("\n"), /apply started and never finished earlier in this run/);
});

test("an empty answer for the key file leaves the seal unstarted, so it can still run on the next attempt", async () => {
  const root = actRoot();
  const first = actDeps(root, applyScript(), scriptedTerminal([""]));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], first.deps), 2);
  assert.match(first.deps.lines.join("\n"), /EVIDENCE_FILE_REQUIRED/);
  assert.ok(!first.spawn.calls.some((call) => sub(call) === "apply seal"));
  assert.equal(journalOf(root).some((line) => line.step === "seal"), false, "the seal was never journaled as started");
  const second = actDeps(root, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], second.deps), 0, second.deps.lines.join("\n"));
  assert.deepEqual(second.spawn.calls.map(sub), ["apply contract-check", "apply identity-check", "apply preflight", "apply seal", "apply apply", "apply observe"],
    "the read-only gates run again; prepare, qualify and the other passed steps are not repeated");
});

test("cleanup:aws-terraform needs the act stage done, then runs the cleanup sequence and moves the live record out of the checkout unchanged", async () => {
  const root = actRoot();
  const early = actDeps(root, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], early.deps), 2);
  assert.match(early.deps.lines.join("\n"), /ACT_STAGE_NOT_DONE/);
  assert.deepEqual(early.spawn.calls, []);
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(root, applyScript()).deps), 0);
  const answers = scriptedTerminal([join(root, ".runs/keys/requester.pem"), ".runs/approvals/cleanup-1.json", ""]);
  const cleanup = actDeps(root, applyScript(), answers);
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], cleanup.deps), 0, cleanup.deps.lines.join("\n"));
  assert.deepEqual(cleanup.spawn.calls.map(sub), ["apply contract-check", "apply identity-check", "apply observe", "apply propose-cleanup", "apply cleanup", "apply verify-cleanup", "apply report", "apply record-live"],
    "the cleanup re-checks what cleanup requires (contract, delivered identities, kill switch in process), never apply readiness");
  const args = Object.fromEntries(cleanup.spawn.calls.map((call) => [sub(call), call.args.slice(2)]));
  assert.deepEqual(args["apply cleanup"], ["--proposal", ".runs/apply/cleanup/" + PROPOSAL12 + ".cleanup-proposal.json", "--request", ".runs/pilot/DEV/apply-request-aaaaaaaaaaaaaaaa.json",
    "--manifest", ".runs/pilot/DEV/manifest-aaaaaaaaaaaaaaaa.json", "--sealed", ".runs/apply/evidence/" + ARTIFACT + ".sealed", "--approval", ".runs/approvals/cleanup-1.json"]);
  assert.equal(existsSync(join(root, "config/acceptance/evidence/aws-terraform-execute-dev-aaaaaaaaaaaa.json")), false, "the checkout is left clean");
  const record = journalOf(root).find((line) => line.step === "record-live" && line.event === "finish")!;
  assert.equal(record.documents?.[0].path, ".runs/evidence/synthetic/" + C12 + "/cleanup-aws-terraform/aws-terraform-execute-dev-aaaaaaaaaaaa.json");
  assert.match(readFileSync(join(root, record.documents![0].path), "utf8"), /"step":"execute"/);
});

test("#359 review N1, #360 review B1: on every path a cleanup stage is PASS only when the lifecycle report's leftovers stage passed; INCONCLUSIVE, NOT_RUN, FAIL or an unreadable report is BLOCKED LEFTOVERS_NOT_VERIFIED, never shown as a pass", async () => {
  const PATHS = [
    ["aws-terraform", "AWS", "TERRAFORM"], ["aws-cdk", "AWS", "CDK"], ["azure-terraform", "AZURE", "TERRAFORM"], ["azure-bicep", "AZURE", "BICEP"],
    ["gcp-terraform", "GCP", "TERRAFORM"], ["gcp-api", "GCP", "GCP_API"],
  ] as const;
  const lifecycle = (path: string, status: string | undefined) => (request: ChildRequest) => {
    const a12 = artifactOf(path).slice(0, 12);
    const p12 = createHash("sha256").update("proposal " + path).digest("hex").slice(0, 12);
    write(request.cwd, ".runs/apply/reports/" + a12 + "-lifecycle-" + p12 + ".json", status === undefined ? "not json" : JSON.stringify({ reportKind: "ACT_LIFECYCLE", stages: { leftovers: { status } } }));
    return { exitCode: 0, signal: null };
  };
  const run = async (path: string, provider: string, engine: string, status: string | undefined) => {
    const root = actRoot({ ...AWS_CONTRACT, provider, engine });
    writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: { repository: "owner/repo", paths: { [path]: { project: "/srv/canary/" + path, requesterId: "owner" } } } }));
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:" + path], actDeps(root, applyScript({}, { path })).deps), 0, path);
    const answers = scriptedTerminal([join(root, ".runs/keys/requester.pem"), ".runs/approvals/cleanup-1.json", ""]);
    const cleanup = actDeps(root, applyScript({ "apply report": lifecycle(path, status) }, { path }), answers);
    const code = await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:" + path], cleanup.deps);
    return { code, out: cleanup.deps.lines.join("\n"), calls: cleanup.spawn.calls.map(sub) };
  };
  for (const [path, provider, engine] of PATHS) {
    const clean = await run(path, provider, engine, "PASS");
    assert.equal(clean.code, 0, path + ": " + clean.out);
    assert.match(clean.out, /CLEANED_AND_RECORDED/, path);
    for (const status of ["INCONCLUSIVE", "NOT_RUN", "FAIL", undefined]) {
      const label = path + " " + String(status);
      const refused = await run(path, provider, engine, status);
      assert.equal(refused.code, 2, label);
      assert.match(refused.out, /LEFTOVERS_NOT_VERIFIED/, label);
      assert.doesNotMatch(refused.out, /CLEANED_AND_RECORDED/, label);
      assert.match(refused.out, provider === "GCP" ? /"no strays" is unproven/ : /the independent leftover check is not complete/, label);
      assert.ok(refused.calls.includes("apply verify-cleanup") && refused.calls.includes("apply record-live"), label + ": the cleanup was verified and the live record kept");
    }
  }
});

test("#360 review N1: on every path act:<path> is PASS only for a VERIFIED observation; FAILED, INCONCLUSIVE (with the GCP sweep's reason), PARTIAL or an unreadable summary is BLOCKED, and a rerun observes again without repeating the seal or the apply", async () => {
  const PATHS = [
    ["aws-terraform", "AWS", "TERRAFORM"], ["aws-cdk", "AWS", "CDK"], ["azure-terraform", "AZURE", "TERRAFORM"], ["azure-bicep", "AZURE", "BICEP"],
    ["gcp-terraform", "GCP", "TERRAFORM"], ["gcp-api", "GCP", "GCP_API"],
  ] as const;
  const observe = (path: string, summary: Record<string, unknown> | undefined) => (request: ChildRequest) => {
    write(request.cwd, ".runs/apply/reports/" + artifactOf(path).slice(0, 12) + "-observation.json", summary === undefined ? "not json" : JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", artifactSha256: artifactOf(path), ...summary }));
    return { exitCode: 0, signal: null };
  };
  const rootFor = (path: string, provider: string, engine: string) => {
    const root = actRoot({ ...AWS_CONTRACT, provider, engine });
    writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: { repository: "owner/repo", paths: { [path]: { project: "/srv/canary/" + path, requesterId: "owner" } } } }));
    return root;
  };
  const cases: [string, Record<string, unknown> | undefined, RegExp, RegExp][] = [
    ["FAILED", { verdict: "FAILED", inventory: "COMPLETE", sweepNotListing: [] }, /OBSERVATION_FAILED/, /independent observation is FAILED/],
    ["INCONCLUSIVE", { verdict: "INCONCLUSIVE", inventory: "INCOMPLETE", sweepNotListing: [] }, /OBSERVATION_INCONCLUSIVE/, /a check could not decide/],
    ["PARTIAL", { verdict: "PARTIAL", inventory: "NOT_AVAILABLE", sweepNotListing: [] }, /OBSERVATION_NOT_VERIFIED/, /PARTIAL, not VERIFIED/],
    ["unreadable", undefined, /OBSERVATION_NOT_VERIFIED/, /UNREADABLE, not VERIFIED/],
  ];
  for (const [path, provider, engine] of PATHS) {
    const verified = rootFor(path, provider, engine);
    const ok = actDeps(verified, applyScript({}, { path }));
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:" + path], ok.deps), 0, path + ": " + ok.deps.lines.join("\n"));
    assert.match(ok.deps.lines.join("\n"), /APPLIED_AND_OBSERVED/, path);
    const all = provider === "GCP"
      ? [...cases, ["INCONCLUSIVE, sweep", { verdict: "INCONCLUSIVE", inventory: "INCOMPLETE", sweepNotListing: ["projects/p/topics/alz-act-dev1-0123456789ab"] }, /OBSERVATION_INCONCLUSIVE/, /did not list the run's own resource \(projects\/p\/topics\/alz-act-dev1-0123456789ab\)[\s\S]*indexes new resources with a delay[\s\S]*GF3's fail-closed signal/] as [string, Record<string, unknown>, RegExp, RegExp]]
      : cases;
    for (const [label, summary, code, words] of all) {
      const root = rootFor(path, provider, engine);
      const first = actDeps(root, applyScript({ "apply observe": observe(path, summary) }, { path }));
      assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:" + path], first.deps), 2, path + " " + label);
      const out = first.deps.lines.join("\n");
      assert.match(out, code, path + " " + label);
      assert.match(out, words, path + " " + label);
      assert.doesNotMatch(out, /APPLIED_AND_OBSERVED/, path + " " + label);
      assert.match(out, /rerun --stage act:/, path + " " + label);
      // The rerun observes again (read-only) and never seals or applies again; once the observation is VERIFIED the stage passes.
      const again = actDeps(root, applyScript({}, { path }), scriptedTerminal([""]));
      assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:" + path], again.deps), 0, path + " " + label + ": " + again.deps.lines.join("\n"));
      const calls = again.spawn.calls.map(sub);
      assert.ok(calls.includes("apply observe"), path + " " + label);
      assert.ok(!calls.includes("apply seal") && !calls.includes("apply apply") && !calls.includes("apply prepare"), path + " " + label + ": " + calls.join(", "));
    }
  }
});

test("#362 review N1: the observation summary must be this stage's artifact's: another artifact's VERIFIED summary, or one naming another artifact inside, is refused and the stage is BLOCKED", async () => {
  const other = "f".repeat(64);
  const cases: [string, (request: ChildRequest) => { exitCode: number; signal: null }][] = [
    // The reviewer's probe: a VERIFIED summary for another artifact, under that artifact's own name.
    ["another artifact's file", (request) => { write(request.cwd, ".runs/apply/reports/ffffffffffff-observation.json", JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", artifactSha256: other, verdict: "VERIFIED", inventory: "COMPLETE", sweepNotListing: [] })); return { exitCode: 0, signal: null }; }],
    // This artifact's file name, but the summary inside names another artifact.
    ["another artifact inside", (request) => { write(request.cwd, ".runs/apply/reports/" + ARTIFACT.slice(0, 12) + "-observation.json", JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", artifactSha256: other, verdict: "VERIFIED", inventory: "COMPLETE", sweepNotListing: [] })); return { exitCode: 0, signal: null }; }],
    ["no artifact inside", (request) => { write(request.cwd, ".runs/apply/reports/" + ARTIFACT.slice(0, 12) + "-observation.json", JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", verdict: "VERIFIED", inventory: "COMPLETE", sweepNotListing: [] })); return { exitCode: 0, signal: null }; }],
  ];
  for (const [label, observeChild] of cases) {
    const root = actRoot();
    const run = actDeps(root, applyScript({ "apply observe": observeChild }));
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], run.deps), 2, label);
    const out = run.deps.lines.join("\n");
    assert.match(out, /OBSERVATION_NOT_VERIFIED[\s\S]*NOT_THIS_ARTIFACT, not VERIFIED: the observation summary is not this stage's/, label);
    assert.doesNotMatch(out, /APPLIED_AND_OBSERVED/, label);
  }
  // A summary whose bytes no longer hash to what the journal recorded when the step collected it is refused too.
  const root = fixtureRoot();
  write(root, ".runs/apply/reports/" + ARTIFACT.slice(0, 12) + "-observation.json", JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", artifactSha256: ARTIFACT, verdict: "VERIFIED", inventory: "COMPLETE", sweepNotListing: [] }));
  const relative = ".runs/apply/reports/" + ARTIFACT.slice(0, 12) + "-observation.json";
  const sealed = ".runs/apply/evidence/" + ARTIFACT + ".sealed";
  const actual = createHash("sha256").update(readFileSync(join(root, relative))).digest("hex");
  assert.equal(observationSummaryOf(root, { name: "observation-summary", path: relative, sha256: actual }, sealed).verdict, "VERIFIED");
  assert.equal(observationSummaryOf(root, { name: "observation-summary", path: relative, sha256: "0".repeat(64) }, sealed).verdict, "NOT_THIS_ARTIFACT");
  assert.equal(observationSummaryOf(root, { name: "observation-summary", path: relative, sha256: actual }, ".runs/apply/evidence/" + "e".repeat(64) + ".sealed").verdict, "NOT_THIS_ARTIFACT");
  assert.equal(observationSummaryOf(root, { name: "observation-summary", path: relative, sha256: actual }, undefined).verdict, "UNREADABLE");
});

test("#360 review N2: a run whose cleanup is BLOCKED after the live record was kept says so on its last line, never \"no evidence was produced\"", async () => {
  const root = actRoot();
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(root, applyScript()).deps), 0);
  const report = (request: ChildRequest) => {
    write(request.cwd, ".runs/apply/reports/" + ARTIFACT.slice(0, 12) + "-lifecycle-" + PROPOSAL12 + ".json", JSON.stringify({ reportKind: "ACT_LIFECYCLE", stages: { leftovers: { status: "INCONCLUSIVE" } } }));
    return { exitCode: 0, signal: null };
  };
  const cleanup = actDeps(root, applyScript({ "apply report": report }), scriptedTerminal([join(root, ".runs/keys/requester.pem"), ".runs/approvals/cleanup-1.json", ""]));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], cleanup.deps), 2);
  const last = cleanup.deps.lines.at(-1)!;
  assert.doesNotMatch(last, /no evidence was produced/);
  assert.match(last, new RegExp("^BLOCKED: cleanup:aws-terraform did not pass, but its live record was kept \\(\\.runs/evidence/synthetic/" + C12 + "/cleanup-aws-terraform/aws-terraform-execute-dev-aaaaaaaaaaaa\\.json\\)"));
});

test("a child of a guided stage reads the person's own terminal: the production spawner inherits stdin, it is never a pipe from the runner", async () => {
  const report = join(fixtureRoot(), "stdin.json");
  // The child reports the device and inode of its standard input; the runner's own standard input must be the same file.
  const script = "const s=require('fs').fstatSync(0);require('fs').writeFileSync(" + JSON.stringify(report) + ",JSON.stringify({dev:s.dev,ino:s.ino,fifo:s.isFIFO()}))";
  const result = await spawnChild({ command: process.execPath, args: ["-e", script], cwd: dirname(report), env: { PATH: process.env.PATH ?? "" }, io: { kind: "TERMINAL" } });
  assert.equal(result.exitCode, 0);
  const child = JSON.parse(readFileSync(report, "utf8")) as { dev: number; ino: number };
  const parent = fstatSync(0);
  assert.deepEqual([child.dev, child.ino], [parent.dev, parent.ino], "the child's stdin is the runner's own (the person's terminal), not a new pipe");
});

test("GCP API-native is guided behind the same gates as every path (INT-2); recovery asks for both sealed plans and runs record-recovery once", async () => {
  // Its contract committed but no act.paths entry: blocked on the owner's input, never NOT_AVAILABLE, and nothing runs.
  const gcpApi = actRoot({ ...AWS_CONTRACT, provider: "GCP", engine: "GCP_API" });
  const noTarget = actDeps(gcpApi, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:gcp-api"], noTarget.deps), 2);
  assert.match(noTarget.deps.lines.join("\n"), /OWNER_INPUT_ACT_TARGETS/);
  assert.doesNotMatch(noTarget.deps.lines.join("\n"), /NOT_AVAILABLE/);
  assert.deepEqual(noTarget.spawn.calls, []);
  // Another path's contract (AWS Terraform) never runs it: the committed contract must name GCP GCP_API.
  const otherContract = actDeps(actRoot(), applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:gcp-api"], otherContract.deps), 2);
  assert.match(otherContract.deps.lines.join("\n"), /CONTRACT_NOT_FOR_PATH/);
  assert.deepEqual(otherContract.spawn.calls, []);
  const root = actRoot();
  write(root, ".runs/apply/evidence/one.sealed");
  write(root, ".runs/apply/evidence/two.sealed");
  const answers = scriptedTerminal([join(root, ".runs/apply/evidence/one.sealed"), join(root, ".runs/apply/evidence/two.sealed")]);
  const recovery = actDeps(root, applyScript({ "apply record-recovery": (request) => { write(request.cwd, ".runs/release/preview/act-run-recovery-aaaaaaaaaaaa.json"); return { exitCode: 0, signal: null }; } }), answers);
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "recovery"], recovery.deps), 0, recovery.deps.lines.join("\n"));
  assert.deepEqual(recovery.spawn.calls[0].args, ["apply", "record-recovery", "--sealed", join(root, ".runs/apply/evidence/one.sealed"), "--resumed", join(root, ".runs/apply/evidence/two.sealed"), "--target-hardware-id", "owner-mac-01"]);
  const again = actDeps(root, applyScript());
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "recovery"], again.deps), 0);
  assert.deepEqual(again.spawn.calls, [], "a recorded recovery is never recorded twice");
});

test("on resume the read-only gates run again: identities that are no longer delivered stop the stage before anything else (review N3)", async () => {
  const root = actRoot();
  // The first run stops at the approval (no approval file named), after prepare, qualify and seal passed.
  const first = actDeps(root, applyScript(), scriptedTerminal([join(root, ".runs/keys/requester.pem"), ""]));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], first.deps), 2);
  assert.ok(first.spawn.calls.some((call) => sub(call) === "apply seal"));
  // Hours later the delivery has ended: identity-check --phase delivered refuses, and nothing after it starts.
  const later = actDeps(root, applyScript({ "apply identity-check": 2 }));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], later.deps), 2);
  assert.deepEqual(later.spawn.calls.map(sub), ["apply contract-check", "apply identity-check"]);
  assert.deepEqual(later.answers.asked, [], "no approval is asked for while the identities are not delivered");
  const identity = journalOf(root).filter((line) => line.step === "identity-check" && line.event === "finish").map((line) => line.outcome);
  assert.deepEqual(identity, ["PASS", "BLOCKED"], "each invocation journals its own identity check");
});

test("N6: the cleanup stage never runs apply preflight, so a qualification older than 30 days does not keep resources in the account; cleanup's own refusals still stop it", async () => {
  const root = actRoot();
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(root, applyScript()).deps), 0);
  // Weeks later: apply preflight would now report the qualification stale (exit 2). The cleanup does not ask it.
  const key = join(root, ".runs/keys/requester.pem");
  const stale = actDeps(root, applyScript({ "apply preflight": 2 }), scriptedTerminal([key, ".runs/approvals/cleanup-1.json", ""]));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], stale.deps), 0, stale.deps.lines.join("\n"));
  assert.ok(!stale.spawn.calls.some((call) => sub(call) === "apply preflight"), "apply readiness is not a cleanup gate");
  assert.ok(stale.spawn.calls.some((call) => sub(call) === "apply cleanup"));
  // When ./alz apply cleanup itself refuses (exit 2, nothing spent), the stage stops there and journals it.
  const other = actRoot();
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(other, applyScript()).deps), 0);
  const refused = actDeps(other, applyScript({ "apply cleanup": 2 }), scriptedTerminal([join(other, ".runs/keys/requester.pem"), ".runs/approvals/cleanup-1.json", ""]));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], refused.deps), 2);
  assert.equal(sub(refused.spawn.calls.at(-1)!), "apply cleanup");
  assert.match(refused.deps.lines.join("\n"), /cleanup:aws-terraform: CHILD_REFUSED/);
  // Delivered identities that are gone also stop it, as cleanup itself would refuse them.
  const third = actRoot();
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(third, applyScript()).deps), 0);
  const undelivered = actDeps(third, applyScript({ "apply identity-check": 2 }));
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], undelivered.deps), 2);
  assert.deepEqual(undelivered.spawn.calls.map(sub), ["apply contract-check", "apply identity-check"]);
});

test("N6: the kill switch stops the cleanup stage before anything is observed, proposed or asked; an unreadable switch counts as on", async () => {
  for (const contract of [AWS_CONTRACT, { ...AWS_CONTRACT, killSwitchPath: undefined }]) {
    const root = actRoot(contract);
    if (contract.killSwitchPath) {
      assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(root, applyScript()).deps), 0);
      write(root, ".runs/apply/KILL", "");
    } else {
      // No readable switch: write the act stage's records with a contract that has one, then remove it from the contract.
      writeFileSync(join(root, "config/act-pilot-contract.json"), JSON.stringify(AWS_CONTRACT));
      assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], actDeps(root, applyScript()).deps), 0);
      writeFileSync(join(root, "config/act-pilot-contract.json"), JSON.stringify({ ...AWS_CONTRACT, killSwitchPath: undefined }));
    }
    const stopped = actDeps(root, applyScript());
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], stopped.deps), 2);
    assert.deepEqual(stopped.spawn.calls.map(sub), ["apply contract-check", "apply identity-check"]);
    assert.deepEqual(stopped.answers.asked, []);
    assert.match(stopped.deps.lines.join("\n"), /cleanup:aws-terraform: KILL_SWITCH_ON/);
  }
});
