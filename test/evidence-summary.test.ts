import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { runEvidenceCommand } from "../src/cli/evidence.js";
import type { ChildRequest } from "../src/evidence-runner/child.js";
import { readJournal } from "../src/evidence-runner/journal.js";
import { reviewProductionRelease, type ReleaseAdmissionInput } from "../src/qualification/release-admission.js";
import {
  ACCOUNT, CANDIDATE, CONTRACT_COMMIT, MUTATION_ENV, actRoot, applyScript, fakeProbe, fakeSpawner, fixtureDeps, observedAws, scriptedTerminal, validConfig, write, writeConfig,
} from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the summary stage (S6). Its index and manifest are checked here, and the review is the real one: the fake
// `./alz qualify admission` calls reviewProductionRelease on the manifest the runner wrote, as the CLI does, and writes its
// report where the CLI writes it. Every document is a fixture in a temporary folder; nothing here is release evidence.

const C12 = CANDIDATE.slice(0, 12);

/** A fake AWS provider producer that writes a document of the shape admission checks, READY. */
const awsProducer = (request: ChildRequest) => {
  const output = request.args[request.args.indexOf("--output") + 1];
  mkdirSync(dirname(join(request.cwd, output)), { recursive: true });
  writeFileSync(join(request.cwd, output), JSON.stringify({
    schemaVersion: 1, sourceCommit: CANDIDATE, provider: "AWS", ready: true, identityMode: "ASSUME_ROLE",
    discovery: { classification: "BROWNFIELD", controlPlane: "aws-organizations", resourceCount: 3, evidenceKeys: ["k"], evidenceSources: ["aws-cli"], snapshotSha256: "e".repeat(64) },
    validation: { passed: true, tools: ["cloudformation_validate"] }, preview: { tool: "cloudformation_preview", commandClass: "AWS_CHANGE_SET_PREVIEW", durationMs: 5, outputSha256: "f".repeat(64) },
    actEnabled: false, blockers: [], observedIdentity: { accountId: ACCOUNT },
  }));
  return { exitCode: 0, signal: null };
};

/** `./alz qualify admission --manifest FILE`, done the way the CLI does it, against the fixture repository. */
const admission = (seen: { manifest?: ReleaseAdmissionInput }) => async (request: ChildRequest) => {
  const manifest = JSON.parse(readFileSync(join(request.cwd, request.args[request.args.indexOf("--manifest") + 1]), "utf8")) as ReleaseAdmissionInput;
  seen.manifest = manifest;
  const outOfScope = (JSON.parse(readFileSync(join(request.cwd, "config/release/scope.json"), "utf8")) as { outOfScope: { gate: string }[] }).outOfScope.map((entry) => entry.gate);
  const report = await reviewProductionRelease({ manifest, root: request.cwd, expectedCommit: CANDIDATE, outOfScope });
  mkdirSync(join(request.cwd, ".runs/release"), { recursive: true });
  writeFileSync(join(request.cwd, ".runs/release", "admission-" + randomUUID() + ".json"), JSON.stringify(report));
  return { exitCode: report.readyForIndependentReleaseReview ? 0 : 1, signal: null };
};

async function readonlyThenSummary(label: "SYNTHETIC" | "LIVE") {
  const root = actRoot();
  writeConfig(root, validConfig({ azure: undefined }));
  const seen: { manifest?: ReleaseAdmissionInput } = {};
  const spawn = fakeSpawner({ "qualify provider-aws": awsProducer, "qualify admission": admission(seen) });
  const flags = label === "SYNTHETIC" ? ["--synthetic"] : [];
  const terminal = () => label === "LIVE" ? scriptedTerminal(["EVIDENCE LIVE owner-mac-01"]) : scriptedTerminal([], false);
  const readonly = fixtureDeps(root, { spawn, probe: fakeProbe({ aws: observedAws }), terminal: terminal() });
  assert.equal(await runEvidenceCommand(["run", ...flags, "--stage", "aws-readonly"], readonly), 0, readonly.lines.join("\n"));
  const summary = fixtureDeps(root, { spawn, terminal: terminal() });
  const code = await runEvidenceCommand(["run", ...flags, "--stage", "summary"], summary);
  const dir = join(root, ".runs/evidence", ...(label === "SYNTHETIC" ? ["synthetic"] : []), C12);
  return { root, dir, code, text: summary.lines.join("\n"), manifest: seen.manifest!, spawn };
}

