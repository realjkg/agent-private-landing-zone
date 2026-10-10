import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DRIVER_COMMANDS,
  EXIT,
  runDriverCommand,
  targetString,
  type DriverCliDeps,
  type DriverCommand,
  type HumanTerminal,
} from "../src/cli/teardown-driver.js";
import { createChangeSet } from "../src/iac/changeset.js";
import { getToolSecurityPosture } from "../src/tools/broker.js";
import {
  argvDigest,
  buildEvidence,
  type AdapterContext,
  type EngineAdapter,
  type PreviewEvidence,
  type PreviewOperation,
  type PreviewRequest,
  type QualificationRecord,
} from "../src/teardown/driver/index.js";
import { buildManifest } from "../src/teardown/manifest.js";
import { captureProjectFiles } from "../src/teardown/snapshot.js";
import { recordDeletionUnit } from "../src/teardown/unit.js";

const H = (char: string) => char.repeat(64);
const root = mkdtempSync(join(tmpdir(), "alz-driver-cli-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string) => {
  const dir = join(root, label + "-" + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const CANARY_DISCOVERY = "canary-discovery-secret-5e21";
const CANARY_STATE = "canary-state-secret-b04d";
const CANARY_THROWN = "canary-thrown-text-c7a9";
const ENV = { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: CANARY_DISCOVERY, ALZ_STATE_AWS_ACCESS_KEY_ID: CANARY_STATE };
const CANARIES = [CANARY_DISCOVERY, CANARY_STATE, CANARY_THROWN];

const ADDRESS = "aws_s3_bucket.logs";
const LOCATION = "s3://alz-state/prod/terraform.tfstate";
const TARGET = { account: "123456789012", backend: LOCATION, workspace: "default" };

type Adapter = EngineAdapter & { calls: Array<{ operation: PreviewOperation; context: AdapterContext }> };

function fakeAdapter(
  behave?: (request: PreviewRequest, operation: PreviewOperation) => PreviewEvidence,
): Adapter {
  const descriptor = { engine: "TERRAFORM" as const, adapterVersion: "1.0.0", argvDigest: argvDigest([["fake", "plan"]]) };
  const calls: Adapter["calls"] = [];
  const run = (operation: PreviewOperation) => (request: PreviewRequest, context: AdapterContext): PreviewEvidence => {
    calls.push({ operation, context });
    if (behave) return behave(request, operation);
    return buildEvidence({
      request, operation, adapter: descriptor, observedEngineVersion: request.resolved.engineVersion,
      resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: operation === "DESTROY_PREVIEW" ? "DELETE" : "CREATE" }],
      stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
    });
  };
  return { ...descriptor, calls, preview: run("PREVIEW"), destroyPreview: run("DESTROY_PREVIEW") };
}

type Setup = {
  adapter: Adapter;
  flags: string[];
  paths: { request: string; manifest: string; unit: string; qualifications: string };
  prompts: string[];
  asked: number;
  /** How many times the second (project code) prompt was shown. */
  askedCode: number;
  stdout: string[];
  stderr: string[];
  deps: (terminal?: Partial<HumanTerminal>) => DriverCliDeps;
  parent: string;
  manifestHash: string;
  /** What the person types. Defaults to the exact target. */
  typed: string;
  /** What the person types at the project-code prompt. Defaults to the phrase the prompt names. */
  typedCode: string;
};

function setup(options: {
  behave?: Parameters<typeof fakeAdapter>[0];
  request?: (request: Record<string, unknown>) => void;
  qualified?: boolean;
} = {}): Setup {
  const dir = fresh("inputs");
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  writeFileSync(join(projectRoot, "main.tf"), 'resource "aws_s3_bucket" "logs" {}\n');
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), "# lock\n");
  const unit = recordDeletionUnit({
    buildId: "build-1", provider: "aws",
    stateRef: { engine: "TERRAFORM", backend: "s3", location: LOCATION, workspace: "default" },
    designHash: H("1"),
    createPlan: createChangeSet("TERRAFORM", [{ address: ADDRESS, type: "aws_s3_bucket", operation: "CREATE" }]),
    recordedAt: "2026-10-10T08:00:00.000Z",
  });
  const providers = [{ source: "registry.terraform.io/hashicorp/aws", version: "6.68.0" }];
  const inputs = [{ name: "aws_region", identity: H("f") }];
  const manifest = buildManifest({
    engine: "TERRAFORM", mode: "PROJECT", target: TARGET, unitHash: unit.unitHash, engineVersion: "1.16.5", providers,
    lockFileSha256: H("b"), files: captureProjectFiles(projectRoot), dependencies: [], inputs, policyVersion: "2026-10-07.1",
  });
  const adapter = fakeAdapter(options.behave);
  const record: QualificationRecord = {
    engine: "TERRAFORM", adapterVersion: adapter.adapterVersion, engineVersion: "1.16.5",
    argvDigest: adapter.argvDigest, qualifiedAt: "2026-10-10T07:00:00.000Z", evidenceHash: H("9"),
  };
  const request: Record<string, unknown> = {
    engine: "TERRAFORM", mode: "PROJECT", target: TARGET, projectRoot,
    policyVersion: "2026-10-07.1",
    resolved: { engineVersion: "1.16.5", providers, lockFileSha256: H("b"), dependencies: [], inputs },
  };
  options.request?.(request);
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const paths = {
    request: write("request.json", request), manifest: write("manifest.json", manifest),
    unit: write("unit.json", unit), qualifications: write("qualifications.json", options.qualified === false ? [] : [record]),
  };
  const parent = fresh("scratch");
  const state: Setup = {
    adapter, paths, parent, prompts: [], asked: 0, askedCode: 0, stdout: [], stderr: [], manifestHash: manifest.manifestHash,
    typed: targetString(TARGET),
    typedCode: "RUN PROJECT CODE",
    flags: ["--request", paths.request, "--manifest", paths.manifest, "--unit", paths.unit, "--qualifications", paths.qualifications],
    deps: (terminal = {}) => ({
      adapters: [adapter], env: { ...ENV }, now: () => new Date("2026-10-10T10:00:00.000Z"),
      scratchParent: parent, operatorId: "jane.doe",
      stdout: (text) => state.stdout.push(text), stderr: (text) => state.stderr.push(text),
      terminal: {
        stdinIsTTY: true, stdoutIsTTY: true,
        write: (text) => state.prompts.push(text),
        ask: async (question) => {
          if (question.startsWith("code>")) { state.askedCode += 1; return state.typedCode; }
          state.asked += 1;
          return state.typed;
        },
        ...terminal,
      },
    }),
  };
  return state;
}

