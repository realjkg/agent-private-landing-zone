import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runEvidenceCommand } from "../src/cli/evidence.js";
import { childEnvironment, spawnChild, stdioOf, type ChildRequest } from "../src/evidence-runner/child.js";
import { parseConfig } from "../src/evidence-runner/config.js";
import { federatedProbe } from "../src/evidence-runner/identity.js";
import { readJournal } from "../src/evidence-runner/journal.js";
import {
  ACCOUNT, CANARY, CANDIDATE, OPERATOR_SESSION, PROJECT, SUBSCRIPTION, TENANT, fakeSpawner, fixtureDeps, fixtureRoot, validConfig, writeConfig,
} from "./helpers/evidence-fixtures.js";

// SYNTHETIC: the read-only stages (S2 AWS, S3 Azure, S4 GCP) against fake and scripted children, and real node children
// that only report what they received. Nothing here reaches a cloud, reads a real token or uses anyone's CLI login.

const C12 = CANDIDATE.slice(0, 12);
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "alz-evidence-stage-")));
const config = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseConfig(validConfig(overrides));
  assert.ok(parsed.ok);
  return parsed.config;
};

/** A private token file (0600) holding the canary, which nothing may ever read or print. */
function tokenFile(dir: string, name: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, CANARY, { mode });
  chmodSync(path, mode);
  return path;
}

function federatedEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ALZ_DISCOVERY_AWS_ROLE_ARN: "arn:aws:iam::" + ACCOUNT + ":role/alz-discovery", ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile(dir, "discovery.jwt"), ALZ_DISCOVERY_AWS_REGION: "eu-west-1",
    ALZ_DISCOVERY_ARM_TENANT_ID: TENANT, ALZ_DISCOVERY_ARM_SUBSCRIPTION_ID: SUBSCRIPTION, ALZ_DISCOVERY_ARM_CLIENT_ID: "cccccccc-dddd-4eee-8fff-000000000000",
    ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile(dir, "azure-discovery.jwt"), AZURE_FEDERATED_TOKEN_FILE: tokenFile(dir, "azure-federated.jwt"),
    ALZ_DISCOVERY_GOOGLE_PROJECT: PROJECT, ALZ_DISCOVERY_GOOGLE_REGION: "europe-west1", ALZ_DISCOVERY_GOOGLE_APPLICATION_CREDENTIALS: tokenFile(dir, "gcp-wif.json"),
  };
}

test("the federated probe reads identifiers only: it names the missing variables, refuses a token file that is not private, and never opens one", async () => {
  const dir = folder();
  const env = federatedEnv(dir);
  const opened: string[] = [];
  const realRead = fs.readFileSync;
  const realOpen = fs.openSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => { opened.push(String(path)); return (realRead as (...a: unknown[]) => unknown)(path, ...rest); }) as typeof fs.readFileSync;
  fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => { opened.push(String(path)); return (realOpen as (...a: unknown[]) => number)(path, ...rest); }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    const probe = federatedProbe(env);
    assert.deepEqual(await probe("aws", config()), { status: "OBSERVED", kind: "FEDERATED", accountId: ACCOUNT, region: "eu-west-1" });
    assert.deepEqual(await probe("azure", config()), { status: "OBSERVED", kind: "FEDERATED", tenantId: TENANT, subscriptionId: SUBSCRIPTION });
    assert.deepEqual(await probe("gcp", config()), { status: "OBSERVED", kind: "FEDERATED", projectId: PROJECT, region: "europe-west1" });
  } finally {
    fs.readFileSync = realRead;
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
  assert.ok(!opened.some((path) => path.startsWith(dir)), "no token or credential configuration file was opened: " + opened.filter((path) => path.startsWith(dir)).join(", "));
  const missing = await federatedProbe({})("azure", config());
  assert.equal(missing.status, "MISSING");
  assert.match((missing as { detail: string }).detail, /ALZ_DISCOVERY_ARM_TENANT_ID, ALZ_DISCOVERY_ARM_SUBSCRIPTION_ID, ALZ_DISCOVERY_ARM_CLIENT_ID, ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE, AZURE_FEDERATED_TOKEN_FILE/);
  assert.match((missing as { detail: string }).detail, /never substitutes your own CLI login/);
  const loose = { ...env, ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile(dir, "loose.jwt", 0o644) };
  assert.match((await federatedProbe(loose)("aws", config()) as { detail: string }).detail, /readable or writable by group or others/);
  symlinkSync(env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE!, join(dir, "linked.jwt"));
  assert.match((await federatedProbe({ ...env, ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "linked.jwt") })("aws", config()) as { detail: string }).detail, /symbolic link/);
  assert.match((await federatedProbe({ ...env, ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE: "relative.jwt" })("aws", config()) as { detail: string }).detail, /not an absolute path/);
  assert.match((await federatedProbe({ ...env, ALZ_DISCOVERY_AWS_ROLE_ARN: "arn:aws:iam::111122223333:user/someone" })("aws", config()) as { detail: string }).detail, /not an IAM role ARN/);
  // The operator's own login variables are never a substitute: with only those set, the identity is MISSING.
  assert.equal((await federatedProbe({ ...OPERATOR_SESSION })("aws", config())).status, "MISSING");
  for (const result of [missing]) assert.ok(!JSON.stringify(result).includes(CANARY));
});