test("a synthetic summary submits only fixture-stamped runner documents, which the real admission review refuses", async () => {
  const { dir, code, text, manifest, spawn } = await readonlyThenSummary("SYNTHETIC");
  assert.equal(code, 2);
  assert.deepEqual(spawn.calls.map((call) => call.args.slice(0, 2).join(" ")), ["qualify provider-aws", "qualify admission"]);
  assert.equal(spawn.calls[1].io.kind, "LOGGED", "the review is a quiet, read-only child");
  const record = manifest.records.find((entry) => entry.id === "aws-provider")!;
  assert.equal(record.evidencePath, ".runs/evidence/synthetic/" + C12 + "/summary/synthetic-aws-provider.json", "a synthetic run never submits the producer's document");
  const wrapper = JSON.parse(readFileSync(join(dir, "summary/synthetic-aws-provider.json"), "utf8")) as Record<string, unknown>;
  assert.equal(wrapper.fixture, true);
  assert.equal(wrapper.label, "SYNTHETIC");
  assert.match(text, /BLOCKED\s+aws-provider/, "admission refuses the fixture");
  assert.match(text, /summary: RELEASE_BLOCKED/);
  assert.equal(manifest.infrastructureAct, "DISABLED");
  const index = JSON.parse(readFileSync(join(dir, "summary/evidence-index.json"), "utf8")) as { fixture: boolean; missing: { gate: string; how: string }[] };
  assert.equal(index.fixture, true);
  assert.ok(index.missing.some((entry) => entry.gate === "azure-provider"), "a gate with no evidence is listed with how it is produced");
  assert.ok(index.missing.every((entry) => !entry.gate.startsWith("pillar:")), "out-of-scope gates are not owner inputs");
});

test("the same flow labeled LIVE submits the producer's own document, which the same review accepts for its gate; the release stays BLOCKED on the rest", async () => {
  const { code, text, manifest } = await readonlyThenSummary("LIVE");
  const record = manifest.records.find((entry) => entry.id === "aws-provider")!;
  assert.equal(record.evidencePath, ".runs/evidence/" + C12 + "/aws-readonly/provider-aws.json");
  assert.deepEqual([record.mode, record.sourceCommit, record.targetHardwareId], ["LIVE_PROVIDER", CANDIDATE, "owner-mac-01"]);
  assert.match(text, /EVIDENCE_PRESENT\s+aws-provider/);
  assert.match(text, /BLOCKED\s+azure-provider .*AUTO: azure-readonly/, "each missing gate says how it is produced");
  assert.equal(code, 2, "one gate's evidence never makes a release: the summary is BLOCKED");
});

