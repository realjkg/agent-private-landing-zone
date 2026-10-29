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
  CANDIDATE, MUTATION_ENV, actRoot, applyScript, fakeProbe, fakeSpawner, fixtureDeps, observedAws, scriptedTerminal, validConfig, write, writeConfig,
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
    actEnabled: false, blockers: [],
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
  assert.deepEqual(seen.manifest!.actPilots, [{ provider: "AWS", engine: "TERRAFORM", contractSha256: "c".repeat(64), contractCommit: CANDIDATE }]);
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
