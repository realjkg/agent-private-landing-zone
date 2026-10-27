import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPilotContract } from "../src/apply/contract.js";
import { reserveArtifact } from "../src/apply/ledger.js";
import type { PilotContract } from "../src/apply/types.js";
import { REMOVAL_RECORD_SUFFIX, authorizeRemoval, removeWorkspace, type WorkspaceRemovalInput, type WorkspaceRemovalRecord } from "../src/apply/workspace-removal.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { targetString } from "../src/cli/teardown-driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  NOW, POLICY, SOURCE_COMMIT, awsContractJson, awsIdentityEnv, awsTargetOf, behave as behaveIn, behaveAwsReads, installFakeAwsReads, installFakeTerraform, keys, pinPathOf,
  stateResource, testFixtureForgeQualificationEvidence, writePinnedContract, writeProject, requesterArgs, type Project,
} from "./helpers/apply-fixtures.js";

// Removing a run's generated working files (owner decision "Unpin the ACT decision", item 2 (b), #39): `./alz apply remove-workspace`
// deletes the run's preparation files and the driver's abandoned scratch directories (work copies with .terraform, decrypted plans,
// local state copies), writes a removal record with paths, sizes and plan hashes into the evidence directory, and keeps every evidence,
// ledger, sealed and log record. It refuses while a run is in progress, refuses links and paths outside the product's folders, and
// resumes an interrupted removal. Local files and a fake engine only: SYNTHETIC evidence.