test("the index takes the owner-run CI and model evidence for this candidate and host, and each ACT path's live record with its contract commit", async () => {
  const root = actRoot();
  writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: { repository: "owner/repo", paths: { "aws-terraform": { project: "/srv/canary/aws", requesterId: "owner" } } } }));
  write(root, ".runs/release/ci/source-ci-" + C12 + ".json", JSON.stringify({ gateId: "source-ci", sourceCommit: CANDIDATE, targetHardwareId: "github-runner-1" }));
  write(root, ".runs/release/ci/release-archive-" + C12 + ".json", JSON.stringify({ gateId: "release-archive", sourceCommit: "f".repeat(40), targetHardwareId: "github-runner-1" }));
  write(root, ".runs/model-qualification/2026-10-29T00-00-00-000Z.json", JSON.stringify({ production: { passed: true, context: { sourceCommit: CANDIDATE, host: { targetHardwareId: "owner-mac-01" } } } }));
  write(root, ".runs/model-qualification/2026-10-29T01-00-00-000Z.json", JSON.stringify({ production: { passed: true, context: { sourceCommit: CANDIDATE, host: { targetHardwareId: "another-host" } } } }));
  // The live record comes from the guided stages: act, then cleanup (which runs record-live last).
  const person = (...answers: string[]) => scriptedTerminal(answers);
  const env = { ...MUTATION_ENV, PATH: "/usr/bin" };
  await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], fixtureDeps(root, { env, spawn: fakeSpawner(applyScript()), terminal: person(join(root, ".runs/keys/requester.pem"), ".runs/approvals/apply-1.json", "") }));
  await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], fixtureDeps(root, { env, spawn: fakeSpawner(applyScript()), terminal: person(join(root, ".runs/keys/requester.pem"), ".runs/approvals/cleanup-1.json", "") }));
  const seen: { manifest?: ReleaseAdmissionInput } = {};
  const summary = fixtureDeps(root, { spawn: fakeSpawner({ "qualify admission": admission(seen) }) });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "summary"], summary), 2);
  const ids = seen.manifest!.records.map((record) => record.id).sort();
  assert.deepEqual(ids, ["act:aws-terraform", "private-model-runtime", "source-ci"], "release-archive names another commit and the second model record another host: neither is taken");
  assert.equal(seen.manifest!.infrastructureAct, "PILOT");
  assert.deepEqual(seen.manifest!.actPilots, [{ provider: "AWS", engine: "TERRAFORM", contractSha256: "c".repeat(64), contractCommit: CONTRACT_COMMIT }],
    "actPilots carries the commit that carried the path's contract");
  const act = seen.manifest!.records.find((record) => record.id === "act:aws-terraform")!;
  assert.equal(act.sourceCommit, CANDIDATE, "the submission names the candidate; the record keeps its contract commit inside (review B2)");
  const index = JSON.parse(readFileSync(join(root, ".runs/evidence/synthetic", C12, "summary/evidence-index.json"), "utf8")) as { found: { gate: string; producer: string }[] };
  assert.deepEqual(index.found.map((entry) => entry.gate + " " + entry.producer).sort(), [
    "act:aws-terraform ./alz apply record-live", "private-model-runtime ./alz models verify --production", "source-ci ./alz qualify ci-evidence",
  ]);
  // The summary's steps run again on every run: its verdict is always the current one.
  const steps = readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).filter((line) => line.stage === "summary" && line.event === "finish").map((line) => line.step);
  assert.deepEqual(steps, ["index", "admission", "summary"]);
  await runEvidenceCommand(["run", "--synthetic", "--stage", "summary"], fixtureDeps(root, { spawn: fakeSpawner({ "qualify admission": admission(seen) }) }));
  assert.equal(readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).filter((line) => line.stage === "summary" && line.step === "index" && line.event === "finish").length, 2);
});

// Review B2 on #349: a six-path package, with each path's live record written at its own contract commit (never the candidate),
// admitted end to end by the real review; and a substituted record refused.

import { authorizeContract, parsePilotContract, pilotContractSha256 } from "../src/apply/contract.js";
import type { PilotContract } from "../src/apply/types.js";
import type { ContractReader } from "../src/qualification/release-admission.js";
import { approvers, awsContractJson, contractJson as azureContractJson } from "./helpers/apply-fixtures.js";
import { CANARY as BICEP_CANARY, LOCATION, RESOURCE_GROUP, STACK_NAME, SUBSCRIPTION_ID, TENANT_ID } from "./helpers/bicep-fixtures.js";
import { cdkContractJson } from "./helpers/cdk-fixtures.js";

type AdmittedPath = { path: string; commit: string; text: string; contract: PilotContract };

