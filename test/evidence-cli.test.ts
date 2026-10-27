import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { parseEvidenceArgs, runEvidenceCommand } from "../src/cli/evidence.js";
import { readJournal } from "../src/evidence-runner/journal.js";
import { EvidenceWriteError, writeRunnerDocument } from "../src/evidence-runner/run.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { validateCatalog } from "../src/operations/schema.js";
import { CANARY, CANDIDATE, fakeProbe, fixtureDeps, fixtureRoot, observedAws, scriptedTerminal, validConfig, writeConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: `./alz evidence init | run | status` against a temporary repository root, injected source commit and fake
// identity probes. Nothing here reaches a cloud, spawns a provider tool or produces release evidence.

const C12 = CANDIDATE.slice(0, 12);
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const written = (root: string) => files(join(root, ".runs")).map((file) => relative(root, file)).sort();

test("arguments: only the configuration path, one stage and two switches; nothing pre-answers or forces", () => {
  assert.deepEqual(parseEvidenceArgs(["run", "--dry-run", "--synthetic", "--stage", "act"]), { sub: "run", options: { configPath: "config/evidence-runner.json", dryRun: true, synthetic: true, stage: "act" } });
  for (const argv of [["run", "--yes"], ["run", "--force"], ["run", "--label", "LIVE"], ["run", "--stage", "everything"], ["status", "--dry-run"], ["init", "--stage", "act"], ["apply"], [], ["run", "--config"], ["run", "--dry-run", "--dry-run"]]) {
    assert.ok("error" in parseEvidenceArgs(argv), argv.join(" "));
  }
});

test("init copies the example once and never overwrites", async () => {
  const root = fixtureRoot();
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["init"], deps), 0);
  assert.equal(readFileSync(join(root, "config/evidence-runner.json"), "utf8"), readFileSync("config/evidence-runner.example.json", "utf8"));
  writeFileSync(join(root, "config/evidence-runner.json"), "{\"mine\":true}");
  assert.equal(await runEvidenceCommand(["init"], deps), 2);
  assert.equal(readFileSync(join(root, "config/evidence-runner.json"), "utf8"), "{\"mine\":true}");
  assert.equal(await runEvidenceCommand(["init", "--config", "../outside.json"], deps), 2);
});

test("the unedited example configuration is refused and nothing is written", async () => {
  const root = fixtureRoot();
  const deps = fixtureDeps(root);
  await runEvidenceCommand(["init"], deps);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.match(deps.lines.join("\n"), /REPLACE-WITH placeholders/);
  assert.deepEqual(written(root), []);
});

test("dry run: preflight and the plan, only dry-run.json is written, nothing is spawned or journaled", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const probe = fakeProbe({});
  const deps = fixtureDeps(root, { probe });
  assert.equal(await runEvidenceCommand(["run", "--dry-run"], deps), 2, "BLOCKED: no identity probe is built in this slice");
  assert.deepEqual(written(root), [".runs/evidence/" + C12 + "/dry-run.json"]);
  const plan = JSON.parse(readFileSync(join(root, ".runs/evidence", C12, "dry-run.json"), "utf8")) as Record<string, unknown>;
  assert.equal(plan.evidence, false);
  assert.equal(plan.label, "UNLABELED");
  const text = deps.lines.join("\n");
  assert.match(text, /IDENTITY_NOT_VERIFIED/);
  assert.match(text, /OWNER_INPUT_NOOP_STACK/);
  assert.match(text, /SKIPPED_ACT_DISABLED/);
  assert.match(text, /NO_PRODUCER/);
  assert.match(text, /Dry run: nothing ran and no evidence was written/);
  assert.deepEqual(probe.calls, ["aws", "azure"]);
});

test("a blocked preflight writes nothing and asks for no attestation", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const terminal = scriptedTerminal(["EVIDENCE LIVE owner-mac-01"]);
  const deps = fixtureDeps(root, { terminal, probe: fakeProbe({ aws: { ...observedAws, accountId: "999988887777" } }) });
  assert.equal(await runEvidenceCommand(["run"], deps), 2);
  assert.match(deps.lines.join("\n"), /WRONG_ACCOUNT/);
  assert.deepEqual(terminal.asked, []);
  assert.deepEqual(written(root), []);
});

test("a synthetic run journals preflight, reports every later stage NOT_BUILT or SKIPPED, and stamps fixture: true", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2, "BLOCKED: the provider stages are not built yet");
  const dir = join(root, ".runs/evidence/synthetic", C12);
  assert.deepEqual(written(root), [".runs/evidence/synthetic/" + C12 + "/journal.jsonl", ".runs/evidence/synthetic/" + C12 + "/preflight.json"], "the lock is released");
  const preflight = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8")) as Record<string, unknown>;
  assert.equal(preflight.label, "SYNTHETIC");
  assert.equal(preflight.fixture, true);
  assert.equal(statSync(join(dir, "preflight.json")).mode & 0o777, 0o600);
  const finished = readJournal(join(dir, "journal.jsonl")).filter((line) => line.event === "finish").map((line) => line.stage + "=" + line.outcome + ":" + (line.code ?? ""));
  assert.deepEqual(finished, ["preflight=PASS:", "aws-readonly=BLOCKED:NOT_BUILT", "azure-readonly=BLOCKED:NOT_BUILT", "gcp-readonly=SKIPPED:GCP_HELD", "act=SKIPPED:SKIPPED_ACT_DISABLED", "summary=BLOCKED:NOT_BUILT"]);
  assert.ok(readJournal(join(dir, "journal.jsonl")).every((line) => line.label === "SYNTHETIC"));
  for (const file of files(join(root, ".runs"))) assert.ok(!readFileSync(file, "utf8").includes(CANARY), "no credential value reaches " + file);
  // Status reads the same journal.
  const status = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["status", "--synthetic"], status), 0);
  assert.match(status.lines.join("\n"), /aws-readonly\s+BLOCKED NOT_BUILT/);
  assert.match(status.lines.join("\n"), /Next: aws-readonly \(slice S2, not built yet\)/);
});