const root = mkdtempSync(join(tmpdir(), "alz-ws-removal-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-ws-removal-tf-"));
const awsToolDir = mkdtempSync(join(tmpdir(), "alz-ws-removal-aws-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
process.chdir(root);
test.after(() => { removeTree(root); removeTree(toolDir); removeTree(awsToolDir); });
installFakeTerraform(toolDir);
installFakeAwsReads(awsToolDir);
let counter = 0;
const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
const KILL = join(root, "KILL");
const ARTIFACT = "a".repeat(64);
const MANIFEST = "b".repeat(64);
const TAG = MANIFEST.slice(0, 16);
const HOUR = 60 * 60 * 1000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const contract = (): PilotContract => {
  const path = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(path, awsContractJson(KILL));
  return loadPilotContract(path, pinPathOf(path)) as PilotContract;
};

/** One run's leftovers: its preparation files, another run's, a stale scratch directory with a plan, .terraform and a state copy, a young one, and the evidence. */
function layout() {
  const base = fresh("ws");
  const preparation = join(base, "pilot");
  const env = join(preparation, "DEV");
  mkdirSync(env, { recursive: true });
  for (const name of ["request-" + TAG + ".json", "manifest-" + TAG + ".json", "preparation-" + TAG + ".json", "manifest-" + TAG + ".json.partial-4242"]) writeFileSync(join(env, name), "{\"name\":\"" + name + "\"}\n");
  writeFileSync(join(env, "request-cccccccccccccccc.json"), "{}\n");
  const scratch = join(base, "scratch");
  const stale = join(scratch, "alz-preview-old1");
  mkdirSync(join(stale, "work", ".terraform", "providers"), { recursive: true });
  writeFileSync(join(stale, "alz-apply.tfplan"), "PLAN-BYTES");
  writeFileSync(join(stale, "work", ".terraform", "terraform.tfstate"), "{\"backend\":{}}");
  writeFileSync(join(stale, "work", "main.tf"), "resource \"x\" \"y\" {}\n");
  const old = new Date(NOW.getTime() - 2 * HOUR);
  utimesSync(stale, old, old);
  const young = join(scratch, "alz-preview-young");
  mkdirSync(young, { recursive: true });
  const unrelated = join(scratch, "someone-else");
  mkdirSync(unrelated);
  utimesSync(unrelated, old, old);
  const evidence = join(base, "evidence");
  mkdirSync(evidence);
  for (const name of [ARTIFACT + ".apply.json", ARTIFACT + ".sealed.json", ARTIFACT + ".blueprint.json", "apply.log"]) writeFileSync(join(evidence, name), "record");
  const input: WorkspaceRemovalInput = {
    contract: contract(), environment: "DEV", artifactSha256: ARTIFACT, manifestHash: MANIFEST, operatorId: "operator.fixture", preparationDir: preparation, scratchParent: scratch,
    evidenceDir: evidence, now: NOW,
  };
  return { base, env, stale, young, unrelated, evidence, input };
}
const recordOf = (evidence: string): WorkspaceRemovalRecord => JSON.parse(readFileSync(join(evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX), "utf8")) as WorkspaceRemovalRecord;

test("remove-workspace removes the run's preparation files and stale scratch (with its plan, .terraform and state copy), records paths, sizes and the plan's SHA-256, and keeps evidence, other runs' files, young scratch and anything not the driver's", async () => {
  const l = layout();
  const result = await removeWorkspace(l.input);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.resumed, false);
  assert.deepEqual(readdirSync(l.env), ["request-cccccccccccccccc.json"], "only this run's preparation files went");
  assert.ok(!existsSync(l.stale), "the stale scratch directory went, with its plan, .terraform and state copy");
  assert.ok(existsSync(l.young) && existsSync(l.unrelated), "a young scratch directory and a directory that is not the driver's stay");
  assert.deepEqual(readdirSync(l.evidence).sort(), [ARTIFACT + ".apply.json", ARTIFACT + ".blueprint.json", ARTIFACT + ".sealed.json", ARTIFACT + REMOVAL_RECORD_SUFFIX, "apply.log"].sort(), "evidence, sealed records and logs are kept");
  const record = recordOf(l.evidence);
  assert.equal(record.removals.length, 1);
  const removal = record.removals[0]!;
  assert.equal(removal.status, "COMPLETE");
  assert.match(removal.authorization, /^INTERIM_PERSON_INITIATED/);
  assert.deepEqual(removal.items.map((i) => [i.kind, i.path.slice(l.base.length + 1), i.removed]), [
    ["PREPARATION_FILE", "pilot/DEV/manifest-" + TAG + ".json", true], ["PREPARATION_FILE", "pilot/DEV/manifest-" + TAG + ".json.partial-4242", true],
    ["PREPARATION_FILE", "pilot/DEV/preparation-" + TAG + ".json", true], ["PREPARATION_FILE", "pilot/DEV/request-" + TAG + ".json", true],
    ["SCRATCH_DIRECTORY", "scratch/alz-preview-old1", true],
  ]);
  const prep = removal.items[3]!;
  assert.equal(prep.sha256, sha("{\"name\":\"request-" + TAG + ".json\"}\n"));
  const dir = removal.items[4]!;
  assert.deepEqual([dir.files, dir.bytes], [3, "PLAN-BYTES".length + "{\"backend\":{}}".length + "resource \"x\" \"y\" {}\n".length]);
  assert.deepEqual(dir.plans.map((p) => [p.path.slice(l.base.length + 1), p.bytes, p.sha256]), [["scratch/alz-preview-old1/alz-apply.tfplan", 10, sha("PLAN-BYTES")]]);
  assert.match(record.kept, /evidence directory.*ledger.*sealed plans.*logs.*project folder/);
  // Running it again finds nothing more and adds a second, empty removal: the record is append-only.
  const again = await removeWorkspace(l.input);
  assert.ok(again.ok);
  assert.deepEqual(recordOf(l.evidence).removals.map((r) => [r.status, r.items.length]), [["COMPLETE", 5], ["COMPLETE", 0]]);
});

test("an interrupted removal resumes from its record: what was removed stays recorded, the rest goes on the next run, and the record ends COMPLETE", async () => {
  const l = layout();
  let calls = 0;
  const crashing = { ...l.input, removePath: (path: string) => { calls += 1; if (calls === 3) throw Object.assign(new Error("interrupted"), { code: "EINTR" }); removeTree(path); } };
  const first = await removeWorkspace(crashing);
  assert.equal(first.ok, false);
  assert.equal((first as { code: string }).code, "REMOVAL_FAILED");
  assert.match((first as { message: string }).message, /3 path\(s\) remain; run the command again to resume/);
  const partial = recordOf(l.evidence).removals[0]!;
  assert.equal(partial.status, "IN_PROGRESS");
  assert.deepEqual(partial.items.map((i) => i.removed), [true, true, false, false, false]);
  const second = await removeWorkspace({ ...l.input, now: new Date(NOW.getTime() + 60_000) });
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.resumed, true);
  const record = recordOf(l.evidence);
  assert.equal(record.removals.length, 1, "the same removal resumed; no second one was started");
  assert.deepEqual([record.removals[0]!.status, record.removals[0]!.items.every((i) => i.removed)], ["COMPLETE", true]);
  assert.deepEqual(readdirSync(l.env), ["request-cccccccccccccccc.json"]);
  assert.ok(!existsSync(l.stale));
});