function admittedPaths(kill: string): AdmittedPath[] {
  const gcp = { schemaVersion: 1, enabled: true, provider: "GCP", engine: "TERRAFORM", enabledEnvironments: ["DEV"],
    targets: { DEV: { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", canary: { resources: [{ type: "google_pubsub_topic", count: 1 }] } } },
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: kill, authorize: { DEV: ["APPLY", "CLEANUP"] } };
  const bicep = { schemaVersion: 1, enabled: true, provider: "AZURE", engine: "BICEP", enabledEnvironments: ["DEV"],
    targets: { DEV: { tenantId: TENANT_ID, subscriptionId: SUBSCRIPTION_ID, backend: STACK_NAME, workspace: "default", resourceGroup: RESOURCE_GROUP, location: LOCATION, canary: BICEP_CANARY } },
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: kill, authorize: { DEV: ["APPLY", "CLEANUP"] } };
  const raw: [string, object][] = [["aws-terraform", awsContractJson(kill)], ["azure-terraform", azureContractJson(kill)], ["aws-cdk", cdkContractJson(kill)], ["azure-bicep", bicep], ["gcp-terraform", gcp]];
  return raw.map(([path, json], index) => {
    // Each contract authorizes cleanup as well, as the owner's reviewed contract for a full DEV run does.
    const text = JSON.stringify({ ...json, authorize: { DEV: ["APPLY", "CLEANUP"] } });
    const contract = parsePilotContract(text);
    assert.equal(contract.enabled, true, path + ": " + JSON.stringify(contract));
    return { path, commit: String(index + 2).repeat(40), text, contract: contract as PilotContract };
  });
}

/** The live record `./alz apply record-live` writes at the path's own contract commit. */
const liveOf = (p: AdmittedPath, over: Record<string, unknown> = {}) => {
  const authorization = authorizeContract(p.contract, "DEV", "APPLY");
  assert.ok(authorization.ok);
  return {
    schemaVersion: 1, label: "LIVE", step: "execute", cloud: p.contract.provider, engine: p.contract.engine, environment: "DEV", target: { account: "a", backend: "b", workspace: "default" },
    sourceCommit: p.commit, artifactSha256: "1".repeat(64), outcome: "SUCCEEDED", evidenceSha256: "2".repeat(64), contractSha256: pilotContractSha256(p.contract),
    authorizationSha256: authorization.authorization.authorizationSha256, attestedBy: "owner", attestedAt: "2026-10-29T00:00:00.000Z", ...over,
  };
};

/** Each path's commit holds its contract and differs from the candidate in the contract file only. */
const readerOf = (paths: AdmittedPath[]): ContractReader => async (commit) => {
  const found = paths.find((p) => p.commit === commit);
  return found ? { ok: true, contract: parsePilotContract(found.text), changedPaths: ["config/act-pilot-contract.json"] } : { ok: false, reason: "no such commit" };
};

async function runPaths(root: string, paths: AdmittedPath[], live: (p: AdmittedPath) => Record<string, unknown> = (p) => liveOf(p)) {
  const env = { ...MUTATION_ENV, PATH: "/usr/bin" };
  for (const p of paths) {
    // The owner checks out the path's contract commit: the fixture repository holds that path's contract.
    writeFileSync(join(root, "config/act-pilot-contract.json"), p.text);
    const key = join(root, ".runs/keys/requester.pem");
    const act = fixtureDeps(root, { env, spawn: fakeSpawner(applyScript({}, { path: p.path })), terminal: scriptedTerminal([key, ".runs/approvals/apply-1.json", ""]) });
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "act:" + p.path], act), 0, act.lines.join("\n"));
    const cleanup = fixtureDeps(root, { env, spawn: fakeSpawner(applyScript({}, { path: p.path, live: live(p) })), terminal: scriptedTerminal([key, ".runs/approvals/cleanup-1.json", ""]) });
    assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:" + p.path], cleanup), 0, cleanup.lines.join("\n"));
  }
}

/** The summary's index as a LIVE run would submit it: the manifest the runner wrote, reviewed by the real admission with each path's contract reader. */
async function reviewManifest(root: string, paths: AdmittedPath[]) {
  const seen: { manifest?: ReleaseAdmissionInput } = {};
  const spawn = fakeSpawner({ "qualify admission": async (request) => {
    // In a synthetic run the records point at fixture wrappers; to judge the binding itself, review the producers' own documents.
    const manifest = JSON.parse(readFileSync(join(request.cwd, request.args[request.args.indexOf("--manifest") + 1]), "utf8")) as ReleaseAdmissionInput;
    seen.manifest = manifest;
    mkdirSync(join(request.cwd, ".runs/release"), { recursive: true });
    writeFileSync(join(request.cwd, ".runs/release", "admission-" + randomUUID() + ".json"), JSON.stringify({ gates: [], readyForIndependentReleaseReview: false }));
    return { exitCode: 1, signal: null };
  } });
  const summary = fixtureDeps(root, { spawn });
  const code = await runEvidenceCommand(["run", "--synthetic", "--stage", "summary"], summary);
  return { code, text: summary.lines.join("\n"), manifest: seen.manifest, review: async (manifest: ReleaseAdmissionInput) => reviewProductionRelease({ manifest, root, expectedCommit: CANDIDATE, contractAt: readerOf(paths) }) };
}