const everythingShown = (s: Setup) => [...s.prompts, ...s.stdout, ...s.stderr].join("");
const nothingRan = (s: Setup) => {
  assert.equal(s.adapter.calls.length, 0, "the adapter must not be called");
  assert.deepEqual(readdirSync(s.parent), [], "nothing is left behind");
};

test("the command names are exactly the two preview entries", () => {
  assert.deepEqual([...DRIVER_COMMANDS], ["destroy-preview-run", "preview-run"]);
});

// --- Human invocation ------------------------------------------------------------

test("refused when stdin is not a TTY: no prompt, nothing read, nothing run", async () => {
  for (const terminal of [{ stdinIsTTY: false }, { stdoutIsTTY: false }, { stdinIsTTY: false, stdoutIsTTY: false }]) {
    const s = setup();
    // Unreadable paths prove the refusal comes before any input is opened.
    const flags = ["--request", "/nonexistent/a", "--manifest", "/nonexistent/b", "--unit", "/nonexistent/c", "--qualifications", "/nonexistent/d"];
    const code = await runDriverCommand("destroy-preview-run", flags, s.deps(terminal));
    assert.equal(code, EXIT.ERROR);
    assert.match(s.stderr.join(""), /HUMAN_TERMINAL_REQUIRED/);
    assert.equal(s.asked, 0, "no prompt");
    assert.deepEqual(s.prompts, []);
    assert.deepEqual(s.stdout, []);
    nothingRan(s);
  }
});

test("without the seam the real terminal is used, and a piped stdin is refused", { skip: process.stdin.isTTY ? "stdin is a terminal here" : false }, async () => {
  const s = setup();
  const { terminal: _unused, ...deps } = s.deps();
  const code = await runDriverCommand("destroy-preview-run", s.flags, deps);
  assert.equal(code, EXIT.ERROR);
  assert.match(s.stderr.join(""), /HUMAN_TERMINAL_REQUIRED/);
  nothingRan(s);
});

test("the shipped command refuses a piped stdin and prints no evidence", () => {
  const s = setup();
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli/teardown.ts"), "destroy-preview-run", ...s.flags],
    { encoding: "utf8", input: targetString(TARGET) + "\n", env: { ...process.env, ...ENV } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HUMAN_TERMINAL_REQUIRED/);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(CANARIES.join("|")));
});