test("the child environment: allowlisted, a private HOME, the federated references, the evidence key's path; no operator session, ever", () => {
  const dir = folder();
  const parent = { ...OPERATOR_SESSION, HOME: "/Users/operator", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", ...federatedEnv(dir) };
  const built = childEnvironment(parent, { home: join(dir, "home"), realHome: "/Users/operator" });
  assert.ok(built.ok);
  for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(name in built.env, false, name + " reached the child");
  assert.ok(!Object.values(built.env).includes(CANARY), "no session value reached the child");
  assert.equal(built.env.HOME, join(dir, "home"));
  assert.equal(built.env.AGENTIC_EVIDENCE_KEY_FILE, "/Users/operator/.config/agentic-landing-zone/evidence.key", "the key file's path, never the key");
  assert.equal(built.env.ALZ_DISCOVERY_AWS_ROLE_ARN, parent.ALZ_DISCOVERY_AWS_ROLE_ARN);
  assert.equal("AZURE_FEDERATED_TOKEN_FILE" in built.env, false, "the federated marker goes to the read-only producers only");
  const producer = childEnvironment(parent, { home: join(dir, "home"), readonlyProducer: true });
  assert.ok(producer.ok && producer.env.AZURE_FEDERATED_TOKEN_FILE === parent.AZURE_FEDERATED_TOKEN_FILE);
  for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(producer.ok && name in producer.env, false, name + " reached the producer");
  // A static secret under the identity channel is refused by name, never forwarded.
  const refused = childEnvironment({ ...parent, ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: CANARY, ALZ_APPLY_ARM_CLIENT_SECRET: CANARY, ALZ_STATE_AWS_SESSION_TOKEN: CANARY }, { home: "/h" });
  assert.deepEqual(refused, { ok: false, refused: ["ALZ_APPLY_ARM_CLIENT_SECRET", "ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY", "ALZ_STATE_AWS_SESSION_TOKEN"] });
  // A TERMINAL child shares the person's terminal on all three streams; a LOGGED one gets no input at all.
  assert.deepEqual(stdioOf({ kind: "TERMINAL" }), ["inherit", "inherit", "inherit"]);
  assert.deepEqual(stdioOf({ kind: "LOGGED", logFile: "/x" }, 7), ["ignore", 7, 7]);
});

test("a real child receives the governed environment and nothing of the operator's session (the oracle, observed)", async () => {
  const dir = folder();
  const report = join(dir, "seen.json");
  const parent = { ...OPERATOR_SESSION, HOME: "/Users/operator", PATH: process.env.PATH ?? "/usr/bin", ...federatedEnv(dir) };
  const built = childEnvironment(parent, { home: join(dir, "home"), realHome: "/Users/operator", readonlyProducer: true });
  assert.ok(built.ok);
  mkdirSync(join(dir, "home"));
  const script = "require('fs').writeFileSync(" + JSON.stringify(report) + ", JSON.stringify(process.env))";
  const result = await spawnChild({ command: process.execPath, args: ["-e", script], cwd: dir, env: built.env, io: { kind: "LOGGED", logFile: join(dir, "logs", "child.log") } });
  assert.equal(result.exitCode, 0);
  const seen = JSON.parse(readFileSync(report, "utf8")) as Record<string, string>;
  for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(name in seen, false, name + " reached a real child");
  assert.ok(!Object.values(seen).includes(CANARY));
  assert.equal(seen.HOME, join(dir, "home"));
  assert.equal(readFileSync(join(dir, "logs", "child.log"), "utf8"), "", "a quiet child's output goes to its log");
});

/** A fake `./alz qualify provider-<cloud>` that writes the document its producer writes, READY unless told otherwise. */
function providerScript(cloud: "AWS" | "AZURE", options: { ready?: boolean; exitCode?: number; write?: boolean } = {}) {
  return (request: ChildRequest) => {
    const output = request.args[request.args.indexOf("--output") + 1];
    if (options.write !== false) {
      mkdirSync(dirname(join(request.cwd, output)), { recursive: true });
      writeFileSync(join(request.cwd, output), JSON.stringify({
        schemaVersion: 1, sourceCommit: request.args[request.args.indexOf("--source-commit") + 1], provider: cloud, ready: options.ready ?? true, identityMode: "ASSUME_ROLE",
        discovery: { classification: "BROWNFIELD", controlPlane: "x", resourceCount: 1, evidenceKeys: ["k"], evidenceSources: ["aws-cli"], snapshotSha256: "e".repeat(64) },
        validation: { passed: true, tools: ["t"] }, preview: { tool: "p", commandClass: "AWS_CHANGE_SET_PREVIEW", durationMs: 1, outputSha256: "f".repeat(64) },
        actEnabled: false, blockers: options.ready === false ? ["blocked by the fake"] : [],
      }));
    }
    return { exitCode: options.exitCode ?? (options.ready === false ? 1 : 0), signal: null };
  };
}

test("aws-readonly: the federated identity is verified, then the existing producer runs quietly as a child with the governed environment; its document is journaled", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig({ azure: undefined }));
  const env = { ...OPERATOR_SESSION, ...federatedEnv(folder()), PATH: "/usr/bin" };
  const spawn = fakeSpawner({ "qualify provider-aws": providerScript("AWS") });
  const deps = fixtureDeps(root, { env, probe: federatedProbe(env), spawn });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "aws-readonly"], deps), 0, deps.lines.join("\n"));
  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  const output = ".runs/evidence/synthetic/" + C12 + "/aws-readonly/provider-aws.json";
  assert.deepEqual(call.args, ["qualify", "provider-aws", "--provider", "AWS", "--source-commit", CANDIDATE, "--aws-stack", "alz-qualification-noop",
    "--aws-template", "qualification/provider/aws-noop-stack.yaml", "--output", output]);
  assert.equal(call.command, join(root, "alz"));
  assert.equal(call.io.kind, "LOGGED", "a read-only producer is quiet; its output goes to the run's log");
  for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(name in call.env, false, name + " reached the producer");
  assert.equal(call.env.HOME, join(root, ".runs/evidence/synthetic", C12, "home"));
  const dir = join(root, ".runs/evidence/synthetic", C12);
  const finish = readJournal(join(dir, "journal.jsonl")).filter((line) => line.event === "finish");
  const produced = finish.find((line) => line.step === "provider-qualification")!;
  assert.equal(produced.outcome, "PASS");
  assert.equal(produced.exitCode, 0);
  assert.deepEqual(produced.documents?.map((document) => document.path), [output]);
  const stage = JSON.parse(readFileSync(join(dir, "aws-readonly", "stage.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stage.fixture, true);
  assert.equal((stage.identity as { kind: string }).kind, "FEDERATED");
  for (const file of [join(dir, "journal.jsonl"), join(dir, "aws-readonly", "stage.json"), join(dir, "preflight.json")]) {
    assert.ok(!readFileSync(file, "utf8").includes(CANARY), "no credential value in " + file);
  }
  // Resume: the stage passed, so a rerun starts no child.
  const again = fixtureDeps(root, { env, probe: federatedProbe(env), spawn });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "aws-readonly"], again), 0);
  assert.equal(spawn.calls.length, 1, "a stage that produced its evidence is never run again");
  assert.match(again.lines.join("\n"), /aws-readonly: already produced in this run, skipped/);
});