/** The synthetic manifest with each record pointed back at the producer's own document, as the LIVE label submits it. */
function asLive(root: string, manifest: ReleaseAdmissionInput): ReleaseAdmissionInput {
  return {
    ...manifest,
    records: manifest.records.map((record) => {
      const wrapper = JSON.parse(readFileSync(join(root, record.evidencePath), "utf8")) as { producerDocument: string; producerSha256: string };
      return { ...record, evidencePath: wrapper.producerDocument, evidenceSha256: wrapper.producerSha256 };
    }),
  };
}

test("B2: five admitted paths, each run at its own contract commit; the runner's manifest names the candidate and the real review admits every act:* gate", async () => {
  const root = actRoot();
  const paths = admittedPaths(join(root, "KILL"));
  writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: { repository: "owner/repo", paths: Object.fromEntries(paths.map((p) => [p.path, { project: "/srv/canary/" + p.path, requesterId: "owner" }])) } }));
  await runPaths(root, paths);
  const { manifest, review } = await reviewManifest(root, paths);
  assert.ok(manifest);
  assert.ok(manifest!.records.every((record) => record.sourceCommit === CANDIDATE), "every submission names the candidate");
  assert.deepEqual(manifest!.actPilots!.map((entry) => entry.contractCommit).sort(), paths.map((p) => p.commit).sort(), "each path's contract commit is declared in actPilots");
  assert.ok(paths.every((p) => p.commit !== CANDIDATE));
  // The synthetic manifest itself is refused: its records are fixtures.
  const synthetic = await review(manifest!);
  for (const p of paths) assert.equal(synthetic.gates.find((gate) => gate.id === "act:" + p.contract.provider.toLowerCase() + "-" + p.contract.engine.toLowerCase())?.status, "BLOCKED", "synthetic " + p.path);
  // The same package with the producers' own documents (what a LIVE run submits) is admitted gate by gate.
  const live = await review(asLive(root, manifest!));
  assert.deepEqual(live.blockers.filter((blocker) => /^ACT_PILOT|^RELEASE_MANIFEST/.test(blocker)), []);
  for (const p of paths) {
    const id = "act:" + p.contract.provider.toLowerCase() + "-" + p.contract.engine.toLowerCase();
    assert.equal(live.gates.find((gate) => gate.id === id)?.status, "EVIDENCE_PRESENT", id);
  }
});

test("B2 and N2: a substituted record is refused, by the journal's hash before submission and by the review when it names another path's contract", async () => {
  const root = actRoot();
  const paths = admittedPaths(join(root, "KILL"));
  const [aws, , , bicep, gcp] = paths;
  writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: { repository: "owner/repo", paths: Object.fromEntries(paths.map((p) => [p.path, { project: "/srv/canary/" + p.path, requesterId: "owner" }])) } }));
  // GCP's record names Bicep's contract and commit: a record for the wrong path.
  await runPaths(root, [aws, gcp], (p) => p === gcp ? liveOf(gcp, { contractSha256: pilotContractSha256(bicep.contract), sourceCommit: bicep.commit }) : liveOf(p));
  const { manifest, review } = await reviewManifest(root, paths);
  const live = await review(asLive(root, manifest!));
  assert.equal(live.gates.find((gate) => gate.id === "act:gcp-terraform")?.status, "BLOCKED", "a GCP gate never admits a record bound to Bicep's contract");
  assert.ok(live.blockers.some((blocker) => /^ACT_PILOT/.test(blocker)), "the declared GCP scope does not verify against Bicep's commit: " + live.blockers.join(", "));
  assert.equal(live.readyForIndependentReleaseReview, false);
  // A record edited after its step finished no longer matches the journal: the summary submits nothing.
  const moved = readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).find((line) => line.stage === "cleanup:aws-terraform" && line.step === "record-live" && line.event === "finish")!.documents![0];
  writeFileSync(join(root, moved.path), JSON.stringify(liveOf(aws, { outcome: "SUCCEEDED", attestedBy: "someone else" })));
  const again = await reviewManifest(root, paths);
  assert.equal(again.code, 2);
  assert.match(again.text, /summary: EVIDENCE_DOCUMENT_CHANGED — These documents no longer match the hash journaled when their step finished, so nothing was submitted: act:aws-terraform/);
  assert.equal(again.manifest, undefined, "the review never ran on a changed document");
});
