import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runApplyCommand, type ApplyCliDeps, type ApplyReport } from "../src/cli/apply.js";
import { loadPilotContract, pilotContractSha256, repoPaths } from "../src/apply/contract.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import type { PilotContract } from "../src/apply/types.js";
import { sha256 } from "../src/util/sha256.js";
import {
  NOW, POLICY, awsContractJson, contractJson, identityEnv, installFakeTerraform, testFixtureForgeQualificationEvidence,
} from "./helpers/apply-fixtures.js";

// Pin preparation (`./alz apply pin`, docs/act-pilot-apply.md), a TEMPORARY path until contract-based authorization
// replaces the pin. Read-only, it validates the contract with the admission
// check, computes the hash as admission does, reports each gate READY or NOT-READY, and prints the owner's exact pin
// commit. It never writes config/act-pilot-contract.sha256 or any other repository file, and it never enables ACT.
// SYNTHETIC: fixture contracts, a fake engine and forged qualification evidence; nothing here is a real cloud.

const root = mkdtempSync(join(tmpdir(), "alz-pin-prep-"));
const toolDir = mkdtempSync(join(tmpdir(), "alz-pin-prep-tools-"));
process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
test.after(() => { removeTree(root); removeTree(toolDir); });
installFakeTerraform(toolDir);

let counter = 0;
const fresh = (label: string): string => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const KILL = join(root, "KILL");
const READY_CONTRACT = contractJson(KILL, { policyVersion: POLICY });
/** The DEV-only AWS Terraform pilot scope: one DEV target, nothing beyond it. */
const DEV_ONLY_AWS = (() => {
  const aws = awsContractJson(KILL, { policyVersion: POLICY, enabledEnvironments: ["DEV"] }) as { targets: Record<string, unknown>; approvers: { environments: string[] }[] };
  return { ...aws, targets: { DEV: aws.targets.DEV }, requiredApprovals: { DEV: 1 }, approvers: aws.approvers.map((a) => ({ ...a, environments: ["DEV"] })) };
})();

type World = { contractPath: string; pinPath: string; vault: string };
/** A contract file, an empty pin beside it (as the repository ships), and a vault with or without qualification evidence. */
async function world(contract: unknown = READY_CONTRACT, qualified = true): Promise<World> {
  const dir = fresh("contract");
  const contractPath = join(dir, "act-pilot-contract.json");
  writeFileSync(contractPath, typeof contract === "string" ? contract : JSON.stringify(contract));
  const pinPath = join(dir, "act-pilot-contract.sha256");
  writeFileSync(pinPath, "");
  const vault = fresh("vault");
  if (qualified) await testFixtureForgeQualificationEvidence(vault);
  return { contractPath, pinPath, vault };
}

type Report = {
  sha256: string | null; valid: boolean; ready: boolean; environment: string; pinFile: string; pinNow: string; pinContent: string | null; commands: string[]; out?: string;
  gates: { gate: string; state: string; detail: string }[];
};
type Run = { code: number; stdout: string; stderr: string; screen: string; reports: ApplyReport[] };
async function pin(w: World, args: string[] = [], over: Partial<ApplyCliDeps> = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const screen: string[] = [];
  const reports: ApplyReport[] = [];
  const code = await runApplyCommand(["pin", ...args], {
    terminal: { stdinIsTTY: true, stdoutIsTTY: true, write: (t) => { screen.push(t); }, ask: async () => "" },
    env: identityEnv("DEV"), now: () => NOW, contractPath: w.contractPath, contractPinPath: w.pinPath, qualificationDir: w.vault, toolDirs: [toolDir],
    stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, report: (e) => { reports.push(e); }, ...over,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), screen: screen.join(""), reports };
}
const reportOf = (run: Run): Report => JSON.parse(run.stdout) as Report;
const gateState = (report: Report, prefix: string): string | undefined => report.gates.find((g) => g.gate.startsWith(prefix))?.state;

/** Repository files git sees as changed or untracked; ignored scratch (.runs, node_modules) is not a repository file. */
const repoStatus = (): string => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoPaths().root, encoding: "utf8" });
const shippedPin = (): string => existsSync(repoPaths().pin) ? readFileSync(repoPaths().pin, "utf8") : "";

test("the shipped pin is empty, so ACT ships DISABLED", () => {
  assert.equal(shippedPin().trim(), "");
  const loaded = loadPilotContract();
  assert.ok("reason" in loaded && loaded.code === "ACT_DISABLED");
});