test("LIVE only from the exact typed phrase at an interactive terminal", async () => {
  const run = async (terminal: ReturnType<typeof scriptedTerminal>) => {
    const root = fixtureRoot();
    writeConfig(root, validConfig({ azure: undefined }));
    const deps = fixtureDeps(root, { terminal });
    return { root, code: await runEvidenceCommand(["run"], deps), text: deps.lines.join("\n") };
  };
  const noTty = await run(scriptedTerminal(["EVIDENCE LIVE owner-mac-01"], false));
  assert.equal(noTty.code, 2);
  assert.match(noTty.text, /EVIDENCE_TERMINAL_REQUIRED/);
  assert.deepEqual(written(noTty.root), []);
  const wrong = await run(scriptedTerminal(["EVIDENCE LIVE another-host"]));
  assert.match(wrong.text, /EVIDENCE_ATTESTATION_REFUSED/);
  assert.deepEqual(written(wrong.root), []);
  const typedSynthetic = await run(scriptedTerminal(["SYNTHETIC"]));
  assert.ok(written(typedSynthetic.root).every((file) => file.startsWith(".runs/evidence/synthetic/")));
  const live = await run(scriptedTerminal(["EVIDENCE LIVE owner-mac-01"]));
  const dir = join(live.root, ".runs/evidence", C12);
  const preflight = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8")) as Record<string, unknown>;
  assert.equal(preflight.label, "LIVE");
  assert.equal("fixture" in preflight, false);
  assert.ok(readJournal(join(dir, "journal.jsonl")).every((line) => line.label === "LIVE"));
  assert.equal(live.code, 2, "LIVE preflight still produces no gate evidence in this slice");
});

test("a rerun with another configuration or label refuses the journal; a lock held by a live run refuses the run", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  await runEvidenceCommand(["run", "--synthetic"], fixtureDeps(root));
  writeConfig(root, validConfig({ modelHost: true }));
  const changed = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], changed), 2);
  assert.match(changed.lines.join("\n"), /EVIDENCE_JOURNAL_MISMATCH: .*configSha256/);
  writeFileSync(join(root, ".runs/evidence/synthetic", C12, "run.lock"), JSON.stringify({ pid: 4242 }) + "\n");
  const busy = fixtureDeps(root, { pidAlive: () => true });
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], busy), 2);
  assert.match(busy.lines.join("\n"), /EVIDENCE_RUN_IN_PROGRESS/);
});

test("cleanup and recovery run only when named, and report ACT disabled while the pin is empty", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const deps = fixtureDeps(root);
  await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup"], deps);
  const stages = readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).filter((line) => line.event === "finish").map((line) => line.stage + ":" + line.code);
  assert.deepEqual(stages, ["preflight:undefined", "cleanup:SKIPPED_ACT_DISABLED"]);
  const pinned = fixtureRoot("d".repeat(64) + "\n");
  writeConfig(pinned, validConfig());
  const guided = fixtureDeps(pinned);
  await runEvidenceCommand(["run", "--synthetic", "--stage", "act"], guided);
  assert.match(guided.lines.join("\n"), /act: NOT_BUILT — Slice S5/);
});

test("documents with a credential-shaped key are refused before writing", () => {
  const root = fixtureRoot();
  for (const document of [{ token: "x" }, { nested: { awsProfile: "dev" } }, { list: [{ Authorization: "x" }] }]) {
    assert.throws(() => writeRunnerDocument(join(root, "doc.json"), "SYNTHETIC", document), EvidenceWriteError);
  }
  assert.equal(existsSync(join(root, "doc.json")), false);
});

test("catalog: three HANDOFF entries under the evidence group, and the console can never run the runner", () => {
  const entries = OPERATIONS.filter((spec) => spec.cliScript === "src/cli/evidence.ts");
  assert.deepEqual(entries.map((spec) => spec.command?.group + " " + spec.command?.sub), ["evidence init", "evidence run", "evidence status"]);
  for (const spec of entries) {
    assert.equal(spec.safety, "HANDOFF");
    assert.equal(spec.job, undefined);
    assert.equal(spec.handoff?.env, undefined, "the runner asks for no credential variable");
  }
  const probe = { ...entries[1], safety: "WRITES_LOCAL" as const, handoff: undefined, job: { script: "cli/evidence.js", args: () => [] } };
  assert.match(validateCatalog([probe]).join(), /may not be run by the console/);
});