test("refused on a wrong typed confirmation, for every field and for near misses", async () => {
  const exact = targetString(TARGET);
  const wrong = [
    "", "y", "yes", "YES", "default", exact + " ", " " + exact, exact.toUpperCase(),
    targetString({ ...TARGET, workspace: "prod" }), targetString({ ...TARGET, account: "999999999999" }),
    targetString({ ...TARGET, backend: "s3://alz-state/other/terraform.tfstate" }),
    exact + "\n" + exact,
  ];
  for (const typed of wrong) {
    const s = setup();
    s.typed = typed;
    const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
    assert.equal(code, EXIT.ERROR, JSON.stringify(typed));
    assert.match(s.stderr.join(""), /HUMAN_CONFIRMATION_MISMATCH/);
    assert.deepEqual(s.stdout, []);
    assert.equal(s.asked, 1);
    nothingRan(s);
  }
});

test("the prompt shows account, backend, workspace, engine and manifest hash, and asks for the exact target", async () => {
  const s = setup();
  await runDriverCommand("destroy-preview-run", s.flags, s.deps());
  const prompt = s.prompts.join("");
  for (const shown of [TARGET.account, TARGET.backend, TARGET.workspace, "TERRAFORM", s.manifestHash, targetString(TARGET)]) {
    assert.ok(prompt.includes(shown), shown);
  }
  assert.match(prompt, /DESTROY PREVIEW/);
  assert.match(prompt, /changes no infrastructure/);
});

test("a target with control characters is refused before any prompt", async () => {
  const s = setup({ request: (request) => { request.target = { ...TARGET, workspace: "default\u001b[2J" }; } });
  const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
  assert.equal(code, EXIT.ERROR);
  assert.equal(s.asked, 0);
  nothingRan(s);
});

// --- Success ---------------------------------------------------------------------

test("success: an injected fake adapter and confirmation print redacted evidence and exit 0", async () => {
  const s = setup();
  const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
  assert.equal(code, EXIT.PASS, s.stderr.join(""));
  assert.equal(s.adapter.calls.length, 1);
  assert.equal(s.adapter.calls[0].operation, "DESTROY_PREVIEW");
  assert.deepEqual(s.adapter.calls[0].context.identities, { providerReads: "DISCOVERY", stateReads: "STATE" });
  assert.equal(s.stdout.length, 1);
  const evidence = JSON.parse(s.stdout[0]) as PreviewEvidence;
  assert.equal(evidence.operation, "DESTROY_PREVIEW");
  assert.equal(evidence.verdict, "READY_FOR_AUTHORIZATION");
  assert.equal(evidence.label, "ARTIFACT_VALIDATED_DESTROY_PREVIEW");
  assert.equal(evidence.hashes.manifestHash, s.manifestHash);
  assert.deepEqual(evidence.invokedBy, { operatorId: "jane.doe", confirmedAt: "2026-10-10T10:00:00.000Z" });
  assert.deepEqual(evidence.authority, {
    infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false,
  });
  assert.deepEqual(evidence.changes.resources.map((r) => r.address), [ADDRESS]);
  assert.deepEqual(readdirSync(s.parent), []);
});

test("preview-run runs the ordinary preview, a separate operation", async () => {
  const s = setup();
  const code = await runDriverCommand("preview-run", s.flags, s.deps());
  assert.equal(code, EXIT.PASS, s.stderr.join(""));
  assert.equal(s.adapter.calls[0].operation, "PREVIEW");
  const evidence = JSON.parse(s.stdout[0]) as PreviewEvidence;
  assert.equal(evidence.operation, "PREVIEW");
  assert.equal(evidence.verdict, null);
  assert.match(s.prompts.join(""), /^\s*PREVIEW \(preview only/m);
});

// --- Output ----------------------------------------------------------------------

test("no canary secret reaches stdout, stderr or the prompt, on success or on failure", async () => {
  const ok = setup();
  await runDriverCommand("destroy-preview-run", ok.flags, ok.deps());
  const thrown = setup({ behave: () => { throw new Error("terraform said " + CANARY_THROWN + " " + CANARY_STATE); } });
  const failedCode = await runDriverCommand("destroy-preview-run", thrown.flags, thrown.deps());
  assert.equal(failedCode, EXIT.ERROR);
  assert.match(thrown.stderr.join(""), /ADAPTER_FAILED/);
  const leaky = setup({ behave: (request, operation) => {
    const good = buildEvidence({
      request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: fakeAdapter().argvDigest },
      observedEngineVersion: request.resolved.engineVersion,
      resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
      stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
    });
    return { ...good, rawPlan: { resource_changes: [{ change: { after: { password: CANARY_THROWN } } }] } } as unknown as PreviewEvidence;
  } });
  const leakyCode = await runDriverCommand("destroy-preview-run", leaky.flags, leaky.deps());
  assert.equal(leakyCode, EXIT.ERROR);
  assert.match(leaky.stderr.join(""), /EVIDENCE_REJECTED/);
  for (const s of [ok, thrown, leaky]) {
    for (const canary of CANARIES) assert.ok(!everythingShown(s).includes(canary), canary);
    assert.deepEqual(readdirSync(s.parent), []);
  }
  // Stdout holds nothing but the evidence document.
  assert.equal(thrown.stdout.length, 0);
  assert.equal(leaky.stdout.length, 0);
  assert.doesNotThrow(() => JSON.parse(ok.stdout.join("")));
});