test("READY: every gate holds; it prints the admission hash, the exact pin content and the owner's commands, and exits 0", async () => {
  const w = await world();
  const run = await pin(w);
  assert.equal(run.code, 0, run.stderr + run.screen);
  const report = reportOf(run);
  assert.equal(report.ready, true);
  assert.equal(report.environment, "DEV");
  for (const g of report.gates) assert.equal(g.state, "READY", g.gate + ": " + g.detail);
  for (const prefix of ["contract-check", "contract admission", "identities aimed at the DEV", "kill switch", "engine qualified in DEV for seal and apply (TERRAFORM)", "identity separation attested"]) {
    assert.equal(gateState(report, prefix), "READY", prefix);
  }
  assert.match(report.sha256!, /^[0-9a-f]{64}$/);
  assert.equal(report.pinContent, report.sha256 + "\n");
  assert.equal(report.pinNow, "empty (ACT disabled)");
  assert.deepEqual(report.commands, [
    "git switch -c act-dev-azure-pin",
    "printf '%s\\n' " + report.sha256 + " > " + w.pinPath,
    "./alz apply status",
    "git add " + w.contractPath + " " + w.pinPath,
    "git diff --cached",
    "git commit -m \"Pin the reviewed ACT pilot contract (AZURE TERRAFORM DEV)\"",
  ]);
  assert.match(run.screen, /^PIN PREPARATION, temporary until contract-based authorization replaces the pin \(read-only/);
  assert.match(run.screen, /RESULT READY/);
  assert.match(run.screen, new RegExp("\\n  " + report.sha256 + "\\n"));
  assert.deepEqual(run.reports.map((r) => r.code), ["PIN_READY"]);
  // Nothing was pinned by preparing: the pin beside the contract is still empty and the contract still loads as disabled.
  assert.equal(readFileSync(w.pinPath, "utf8"), "");
  const loaded = loadPilotContract(w.contractPath, w.pinPath);
  assert.ok("reason" in loaded && loaded.code === "ACT_DISABLED");
});

test("the printed hash is exactly the one admission accepts, and the committed pin content enables only that contract", async () => {
  const w = await world();
  const report = reportOf(await pin(w));
  // The same computation admission runs over the validated contract (canonical JSON, SHA-256).
  assert.equal(report.sha256, sha256(canonicalJson(READY_CONTRACT as never)));
  // Written as the owner's commit would write it, admission loads the contract under that pin.
  const pinned = join(fresh("owner"), "pin");
  writeFileSync(pinned, report.pinContent!);
  const loaded = loadPilotContract(w.contractPath, pinned);
  assert.ok(!("reason" in loaded), "admission accepts the printed pin");
  assert.equal(pilotContractSha256(loaded as PilotContract), report.sha256);
  // One changed field is a different contract: the printed pin no longer admits it.
  writeFileSync(w.contractPath, JSON.stringify({ ...READY_CONTRACT, approvalTtlMinutes: 31 }));
  const changed = loadPilotContract(w.contractPath, pinned);
  assert.ok("reason" in changed && changed.code === "CONTRACT_INVALID");
});

test("NOT-READY: each failing gate is named, no commit is offered, nothing is written to --out, and it exits 2", async () => {
  const cases: { name: string; contract: unknown; qualified?: boolean; args?: string[]; gate: string }[] = [
    { name: "enabled: false", contract: { ...READY_CONTRACT, enabled: false }, gate: "contract admission" },
    { name: "an owner input missing", contract: contractJson(KILL), gate: "contract-check" },
    { name: "the environment out of scope", contract: DEV_ONLY_AWS, args: ["--environment", "PROD"], gate: "identities aimed at the PROD" },
    { name: "QA without DEV qualification", contract: READY_CONTRACT, qualified: false, args: ["--environment", "QA"], gate: "engine qualified" },
  ];
  for (const c of cases) {
    const w = await world(c.contract, c.qualified ?? true);
    const out = join(fresh("out"), "candidate.sha256");
    const run = await pin(w, [...(c.args ?? []), "--out", out]);
    assert.ok(run.stdout !== "", c.name + ": " + run.stderr);
    assert.equal(run.code, 2, c.name);
    const report = reportOf(run);
    assert.equal(report.ready, false, c.name);
    assert.equal(gateState(report, c.gate), "NOT-READY", c.name + ": " + JSON.stringify(report.gates));
    assert.equal(report.pinContent, null, c.name);
    assert.deepEqual(report.commands, [], c.name);
    assert.match(run.screen, /RESULT NOT-READY/, c.name);
    assert.doesNotMatch(run.screen, /git commit|printf/, c.name);
    assert.equal(existsSync(out), false, c.name);
    assert.deepEqual(run.reports.map((r) => r.code), ["PIN_NOT_READY"], c.name);
    assert.equal(readFileSync(w.pinPath, "utf8"), "", c.name);
  }
  // enabled: false is a valid shape, but admission would report ACT_DISABLED, so no hash is offered at all.
  const disabled = reportOf(await pin(await world({ ...READY_CONTRACT, enabled: false })));
  assert.equal(disabled.sha256, null);
  assert.equal(disabled.valid, false);
});

test("NOT-READY: an engaged kill switch is named", async () => {
  const kill = join(fresh("kill"), "KILL");
  writeFileSync(kill, "");
  const run = await pin(await world(contractJson(kill, { policyVersion: POLICY })));
  assert.equal(run.code, 2);
  assert.equal(gateState(reportOf(run), "kill switch"), "NOT-READY");
});

test("the first DEV pin precedes G2: missing qualification is PENDING in DEV and does not block; stale evidence would", async () => {
  const w = await world(READY_CONTRACT, false);
  const run = await pin(w);
  assert.equal(run.code, 0, run.screen);
  const report = reportOf(run);
  assert.equal(gateState(report, "engine qualified"), "PENDING");
  assert.equal(gateState(report, "identity separation attested"), "PENDING");
  assert.match(run.screen, /\[PENDING\] engine qualified/);
  // Evidence that exists but no longer matches this machine (another engine binary) is NOT-READY, not PENDING.
  const stale = await pin(await world(), [], { toolDirs: [fresh("no-tools")] });
  assert.equal(stale.code, 2);
  assert.equal(gateState(reportOf(stale), "engine qualified"), "NOT-READY");
});

test("an invalid contract is refused before any hash is computed", async () => {
  for (const contract of [
    { ...READY_CONTRACT, provider: "GCP" },
    { ...READY_CONTRACT, unknownField: true },
    { ...READY_CONTRACT, requiredApprovals: { DEV: 0, QA: 1, PROD: 2 } },
  ]) {
    const run = await pin(await world(contract));
    assert.equal(run.code, 2, JSON.stringify(contract).slice(0, 60));
    assert.match(run.stderr, /^BLOCKED CONTRACT_INVALID: /);
    assert.equal(run.stdout, "");
    assert.doesNotMatch(run.stderr + run.screen, /[0-9a-f]{64}/);
  }
  const unparsable = await pin(await world("{ not json"));
  assert.equal(unparsable.code, 1);
  assert.match(unparsable.stderr, /^APPLY_INPUT_INVALID/);
  assert.equal(unparsable.stdout, "");
});

test("--out inside the repository is refused before anything is read, through any spelling or link", async () => {
  const w = await world();
  const before = shippedPin();
  const link = join(fresh("link"), "repo");
  symlinkSync(repoPaths().root, link);
  for (const out of [repoPaths().pin, join(repoPaths().root, "candidate.sha256"), join(repoPaths().root, "config", "..", "x.sha256"), join(link, "config", "candidate.sha256")]) {
    const run = await pin(w, ["--out", out]);
    assert.equal(run.code, 1, out);
    assert.match(run.stderr, /^PIN_OUT_INSIDE_REPOSITORY/, out);
    assert.equal(run.stdout, "", out);
    assert.equal(run.screen, "", out);
  }
  assert.equal(shippedPin(), before);
  assert.equal(existsSync(join(repoPaths().root, "candidate.sha256")), false);
  assert.equal(existsSync(join(repoPaths().root, "x.sha256")), false);
});

test("--out outside the repository writes the candidate pin once, mode 0600, and never overwrites", async () => {
  const w = await world();
  const out = join(fresh("out"), "act-pilot-contract.sha256");
  const run = await pin(w, ["--out", out]);
  assert.equal(run.code, 0, run.stderr);
  const report = reportOf(run);
  assert.equal(report.out, out);
  assert.equal(readFileSync(out, "utf8"), report.sha256 + "\n");
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const again = await pin(w, ["--out", out]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /^PIN_OUT_INVALID/);
  const missingDir = await pin(w, ["--out", join(root, "no-such-dir", "pin")]);
  assert.equal(missingDir.code, 1);
  assert.match(missingDir.stderr, /^PIN_OUT_INVALID/);
});

test("preparing a pin writes no repository file and leaves the shipped pin empty, READY or not", async () => {
  const status = repoStatus();
  const pinBefore = shippedPin();
  const ready = await world();
  await pin(ready);
  await pin(ready, ["--environment", "QA"]);
  await pin(ready, ["--out", join(fresh("out"), "pin")]);
  await pin(await world(contractJson(KILL)));
  await pin(await world({ ...READY_CONTRACT, provider: "GCP" }));
  // The default contract and pin paths are the repository's own: the shipped contract is absent or not enabled.
  const defaults = await pin(ready, [], { contractPath: undefined, contractPinPath: undefined });
  assert.notEqual(defaults.code, 0);
  assert.equal(shippedPin(), pinBefore);
  assert.equal(shippedPin().trim(), "");
  assert.equal(repoStatus(), status);
});

test("the flags are only --environment and --out, each once, and a bad environment is refused", async () => {
  const w = await world();
  for (const args of [["--force", "x"], ["--write", "x"], ["--environment", "DEV", "--environment", "QA"], ["--environment", "STAGE"], ["--out"]]) {
    const run = await pin(w, args);
    assert.equal(run.code, 1, JSON.stringify(args));
    assert.match(run.stderr, /^APPLY_[A-Z_]+/, JSON.stringify(args));
    assert.equal(run.stdout, "");
  }
});