test("links are refused, never followed: a linked preparation file, a linked scratch directory, a link inside a stale scratch directory, a linked preparation folder, and a link swapped in before a resumed removal; nothing outside is touched", async () => {
  const outside = fresh("outside");
  writeFileSync(join(outside, "precious.txt"), "keep me");
  const cases: [string, (l: ReturnType<typeof layout>) => void][] = [
    ["a linked preparation file", (l) => { symlinkSync(join(outside, "precious.txt"), join(l.env, "manifest-" + TAG + ".json.partial-1")); }],
    ["a linked scratch directory", (l) => { symlinkSync(outside, join(l.input.scratchParent, "alz-snapshot-evil")); }],
    ["a link inside a stale scratch directory", (l) => { symlinkSync(outside, join(l.stale, "work", "escape")); utimesSync(l.stale, new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - 2 * HOUR)); }],
    ["a linked preparation folder", (l) => { removeTree(l.env); symlinkSync(outside, l.env); }],
  ];
  for (const [label, arrange] of cases) {
    const l = layout();
    arrange(l);
    const result = await removeWorkspace(l.input);
    assert.equal(result.ok, false, label);
    assert.equal((result as { code: string }).code, "REMOVAL_PATH_REFUSED", label);
    assert.ok(existsSync(join(outside, "precious.txt")), label + ": the target of the link is untouched");
    assert.ok(!existsSync(join(l.evidence, ARTIFACT + REMOVAL_RECORD_SUFFIX)), label + ": nothing was removed, so no removal is recorded");
  }
  // A path swapped for a link between an interrupted removal and its resumption is refused at the moment of removal.
  const l = layout();
  let calls = 0;
  const first = await removeWorkspace({ ...l.input, removePath: (path) => { calls += 1; if (calls === 1) throw new Error("interrupted"); removeTree(path); } });
  assert.equal(first.ok, false);
  const victim = recordOf(l.evidence).removals[0]!.items[0]!.path;
  removeTree(victim);
  symlinkSync(join(outside, "precious.txt"), victim);
  const resumed = await removeWorkspace(l.input);
  assert.equal(resumed.ok, false);
  assert.equal((resumed as { code: string }).code, "REMOVAL_PATH_REFUSED");
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
});

