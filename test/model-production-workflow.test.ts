import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

// .github/workflows/model-production-qualification.yml. The model run itself needs a dedicated host, so these tests run
// the workflow's own shell steps against fake `ollama`, `terraform` and `alz` programs and check that each failure
// stops the job and that cleanup touches only this run's process. They are orchestration tests, not qualification.

const FILE = ".github/workflows/model-production-qualification.yml";
const workflow = readFileSync(FILE, "utf8");

type Step = { name: string; run: string; cond: string };

/** The job's steps: their names, `if:` lines and `run:` scripts (the file is plain block YAML, so no parser is needed). */
function steps(): Step[] {
  const body = workflow.slice(workflow.indexOf("    steps:\n") + "    steps:\n".length);
  return body.split(/\n(?=      - name: )/).map((chunk) => {
    const name = /- name: (.+)/.exec(chunk)?.[1] ?? "";
    const cond = /\n        if: (.+)/.exec(chunk)?.[1] ?? "";
    const block = /\n        run: \|\n((?:          .*\n?|\n)+)/.exec(chunk + "\n");
    const single = /\n        run: (?!\|)(.+)/.exec(chunk);
    const run = block ? block[1].split("\n").map((line) => line.slice(10)).join("\n") : single ? single[1] : "";
    return { name, run, cond };
  });
}
const stepNamed = (name: string): Step => {
  const found = steps().find((step) => step.name === name);
  assert.ok(found, "step " + name);
  return found!;
};

test("the workflow only qualifies: no pull, plan, apply, destroy or deploy, and no failure is swallowed", () => {
  const code = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /ollama pull|terraform (apply|destroy|plan)|--terraform-plan|pulumi up|cdk deploy|aws iam create/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  const swallowing = steps().filter((step) => /\|\| true/.test(step.run)).map((step) => step.name);
  assert.deepEqual(swallowing, ["Stop isolated Ollama"], "only cleanup may ignore a failure");
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, alz-private-model\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  const jobEnv = workflow.slice(workflow.indexOf("    env:\n"), workflow.indexOf("    steps:\n"));
  assert.doesNotMatch(jobEnv, /runner\./, "the runner context is not allowed in job-level env");
});

test("the steps run in the documented order and cleanup, diagnostics and evidence always run", () => {
  const order = [
    "Validate dispatch inputs", "Verify local Terraform toolchain", "Verify pinned local Ollama", "Start isolated Ollama",
    "Verify pre-staged model weights", "Run native target preflight", "Pre-restart real inference smoke", "Restart isolated Ollama",
    "Recheck target after restart", "Qualify real production-target models", "Compile source-bound runtime",
    "Run private-model adversarial qualification", "Qualify live-model Terraform agent loop", "Qualify all live-model scenario paths",
    "Stop isolated Ollama", "Collect service diagnostics", "Upload qualification and failure evidence", "Remove run scratch directory",
    "Write qualification summary",
  ];
  const names = steps().map((step) => step.name);
  let last = -1;
  for (const name of order) {
    const at = names.indexOf(name);
    assert.ok(at > last, name + " is missing or out of order");
    last = at;
  }
  for (const name of ["Stop isolated Ollama", "Collect service diagnostics", "Upload qualification and failure evidence", "Remove run scratch directory", "Write qualification summary"]) {
    assert.equal(stepNamed(name).cond, "always()", name);
  }
  assert.match(stepNamed("Qualify all live-model scenario paths").cond, /live_scenario_scope == 'all'/);
  assert.match(stepNamed("Qualify live-model Terraform agent loop").run, /--live-models\s+\\?\s*--terraform-validate/);
});

test("every command the workflow runs exists in the repository with the flags it passes", () => {
  for (const [file, flag] of [
    ["src/cli/target-preflight.ts", "--target-hardware-id"], ["src/cli/target-preflight.ts", "--output"],
    ["src/cli/private-model-adversarial.ts", "--scope"], ["src/cli/qualify-aws-terraform-agent.ts", "--terraform-validate"],
    ["src/cli/qualify-aws-terraform-agent.ts", "--live-models"], ["src/cli/private-agent-matrix.ts", "--live-models"],
    ["src/cli/models.ts", "--production"], ["src/cli/models.ts", "--model"],
  ]) {
    assert.ok(readFileSync(file, "utf8").includes(flag), file + " " + flag);
  }
  assert.ok(existsSync("alz"));
});

