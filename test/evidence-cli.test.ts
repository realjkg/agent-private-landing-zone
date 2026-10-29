import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { parseEvidenceArgs, runEvidenceCommand } from "../src/cli/evidence.js";
import { readJournal } from "../src/evidence-runner/journal.js";
import { EvidenceWriteError, writeRunnerDocument } from "../src/evidence-runner/run.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { validateCatalog } from "../src/operations/schema.js";
import { AUTHORIZING_CONTRACT, CANARY, CANDIDATE, fakeProbe, fixtureDeps, fixtureRoot, observedAws, scriptedTerminal, validConfig, writeConfig } from "./helpers/evidence-fixtures.js";

// SYNTHETIC: `./alz evidence init | run | status` against a temporary repository root, injected source commit and fake
// identity probes. Nothing here reaches a cloud, spawns a provider tool or produces release evidence.

const C12 = CANDIDATE.slice(0, 12);
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const written = (root: string) => files(join(root, ".runs")).map((file) => relative(root, file)).sort();

test("arguments: only the configuration path, one stage and two switches; nothing pre-answers or forces", () => {
  assert.deepEqual(parseEvidenceArgs(["run", "--dry-run", "--synthetic", "--stage", "act:aws-terraform"]), { sub: "run", options: { configPath: "config/evidence-runner.json", dryRun: true, synthetic: true, stage: "act:aws-terraform" } });
  assert.deepEqual(parseEvidenceArgs(["run", "--stage", "cleanup:azure-bicep"]), { sub: "run", options: { configPath: "config/evidence-runner.json", dryRun: false, synthetic: false, stage: "cleanup:azure-bicep" } });
  for (const argv of [["run", "--yes"], ["run", "--force"], ["run", "--label", "LIVE"], ["run", "--stage", "everything"], ["run", "--stage", "act"], ["run", "--stage", "act:aws-everything"], ["run", "--approve"],
    ["run", "--answer", "APPLY"], ["status", "--dry-run"], ["init", "--stage", "act:aws-terraform"], ["apply"], [], ["run", "--config"], ["run", "--dry-run", "--dry-run"]]) {
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

test("dry run: preflight and the plan, only dry-run.json is written, under dry-run/ and never in a run folder", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const probe = fakeProbe({});
  const deps = fixtureDeps(root, { probe });
  assert.equal(await runEvidenceCommand(["run", "--dry-run"], deps), 2, "BLOCKED: no identity probe is built in this slice");
  assert.deepEqual(written(root), [".runs/evidence/dry-run/" + C12 + "/dry-run.json"]);
  assert.equal(existsSync(join(root, ".runs/evidence", C12)), false, "the live run folder is not created by a dry run");
  const plan = JSON.parse(readFileSync(join(root, ".runs/evidence/dry-run", C12, "dry-run.json"), "utf8")) as Record<string, unknown>;
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

test("a synthetic run journals preflight and stops at the first stage whose producer refuses, and stamps fixture: true", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2, "BLOCKED: the (fake) AWS producer refused");
  const dir = join(root, ".runs/evidence/synthetic", C12);
  const listed = written(root);
  assert.ok(listed.includes(".runs/evidence/synthetic/" + C12 + "/journal.jsonl") && listed.includes(".runs/evidence/synthetic/" + C12 + "/aws-readonly/stage.json"));
  assert.ok(!listed.some((file) => file.endsWith("run.lock")), "the lock is released");
  assert.ok(!listed.some((file) => file.includes("azure-readonly")), "a refusal stops the run: the next stage never started");
  const preflight = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8")) as Record<string, unknown>;
  assert.equal(preflight.label, "SYNTHETIC");
  assert.equal(preflight.fixture, true);
  assert.equal(statSync(join(dir, "preflight.json")).mode & 0o777, 0o600);
  const finished = readJournal(join(dir, "journal.jsonl")).filter((line) => line.event === "finish").map((line) => line.stage + "/" + line.step + "=" + line.outcome + ":" + (line.code ?? ""));
  assert.deepEqual(finished, ["preflight/preflight=PASS:", "aws-readonly/identity=PASS:VERIFIED", "aws-readonly/provider-qualification=BLOCKED:CHILD_REFUSED", "aws-readonly/aws-readonly=BLOCKED:CHILD_REFUSED"]);
  assert.ok(readJournal(join(dir, "journal.jsonl")).every((line) => line.label === "SYNTHETIC"));
  for (const file of files(join(root, ".runs"))) assert.ok(!readFileSync(file, "utf8").includes(CANARY), "no credential value reaches " + file);
  // Status reads the same journal.
  const status = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["status", "--synthetic"], status), 0);
  assert.match(status.lines.join("\n"), /aws-readonly\s+BLOCKED CHILD_REFUSED/);
  assert.match(status.lines.join("\n"), /Next: aws-readonly \(slice S2\)/);
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
  assert.equal(live.code, 2, "the (fake) producer refused, so the LIVE run produced no gate evidence");
});