test("unreadable or malformed input fails with fixed text that quotes nothing from the file", async () => {
  const s = setup();
  writeFileSync(s.paths.unit, '{"secret": "' + CANARY_STATE + '", oops');
  const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
  assert.equal(code, EXIT.ERROR);
  assert.match(s.stderr.join(""), /TEARDOWN_INPUT_INVALID: --unit cannot be read as a JSON file/);
  assert.ok(!everythingShown(s).includes(CANARY_STATE));
  nothingRan(s);
  const missing = setup();
  const code2 = await runDriverCommand("destroy-preview-run", missing.flags.map((f) => f === missing.paths.unit ? "/nonexistent/unit.json" : f), missing.deps());
  assert.equal(code2, EXIT.ERROR);
  nothingRan(missing);
});

// --- Exit codes ------------------------------------------------------------------

test("exit codes: PASS 0, BLOCKED 2 (verdict, REVIEW_REQUIRED, unqualified engine, bad manifest), error 1", async () => {
  assert.deepEqual(EXIT, { PASS: 0, ERROR: 1, BLOCKED: 2 });

  // The engine plans to delete something the unit never created: a negative verdict.
  const extra = setup({ behave: (request, operation) => buildEvidence({
    request, operation, adapter: { engine: "TERRAFORM", adapterVersion: "1.0.0", argvDigest: fakeAdapter().argvDigest },
    observedEngineVersion: request.resolved.engineVersion,
    resources: [
      { address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" },
      { address: "aws_s3_bucket.other", type: "aws_s3_bucket", operation: "DELETE" },
    ],
    stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
  }) });
  assert.equal(await runDriverCommand("destroy-preview-run", extra.flags, extra.deps()), EXIT.BLOCKED);
  assert.equal(JSON.parse(extra.stdout[0]).verdict, "BLOCKED");

  // Resolved inputs that differ from the approved manifest: REVIEW_REQUIRED.
  const drift = setup({ request: (request) => { request.policyVersion = "2026-10-08.1"; } });
  assert.equal(await runDriverCommand("destroy-preview-run", drift.flags, drift.deps()), EXIT.BLOCKED);
  assert.match(drift.stderr.join(""), /BLOCKED REVIEW_REQUIRED/);
  assert.deepEqual(drift.stdout, []);
  nothingRan(drift);

  // No qualification record: the engine does not run.
  const unqualified = setup({ qualified: false });
  assert.equal(await runDriverCommand("destroy-preview-run", unqualified.flags, unqualified.deps()), EXIT.BLOCKED);
  assert.match(unqualified.stderr.join(""), /ENGINE_NOT_QUALIFIED/);
  nothingRan(unqualified);

  // An identity missing: no fallback.
  const noState = setup();
  assert.equal(await runDriverCommand("destroy-preview-run", noState.flags,
    { ...noState.deps(), env: { ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: CANARY_DISCOVERY } }), EXIT.BLOCKED);
  assert.match(noState.stderr.join(""), /IDENTITY_NOT_CONFIGURED/);
  nothingRan(noState);

  // A manifest whose seal does not match.
  const tampered = setup();
  const manifest = JSON.parse(readFileSync(tampered.paths.manifest, "utf8"));
  manifest.policyVersion = "tampered";
  writeFileSync(tampered.paths.manifest, JSON.stringify(manifest));
  assert.equal(await runDriverCommand("destroy-preview-run", tampered.flags, tampered.deps()), EXIT.BLOCKED);
  assert.match(tampered.stderr.join(""), /MANIFEST_INVALID/);
  assert.equal(tampered.asked, 0);
  nothingRan(tampered);

  // Bad invocation of the command itself: an error.
  const bad = setup();
  assert.equal(await runDriverCommand("destroy-preview-run", [], bad.deps()), EXIT.ERROR);
  assert.equal(await runDriverCommand("destroy-preview-run", bad.flags.slice(0, 6), bad.deps()), EXIT.ERROR);
  nothingRan(bad);
});

// --- Flags and request fields ----------------------------------------------------

const BYPASS_SPELLINGS = [
  "force", "Force", "FORCE", "f", "yes", "Yes", "YES", "y", "Y", "assume-yes", "assumeyes", "assume_yes", "assumeYes",
  "auto-approve", "autoapprove", "auto_approve", "autoApprove", "AUTO-APPROVE", "approve", "confirm", "no-confirm",
  "noconfirm", "non-interactive", "batch", "skip", "skip-confirmation", "skip-validation", "ignore", "ignore-manifest",
  "override", "no-lock", "lock", "lock=false", "target", "tty", "no-tty", "unattended", "headless",
];

test("unknown flags are rejected, including force, yes, y, assume-yes and auto-approve in every spelling", async () => {
  for (const spelling of BYPASS_SPELLINGS) {
    for (const form of [["--" + spelling], ["--" + spelling, "true"], ["--" + spelling + "=true"], ["-" + spelling], [spelling]]) {
      const s = setup();
      const code = await runDriverCommand("destroy-preview-run", [...s.flags, ...form], s.deps());
      assert.equal(code, EXIT.ERROR, form.join(" "));
      assert.match(s.stderr.join(""), /TEARDOWN_FLAG_UNKNOWN/, form.join(" "));
      assert.equal(s.asked, 0, "no prompt for " + form.join(" "));
      assert.deepEqual(s.stdout, []);
      nothingRan(s);
    }
  }
  // Leading, too: nothing is skipped because it comes first.
  const first = setup();
  assert.equal(await runDriverCommand("preview-run", ["--yes", ...first.flags], first.deps()), EXIT.ERROR);
  nothingRan(first);
});

test("a repeated or valueless known flag is an error, and values cannot be flags", async () => {
  const dup = setup();
  assert.equal(await runDriverCommand("preview-run", [...dup.flags, "--unit", dup.paths.unit], dup.deps()), EXIT.ERROR);
  const valueless = setup();
  assert.equal(await runDriverCommand("preview-run", [...valueless.flags.slice(0, 7)], valueless.deps()), EXIT.ERROR);
  const flagAsValue = setup();
  assert.equal(await runDriverCommand("preview-run", ["--request", "--yes", ...flagAsValue.flags.slice(2)], flagAsValue.deps()), EXIT.ERROR);
  for (const s of [dup, valueless, flagAsValue]) nothingRan(s);
});

test("the request file cannot carry its own invocation, manifest or unit", async () => {
  for (const key of ["invocation", "manifest", "unit"]) {
    const s = setup({ request: (request) => { request[key] = { operatorId: "someone", interactiveSession: true }; } });
    const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
    assert.equal(code, EXIT.ERROR, key);
    assert.match(s.stderr.join(""), /must not carry/);
    assert.equal(s.asked, 0);
    nothingRan(s);
  }
});

test("an unknown field in the request file is refused by the driver, whatever it is called", async () => {
  for (const name of ["force", "yes", "assumeYes", "autoApprove", "skipValidation", "noLock"]) {
    const s = setup({ request: (request) => { request[name] = true; } });
    const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
    assert.equal(code, EXIT.BLOCKED, name);
    assert.match(s.stderr.join(""), /UNKNOWN_REQUEST_FIELD/);
    nothingRan(s);
  }
});

// --- Not reachable from an agent, the broker or the console ----------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const REACHES_DRIVER = /teardown\/driver|teardown-driver|cli\/teardown|["'`]\.\/teardown(\.js)?["'`]|destroy-preview-run|preview-run|runDestroyPreview|runPreview\b/;

test("the broker, the console and the agent do not import or mention the driver or its CLI", () => {
  const files = [
    resolve("src/tools/broker.ts"), resolve("src/tools/types.ts"),
    ...sourceFiles(resolve("src/operator-ui")), ...sourceFiles(resolve("src/agent")),
  ];
  assert.ok(files.length > 10);
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), REACHES_DRIVER, file);
  // No tool module anywhere imports it either.
  for (const name of readdirSync(resolve("src/tools")).filter((file) => file.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(resolve("src/tools"), name), "utf8"), REACHES_DRIVER, name);
  }
});