test("refused before anything is removed: while a run holds a ledger reservation, while the kill switch is active, when the AUTHORIZED check says no, and for a stale scratch directory that holds errored.tfstate (held for review, not removed)", async () => {
  const l = layout();
  await reserveArtifact(ARTIFACT, l.evidence, NOW);
  const busy = await removeWorkspace(l.input);
  assert.deepEqual([busy.ok, (busy as { code: string }).code], [false, "REMOVAL_RUN_IN_PROGRESS"]);
  assert.equal(readdirSync(l.env).length, 5, "nothing was removed");

  const k = layout();
  writeFileSync(KILL, "stop");
  try {
    const killed = await removeWorkspace(k.input);
    assert.deepEqual([killed.ok, (killed as { code: string }).code], [false, "REMOVAL_NOT_AUTHORIZED"]);
    assert.match((killed as { message: string }).message, /kill switch is active/);
    assert.deepEqual(authorizeRemoval({ operation: "REMOVE", contract: k.input.contract, environment: "DEV", artifactSha256: ARTIFACT }).authorized, false);
  } finally { removeTree(KILL); }
  const denied = await removeWorkspace({ ...k.input, authorize: () => ({ authorized: false, reason: "the ACT policy does not authorize REMOVE for AWS TERRAFORM DEV" }) });
  assert.deepEqual([denied.ok, (denied as { code: string }).code], [false, "REMOVAL_NOT_AUTHORIZED"]);
  assert.match((denied as { message: string }).message, /does not authorize REMOVE/);
  assert.equal(readdirSync(k.env).length, 5);

  const r = layout();
  writeFileSync(join(r.stale, "work", "errored.tfstate"), "{}");
  utimesSync(r.stale, new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - 2 * HOUR));
  const held = await removeWorkspace(r.input);
  assert.ok(held.ok, JSON.stringify(held));
  assert.ok(existsSync(join(r.stale, "work", "errored.tfstate")), "a scratch directory with errored.tfstate is kept for a person");
  assert.deepEqual(held.removal.heldForReview, [r.stale]);
  assert.ok(held.removal.items.every((i) => i.kind === "PREPARATION_FILE"));
});

// --- the terminal command ------------------------------------------------------------------------------------

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[]; asked: { prompt: string; kind?: string; phrase?: string }[] };
const terminal = (answers: string[]): Terminal => {
  const out: string[] = [];
  const asked: Terminal["asked"] = [];
  return { stdinIsTTY: true, stdoutIsTTY: true, out, asked, write: (text: string) => { out.push(text); }, ask: async (prompt, expectation) => { asked.push({ prompt, kind: expectation?.kind, phrase: expectation?.phrase }); return answers.shift() ?? ""; } };
};
const json = (value: unknown, label: string): string => { const path = join(fresh(label), label + ".json"); writeFileSync(path, JSON.stringify(value)); return path; };
const keyFile = (who: keyof typeof keys): string => { const path = join(fresh("key"), who + ".pem"); writeFileSync(path, keys[who].priv, { mode: 0o600 }); chmodSync(path, 0o600); return path; };