test("actions are pinned to the same commits as the repository's other workflows", () => {
  const others = ["pr-validation.yml", "supply-chain.yml", "model-qualification.yml"].map((f) => readFileSync(".github/workflows/" + f, "utf8")).join("\n");
  for (const used of workflow.match(/uses: [^\s]+@[0-9a-f]{40}/g) ?? []) assert.ok(others.includes(used), used);
  assert.equal((workflow.match(/uses: /g) ?? []).length, (workflow.match(/uses: [^\s]+@[0-9a-f]{40}/g) ?? []).length, "every action is pinned by SHA");
});

// --- running the shell steps against fakes -------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "alz-modelwf-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const FAKE_OLLAMA = `#!${process.execPath}
const http = require("node:http");
const [, , cmd, arg] = process.argv;
const env = process.env;
if (cmd === "--version") { console.log("ollama version is " + (env.FAKE_OLLAMA_VERSION || "0.40.0")); process.exit(0); }
if (cmd === "show") { process.exit((env.FAKE_MISSING_MODEL || "") === arg ? 1 : 0); }
if (cmd === "serve") {
  if (env.FAKE_SERVE_FAIL === "1") { console.error("fake startup failure"); process.exit(1); }
  const port = Number((env.OLLAMA_HOST || "").split(":")[1]);
  http.createServer((req, res) => { res.end("{}"); }).listen(port, "127.0.0.1");
  process.on("SIGTERM", () => { if (env.FAKE_IGNORE_TERM !== "1") process.exit(0); });
  setInterval(() => {}, 1000);
} else { process.exit(0); }
`;

/** A PATH holding only the tools the steps need, so a terraform on the host cannot hide a missing one. */
function toolDir(name: string, extras: Record<string, string> = {}): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  for (const tool of ["bash", "cat", "tee", "sleep", "curl", "mkdir", "cp", "rm", "nohup", "date", "uname", "nproc", "dirname", "env", "printf", "kill", "git", "head", "tail"]) {
    for (const base of ["/usr/bin", "/bin"]) {
      if (existsSync(join(base, tool))) { symlinkSync(join(base, tool), join(dir, tool)); break; }
    }
  }
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(join(dir, "ollama"), FAKE_OLLAMA);
  chmodSync(join(dir, "ollama"), 0o755);
  for (const [file, text] of Object.entries(extras)) {
    writeFileSync(join(dir, file), "#!/bin/sh\n" + text + "\n");
    chmodSync(join(dir, file), 0o755);
  }
  return dir;
}

type Ran = { code: number | null; out: string; env: string };
type Job = { cwd: string; tmp: string; githubEnv: string; env: NodeJS.ProcessEnv };

function job(label: string, bin: string, extra: NodeJS.ProcessEnv = {}): Job {
  const cwd = join(scratch, label);
  const runner = join(cwd, "runner-temp");
  mkdirSync(runner, { recursive: true });
  const githubEnv = join(cwd, "github-env");
  writeFileSync(githubEnv, "");
  const tmp = join(runner, "alz-model-1-1");
  mkdirSync(join(cwd, ".runs/qualification/diagnostics"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return {
    cwd, tmp, githubEnv,
    env: {
      PATH: [bin, dirname(process.execPath)].join(delimiter), HOME: cwd,
      OLLAMA_HOST: "127.0.0.1:11435", OLLAMA_BASE_URL: "http://127.0.0.1:11435",
      ALZ_TARGET_HARDWARE_ID: "profile-01", ALZ_MODEL_LONG_RUN_TURNS: "4", ALZ_OLLAMA_MODELS_DIR: "",
      QUALIFICATION_TMP: tmp, RUNNER_TEMP: runner, GITHUB_ENV: githubEnv, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", ...extra,
    },
  };
}

/** Runs one workflow step exactly as the runner would (`bash -eo pipefail`), with a bounded time. */
function run(step: string, j: Job, over: NodeJS.ProcessEnv = {}, limitMs = 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(join(j.env.PATH!.split(delimiter)[0], "bash"), ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepNamed(step).run], {
      cwd: j.cwd, env: { ...j.env, ...over },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, env: readFileSync(j.githubEnv, "utf8") });
    });
  });
}
/** Running means signalable and not a zombie: an exited child that nothing reaped (e.g. PID 1 in a container) is stopped. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z /.test(readFileSync("/proc/" + pid + "/stat", "utf8")); } catch { return true; }
};
/** SIGKILL is asynchronous: give the kernel a moment to finish before judging. */
async function ended(pid: number): Promise<boolean> {
  for (let i = 0; i < 20 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}
const pidOf = (j: Job): number => Number(readFileSync(join(j.tmp, "ollama.pid"), "utf8"));

test("dispatch inputs: a bad or UNKNOWN hardware ID, a short or non-numeric turn count and a bad model path stop the job", async () => {
  const bin = toolDir("bin-inputs");
  const good = job("inputs-good", bin);
  assert.equal((await run("Validate dispatch inputs", good)).code, 0);
  for (const over of [
    { ALZ_TARGET_HARDWARE_ID: "UNKNOWN" }, { ALZ_TARGET_HARDWARE_ID: "unknown" }, { ALZ_TARGET_HARDWARE_ID: "-bad" },
    { ALZ_TARGET_HARDWARE_ID: "a b" }, { ALZ_TARGET_HARDWARE_ID: "a".repeat(65) }, { ALZ_TARGET_HARDWARE_ID: "" },
    { ALZ_MODEL_LONG_RUN_TURNS: "four" }, { ALZ_OLLAMA_MODELS_DIR: "relative/path" }, { ALZ_OLLAMA_MODELS_DIR: "/a/../b" },
    { ALZ_OLLAMA_MODELS_DIR: join(scratch, "no-such-dir") },
  ]) {
    const result = await run("Validate dispatch inputs", job("inputs-bad", bin), over);
    assert.notEqual(result.code, 0, JSON.stringify(over));
  }
  // A real model store is exported for the isolated service, and only then.
  const store = join(scratch, "model-store");
  mkdirSync(store);
  const withStore = await run("Validate dispatch inputs", job("inputs-store", bin), { ALZ_OLLAMA_MODELS_DIR: store });
  assert.equal(withStore.code, 0);
  assert.match(withStore.env, new RegExp("OLLAMA_MODELS=" + store));
  assert.doesNotMatch((await run("Validate dispatch inputs", job("inputs-nostore", bin))).env, /OLLAMA_MODELS/);
});

test("a missing Terraform stops the job", async () => {
  const bin = toolDir("bin-no-terraform");
  const missing = await run("Verify local Terraform toolchain", job("tf-missing", bin));
  assert.notEqual(missing.code, 0);
  const present = toolDir("bin-terraform", { terraform: 'echo "Terraform v1.16.4"' });
  const ok = await run("Verify local Terraform toolchain", job("tf-present", present));
  assert.equal(ok.code, 0);
  assert.match(readFileSync(join(scratch, "tf-present", ".runs/qualification/diagnostics/terraform-version.txt"), "utf8"), /Terraform v1\.16\.4/);
});

test("an incorrect Ollama version stops the job; the pinned one is recorded", async () => {
  const bin = toolDir("bin-version");
  assert.equal((await run("Verify pinned local Ollama", job("ver-bad", bin), { FAKE_OLLAMA_VERSION: "0.41.0" })).code, 1);
  assert.equal((await run("Verify pinned local Ollama", job("ver-old", bin), { FAKE_OLLAMA_VERSION: "0.39.9" })).code, 1);
  const good = await run("Verify pinned local Ollama", job("ver-good", bin));
  assert.equal(good.code, 0);
  assert.match(good.env, /ALZ_OLLAMA_VERSION=ollama version is 0\.40\.0/);
});

test("a missing pre-staged model stops the job, naming the model, and nothing is pulled", async () => {
  const bin = toolDir("bin-models");
  assert.equal((await run("Verify pre-staged model weights", job("models-ok", bin))).code, 0);
  for (const model of ["qwen3:1.7b", "qwen3:4b", "mistral-nemo:12b"]) {
    const result = await run("Verify pre-staged model weights", job("models-missing", bin), { FAKE_MISSING_MODEL: model });
    assert.equal(result.code, 1, model);
    assert.ok(result.out.includes(model), model);
  }
});

test("an occupied port stops the job before any Ollama starts", async () => {
  const bin = toolDir("bin-port");
  const blocker: Server = createServer();
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(11435, "127.0.0.1", resolve); });
  try {
    const j = job("port", bin);
    const result = await run("Start isolated Ollama", j);
    assert.notEqual(result.code, 0);
    assert.ok(!existsSync(join(j.tmp, "ollama.pid")), "no service was launched");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("a service that exits during startup stops the job with its log", async () => {
  const j = job("startup-fail", toolDir("bin-startup"));
  const result = await run("Start isolated Ollama", j, { FAKE_SERVE_FAIL: "1" });
  assert.equal(result.code, 1);
  assert.match(result.out, /fake startup failure/);
  assert.match(result.out, /Ollama exited during startup/);
});

test("start, restart and stop: the restart replaces the process, and cleanup ends only this run's process", async () => {
  const bin = toolDir("bin-lifecycle");
  const j = job("lifecycle", bin);
  const decoy = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
  decoy.unref();
  try {
    assert.equal((await run("Start isolated Ollama", j)).code, 0);
    const first = pidOf(j);
    assert.ok(alive(first));
    const restarted = await run("Restart isolated Ollama", j);
    assert.equal(restarted.code, 0, restarted.out);
    assert.match(restarted.env, /ALZ_MODEL_RESTART_VERIFIED=1/);
    const second = pidOf(j);
    assert.notEqual(second, first);
    assert.ok(!alive(first) && alive(second));
    assert.equal((await run("Stop isolated Ollama", j)).code, 0);
    assert.ok(await ended(second), "this run's service is stopped");
    assert.ok(alive(decoy.pid!), "an unrelated process is untouched");
    const diagnostics = await run("Collect service diagnostics", j);
    assert.equal(diagnostics.code, 0);
    assert.ok(existsSync(join(j.cwd, ".runs/qualification/diagnostics/ollama-restarted.log")));
    assert.equal((await run("Remove run scratch directory", j)).code, 0);
    assert.ok(!existsSync(j.tmp));
  } finally {
    try { process.kill(decoy.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("a service that will not stop fails the restart, and cleanup still ends it", async () => {
  const j = job("restart-fail", toolDir("bin-restart"));
  const env = { FAKE_IGNORE_TERM: "1" };
  assert.equal((await run("Start isolated Ollama", j, env)).code, 0);
  const pid = pidOf(j);
  const restart = await run("Restart isolated Ollama", j, env);
  assert.equal(restart.code, 1);
  assert.match(restart.out, /did not stop/);
  assert.ok(alive(pid));
  assert.equal((await run("Stop isolated Ollama", j, env)).code, 0);
  assert.ok(await ended(pid), "cleanup escalates to KILL for this run's process only");
});

test("a failing qualification command fails its step, so no later step can report a pass", async () => {
  const j = job("qualify-fail", toolDir("bin-qualify"));
  writeFileSync(join(j.cwd, "alz"), "#!/bin/sh\necho 'MODEL_TIMEOUT: qwen3:4b exceeded 120000ms' >&2\nexit 1\n");
  chmodSync(join(j.cwd, "alz"), 0o755);
  const result = await run("Qualify real production-target models", j);
  assert.equal(result.code, 1);
  assert.match(result.out, /MODEL_TIMEOUT/);
  // The summary reports the job's status, never a fixed pass.
  assert.match(stepNamed("Write qualification summary").run, /Result: \$\{RESULT\}/);
  assert.match(workflow, /RESULT: \$\{\{ job\.status \}\}/);
});