test("aws-readonly: a BLOCKED verdict keeps the document and FAILs; a document left by an earlier attempt is never taken; a static secret refuses the step", async () => {
  const env = { ...federatedEnv(folder()), PATH: "/usr/bin" };
  const run = async (script: Parameters<typeof fakeSpawner>[0], extraEnv: NodeJS.ProcessEnv = {}, before?: (root: string) => void) => {
    const root = fixtureRoot();
    writeConfig(root, validConfig({ azure: undefined }));
    before?.(root);
    const spawn = fakeSpawner(script);
    const deps = fixtureDeps(root, { env: { ...env, ...extraEnv }, probe: federatedProbe(env), spawn });
    const code = await runEvidenceCommand(["run", "--synthetic", "--stage", "aws-readonly"], deps);
    return { root, code, spawn, text: deps.lines.join("\n"), finish: readJournal(join(root, ".runs/evidence/synthetic", C12, "journal.jsonl")).filter((line) => line.event === "finish") };
  };
  const notReady = await run({ "qualify provider-aws": providerScript("AWS", { ready: false }) });
  assert.equal(notReady.code, 2);
  const step = notReady.finish.find((line) => line.step === "provider-qualification")!;
  assert.deepEqual([step.outcome, step.code, step.exitCode], ["FAIL", "PRODUCER_NOT_READY", 1]);
  assert.equal(step.documents?.length, 1, "the BLOCKED verdict's document is kept for the person to read");
  const stale = await run({ "qualify provider-aws": providerScript("AWS", { write: false, exitCode: 0 }) }, {}, (root) => {
    const file = join(root, ".runs/evidence/synthetic", C12, "aws-readonly", "provider-aws.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{\"stale\":true}");
  });
  assert.equal(stale.code, 2);
  assert.equal(stale.finish.find((line) => line.step === "provider-qualification")!.code, "EVIDENCE_DOCUMENT_NOT_FOUND");
  const secret = await run({ "qualify provider-aws": providerScript("AWS") }, { ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: CANARY });
  assert.equal(secret.code, 2);
  assert.deepEqual(secret.spawn.calls, [], "no child starts with a static secret in the identity channel");
  assert.match(secret.text, /STATIC_SECRET_REFUSED/);
  assert.match(secret.text, /Unset ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY/);
  assert.ok(!secret.text.includes(CANARY));
});