test("./alz apply remove-workspace at the terminal: shows exactly what goes and what stays, removes nothing unless the person types the phrase, then removes the run's working files and keeps its evidence", async () => {
  const BUCKET = "examplefake-ws-logs";
  behaveIn(toolDir, KILL, { applyAdvance: true, showOnlyConfigured: true, showResources: [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: {} } }],
    showProviderConfig: { aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] } } } }, stateResources: [stateResource("aws_s3_bucket", "logs", BUCKET, "arn:aws:s3:::" + BUCKET)] });
  behaveAwsReads(awsToolDir, { existing: [BUCKET], tagged: [] });
  const contractPath = join(fresh("contract"), "act-pilot-contract.json");
  writePinnedContract(contractPath, awsContractJson(KILL));
  const vault = fresh("vault");
  await testFixtureForgeQualificationEvidence(vault, undefined, "AWS");
  const [scratch, evidenceDir, preparationDir] = [fresh("scratch"), fresh("evidence"), fresh("pilot")];
  const nonces = openNonceStore(fresh("nonces"));
  const cli = async (args: string[], answers: string[] = []) => {
    const term = terminal(answers);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runApplyCommand(args, { sourceCommit: SOURCE_COMMIT, terminal: term, env: awsIdentityEnv("DEV"), now: () => NOW, operatorId: "operator.fixture", contractPath, contractPinPath: pinPathOf(contractPath),
      qualificationDir: vault, evidenceDir, nonces, scratchParent: scratch, toolDirs: [toolDir, awsToolDir], preparationDir, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); } });
    let data: unknown;
    try { data = JSON.parse(stdout.join("")); } catch { data = undefined; }
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), term, data };
  };
  const target = awsTargetOf("DEV");
  const project: Project = writeProject(fresh("project"), target, 'resource "aws_s3_bucket" "logs" {}\n');
  const request = json({ environment: "DEV", target, projectRoot: project.projectRoot, policyVersion: POLICY, resolved: project.resolved }, "request");
  const manifest = json(project.manifest, "manifest");
  const sealed = await cli(["seal", "--request", request, "--manifest", manifest, ...requesterArgs()], [targetString(target), "RUN PROJECT CODE"]);
  assert.equal(sealed.code, 0, sealed.stderr);
  const { sealedPlanPath, reviewBundlePath, artifactSha256 } = sealed.data as { sealedPlanPath: string; reviewBundlePath: string; artifactSha256: string };
  const approved = await cli(["approve", "--bundle", reviewBundlePath, "--key", keyFile("alice"), "--approver", "alice"], ["APPROVE DEV " + artifactSha256.slice(0, 12)]);
  assert.equal(approved.code, 0, approved.stderr);
  const applyRequest = json({ environment: "DEV", target, projectRoot: project.projectRoot }, "apply-request");
  const applied = await cli(["apply", "--request", applyRequest, "--manifest", manifest, "--sealed", sealedPlanPath, "--approval", json(approved.data, "approval")], ["APPLY DEV " + artifactSha256.slice(0, 12) + " " + targetString(target)]);
  assert.equal(applied.code, 0, applied.stderr);
  // What `prepare` would have written for this run's manifest.
  const tag = project.manifest.manifestHash.slice(0, 16);
  mkdirSync(join(preparationDir, "DEV"), { recursive: true });
  for (const name of ["request", "manifest", "preparation"]) writeFileSync(join(preparationDir, "DEV", name + "-" + tag + ".json"), "{}\n");
  const evidenceBefore = readdirSync(evidenceDir).sort();
  assert.ok(evidenceBefore.length > 0);

  const phrase = "REMOVE WORKSPACE DEV " + artifactSha256.slice(0, 12);
  const wrong = await cli(["remove-workspace", "--sealed", sealedPlanPath], ["REMOVE WORKSPACE DEV"]);
  assert.notEqual(wrong.code, 0, wrong.stderr);
  assert.match(wrong.stderr, /APPLY_CONFIRMATION_MISMATCH/);
  assert.equal(readdirSync(join(preparationDir, "DEV")).length, 3, "nothing is removed without the exact phrase");
  assert.deepEqual(wrong.term.asked.map((a) => a.phrase), [phrase]);
  const shown = wrong.term.out.join("");
  assert.match(shown, /local files only; no cloud resource is touched/);
  assert.match(shown, new RegExp("removes +" + join(preparationDir, "DEV", "manifest-" + tag + ".json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(shown, /keeps +evidence, the ledger, sealed plans, run records, proposals, reports, logs and the project folder/);
  const forced = await cli(["remove-workspace", "--sealed", sealedPlanPath, "--force", "yes"]);
  assert.notEqual(forced.code, 0);
  assert.match(forced.stderr, /APPLY_FLAG_UNKNOWN/, "no flag forces it");

  const done = await cli(["remove-workspace", "--sealed", sealedPlanPath], [phrase]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readdirSync(join(preparationDir, "DEV")), []);
  assert.ok(existsSync(project.projectRoot) && readdirSync(project.projectRoot).length > 0, "the operator's project folder is never touched");
  assert.deepEqual(readdirSync(evidenceDir).sort(), [...evidenceBefore, artifactSha256 + REMOVAL_RECORD_SUFFIX].sort(), "every evidence, ledger and sealed record is kept; the removal record is added");
  assert.equal((done.data as { status: string }).status, "COMPLETE");
  assert.ok(existsSync(sealedPlanPath), "the sealed plan is kept");
});