test("the tool allowlist is unchanged and offers no preview-run, destroy or mutation", () => {
  const posture = getToolSecurityPosture();
  assert.equal(posture.allowedTools.length, 39);
  assert.ok(posture.allowedTools.every((tool) => !/destroy|driver|preview_run|apply|teardown/i.test(tool)), posture.allowedTools.join());
  assert.deepEqual(posture.mutationTools, []);
  assert.equal(posture.arbitraryShell, false);
});

test("the CLI module has no environment or file route around the prompt", () => {
  const source = readFileSync(resolve("src/cli/teardown-driver.ts"), "utf8");
  // The only environment access is the default for the env parameter.
  assert.deepEqual([...source.matchAll(/process\.env\b/g)].length, 1);
  assert.doesNotMatch(source, /process\.env\.\w/);
  // No flag-shaped literal for a bypass appears in the module's code.
  assert.doesNotMatch(source, /["'`]--?(yes|y|force|assume-yes|auto-approve|skip|ignore|override)["'`]/i);
});

// --- Capabilities come from the person, not from a file ---------------------------------

test("a request file that carries capabilities is refused before any prompt", async () => {
  for (const capabilities of [{ cloudRead: true, projectCodeExecution: true }, {}, null]) {
    const s = setup({ request: (request) => { request.capabilities = capabilities; } });
    const code = await runDriverCommand("destroy-preview-run", s.flags, s.deps());
    assert.equal(code, EXIT.ERROR);
    assert.match(s.stderr.join(""), /must not carry capabilities/);
    assert.equal(s.asked + s.askedCode, 0, "no prompt");
    nothingRan(s);
  }
});

test("PROJECT mode shows that project code runs and needs its own typed approval, which no near miss satisfies", async () => {
  const s = setup();
  assert.equal(await runDriverCommand("destroy-preview-run", s.flags, s.deps()), EXIT.PASS, s.stderr.join(""));
  assert.equal(s.askedCode, 1);
  const prompt = s.prompts.join("");
  assert.match(prompt, /RUNS PROJECT CODE/);
  assert.match(prompt, /DISCOVERY identity/);
  assert.match(prompt, /changes no infrastructure/);
  assert.match(prompt, /files bound\s+2/);
  assert.ok(prompt.includes("Type RUN PROJECT CODE"));

  for (const typed of ["", "y", "yes", "run project code", "RUN PROJECT CODE ", " RUN PROJECT CODE", targetString(TARGET), "RUN"]) {
    const refused = setup();
    refused.typedCode = typed;
    const code = await runDriverCommand("destroy-preview-run", refused.flags, refused.deps());
    assert.equal(code, EXIT.ERROR, JSON.stringify(typed));
    assert.match(refused.stderr.join(""), /PROJECT_CODE_CONFIRMATION_MISMATCH/);
    assert.deepEqual(refused.stdout, []);
    nothingRan(refused);
  }
});

test("the second prompt is not asked before the target is confirmed, and the granted capabilities are exactly what was confirmed", async () => {
  const wrongTarget = setup();
  wrongTarget.typed = "nope";
  await runDriverCommand("destroy-preview-run", wrongTarget.flags, wrongTarget.deps());
  assert.equal(wrongTarget.askedCode, 0);

  const s = setup();
  await runDriverCommand("destroy-preview-run", s.flags, s.deps());
  assert.equal(s.adapter.calls.length, 1);
});

test("signal handlers are installed only for the run, so a signal ends in cleanup and not in an abrupt death", async () => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  let during: number[] = [];
  const s = setup({
    behave: (request, operation) => {
      during = signals.map((signal) => process.listenerCount(signal));
      return buildEvidence({
        request, operation, adapter: { engine: s.adapter.engine, adapterVersion: s.adapter.adapterVersion, argvDigest: s.adapter.argvDigest },
        observedEngineVersion: request.resolved.engineVersion,
        resources: [{ address: ADDRESS, type: "aws_s3_bucket", operation: "DELETE" }],
        stateVersion: { kind: "TERRAFORM_SERIAL", value: "42", observedAt: "2026-10-10T09:00:00.000Z" },
      });
    },
  });
  assert.equal(await runDriverCommand("destroy-preview-run", s.flags, s.deps()), EXIT.PASS, s.stderr.join(""));
  assert.deepEqual(during, before.map((count) => count + 1), "one handler per signal while the engine runs");
  assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before, "removed afterwards");
});