test("azure-readonly runs the Azure producer; gcp-readonly verifies the project, reads nothing and stops NO_PRODUCER; a wrong identity starts nothing", async () => {
  const env = { ...federatedEnv(folder()), PATH: "/usr/bin" };
  const root = fixtureRoot();
  writeConfig(root, validConfig({ aws: undefined, gcp: { expectedProjectId: PROJECT, region: "europe-west1" } }));
  const spawn = fakeSpawner({ "qualify provider-azure": providerScript("AZURE") });
  const azure = fixtureDeps(root, { env, probe: federatedProbe(env), spawn });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "azure-readonly"], azure), 0, azure.lines.join("\n"));
  assert.deepEqual(spawn.calls[0].args.slice(0, 2), ["qualify", "provider-azure"]);
  assert.ok(spawn.calls[0].args.includes("westeurope"));
  assert.equal(spawn.calls[0].env.AZURE_FEDERATED_TOKEN_FILE, env.AZURE_FEDERATED_TOKEN_FILE);
  const gcp = fixtureDeps(root, { env, probe: federatedProbe(env), spawn });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "gcp-readonly"], gcp), 2);
  assert.match(gcp.lines.join("\n"), /gcp-readonly: NO_PRODUCER — The project is verified, but no read-only GCP inventory producer exists on main/);
  assert.equal(spawn.calls.length, 1, "the GCP stage starts no child");
  // A wrong project refuses the run before anything is written or asked.
  const wrongRoot = fixtureRoot();
  writeConfig(wrongRoot, validConfig({ aws: undefined, azure: undefined, gcp: { expectedProjectId: "another-project", region: "europe-west1" } }));
  const wrong = fixtureDeps(wrongRoot, { env, probe: federatedProbe(env), spawn });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "gcp-readonly"], wrong), 2);
  assert.match(wrong.lines.join("\n"), /WRONG_ACCOUNT/);
  assert.equal(existsSync(join(wrongRoot, ".runs")), false);
});

test("end to end with a real child: the production spawner starts ./alz with the governed environment and no input, and the stage takes the document it wrote", async () => {
  const root = fixtureRoot();
  writeConfig(root, validConfig({ azure: undefined }));
  const seen = join(root, "seen.json");
  // A stand-in launcher: records what it received, then writes the producer's document where --output says.
  writeFileSync(join(root, "alz"), "#!" + process.execPath + "\n" +
    "const fs = require('fs'), path = require('path'); const args = process.argv.slice(2); const out = args[args.indexOf('--output') + 1];\n" +
    "let stdin = 'unknown'; try { stdin = fs.fstatSync(0).isCharacterDevice() ? 'char' : 'other'; } catch { stdin = 'none'; }\n" +
    "fs.writeFileSync(" + JSON.stringify(seen) + ", JSON.stringify({ args, env: process.env, stdin }));\n" +
    "fs.mkdirSync(path.dirname(out), { recursive: true });\n" +
    "fs.writeFileSync(out, JSON.stringify({ schemaVersion: 1, sourceCommit: args[args.indexOf('--source-commit') + 1], provider: 'AWS', ready: true, actEnabled: false, blockers: [] }));\n" +
    "console.log('producer output that goes to the log');\n", { mode: 0o755 });
  const env = { ...OPERATOR_SESSION, ...federatedEnv(folder()), PATH: process.env.PATH ?? "/usr/bin" };
  const deps = fixtureDeps(root, { env, probe: federatedProbe(env), spawn: spawnChild });
  assert.equal(await runEvidenceCommand(["run", "--synthetic", "--stage", "aws-readonly"], deps), 0, deps.lines.join("\n"));
  const child = JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; env: Record<string, string>; stdin: string };
  for (const name of Object.keys(OPERATOR_SESSION)) assert.equal(name in child.env, false, name + " reached the real child");
  assert.ok(!JSON.stringify(child.env).includes(CANARY));
  assert.equal(child.env.HOME, join(root, ".runs/evidence/synthetic", C12, "home"));
  assert.equal(child.stdin, "char", "a quiet producer's input is /dev/null, never a pipe from the runner");
  assert.ok(!deps.lines.join("\n").includes("producer output that goes to the log"), "the producer's output stays in its log");
});