test("a rerun with another configuration or label refuses the journal; a lock held by a live run refuses the run", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  await runEvidenceCommand(["run", "--synthetic"], fixtureDeps(root));
  writeConfig(root, validConfig({ targetHardwareId: "owner-mac-02" }));
  const changed = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], changed), 2);
  assert.match(changed.lines.join("\n"), /EVIDENCE_JOURNAL_MISMATCH: .*configSha256/);
  writeFileSync(join(root, ".runs/evidence/synthetic", C12, "run.lock"), JSON.stringify({ pid: 4242 }) + "\n");
  const busy = fixtureDeps(root, { pidAlive: () => true });
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], busy), 2);
  assert.match(busy.lines.join("\n"), /EVIDENCE_RUN_IN_PROGRESS/);
});

test("act, cleanup and recovery run only when named, and refuse while no committed contract authorizes the path", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig());
  const deps = fixtureDeps(root);
  await runEvidenceCommand(["run", "--synthetic", "--stage", "cleanup:aws-terraform"], deps);
  const stages = readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).filter((line) => line.event === "finish").map((line) => line.stage + ":" + line.code);
  assert.deepEqual(stages, ["preflight:undefined", "cleanup:aws-terraform:ACT_DISABLED"]);
  assert.deepEqual((deps.spawn as unknown as { calls: unknown[] }).calls, [], "no child was started");
  const pinned = fixtureRoot(AUTHORIZING_CONTRACT);
  writeConfig(pinned, validConfig());
  const guided = fixtureDeps(pinned);
  await runEvidenceCommand(["run", "--synthetic", "--stage", "act:aws-terraform"], guided);
  assert.match(guided.lines.join("\n"), /act:aws-terraform: CONTRACT_NOT_FOR_PATH/, "an authorize entry for another provider and engine never enables this path");
  for (const stage of ["recovery", "act:gcp-api"]) {
    const other = fixtureDeps(fixtureRoot());
    writeConfig(other.root, validConfig());
    await runEvidenceCommand(["run", "--synthetic", "--stage", stage], other);
    // GCP API-native is refused like every path while no committed contract authorizes it (INT-2), never as NOT_AVAILABLE.
    assert.match(other.lines.join("\n"), stage === "recovery" ? /recovery: ACT_DISABLED/ : /act:gcp-api: ACT_DISABLED/);
  }
});

test("a run that produced no evidence is BLOCKED: every --stage with no authorizing contract and no provider configured exits 2", async () => {
  for (const stage of ["preflight", "aws-readonly", "azure-readonly", "gcp-readonly", "act:aws-terraform", "act:gcp-api", "recovery", "cleanup:azure-bicep", "summary"]) {
    for (const label of ["LIVE", "SYNTHETIC"] as const) {
      const root = fixtureRoot();
      writeConfig(root, validConfig({ aws: undefined, azure: undefined }));
      const deps = label === "LIVE"
        ? fixtureDeps(root, { terminal: scriptedTerminal(["EVIDENCE LIVE owner-mac-01"]) })
        : fixtureDeps(root);
      const code = await runEvidenceCommand(["run", "--stage", stage, ...(label === "SYNTHETIC" ? ["--synthetic"] : [])], deps);
      assert.equal(code, 2, stage + " " + label);
      assert.match(deps.lines.at(-1)!, /^BLOCKED: no evidence was produced/, stage + " " + label);
      assert.doesNotMatch(deps.lines.join("\n"), /^DONE/m, stage + " " + label);
    }
  }
});

test("a symbolic link in the run folder's path refuses the run", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig({ aws: undefined, azure: undefined }));
  const outside = mkdtempSync(join(tmpdir(), "alz-evidence-outside-"));
  mkdirSync(join(root, ".runs/evidence"), { recursive: true });
  symlinkSync(outside, join(root, ".runs/evidence/synthetic"));
  const deps = fixtureDeps(root);
  assert.equal(await runEvidenceCommand(["run", "--synthetic"], deps), 2);
  assert.match(deps.lines.join("\n"), /EVIDENCE_PATH_REFUSED: .*synthetic is a symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
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
