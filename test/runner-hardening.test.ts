import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { withDebugDiagnosticContext } from "../src/debug/context.js";
import {
  approvedToolDirs,
  buildChildEnvironment,
  hostApproved,
  redactSecrets,
  resolveExecutable,
} from "../src/tools/child-env.js";
import { runAllowlistedProcess, runBoundedProcess } from "../src/tools/process.js";
import { createChildSandbox, createPrivateDirectory } from "../src/tools/private-workdir.js";
import { NEVER_INJECTABLE, PROFILES, type ProcessProfile } from "../src/tools/profiles.js";

// docs/runner-hardening.md. The child here is `node` so behavior can be
// observed for real: what environment it sees, what it can read, what it is
// given as arguments. The runner is the unit under test, not node.

const NODE = basename(process.execPath);
const NODE_DIRS = [dirname(process.execPath)];
const work = mkdtempSync(join(tmpdir(), "alz-runner-test-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

const PRINT_ENV = "process.stdout.write(JSON.stringify(process.env))";

function run(
  script: string,
  env: NodeJS.ProcessEnv,
  options: { profile?: ProcessProfile; identity?: string; args?: string[]; cwd?: string } = {},
) {
  return runBoundedProcess("terraform_version", NODE, ["-e", script, ...(options.args ?? [])], options.cwd ?? work, {
    profile: options.profile ?? PROFILES.aws, env, toolDirs: NODE_DIRS, identity: options.identity,
  });
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** What the child received for `name`, as a hash (or "absent"), so a secret is never printed. */
const fingerprint = (env: NodeJS.ProcessEnv, name: string, identity?: string) => run(
  `const v = process.env[${JSON.stringify(name)}];
   process.stdout.write(v === undefined ? "absent" : require("crypto").createHash("sha256").update(v).digest("hex"))`,
  env, { identity }).stdout;
const childEnv = (env: NodeJS.ProcessEnv, options = {}) =>
  JSON.parse(run(PRINT_ENV, env, options).stdout) as Record<string, string>;

test("unrelated credentials and the operator's credential files are not inherited", () => {
  const operatorHome = join(work, "operator-home");
  mkdirSync(join(operatorHome, ".aws"), { recursive: true });
  writeFileSync(join(operatorHome, ".aws", "credentials"), "[default]\naws_access_key_id=AKIAOPERATORSECRET\n");
  const parent: NodeJS.ProcessEnv = {
    HOME: operatorHome, PATH: "/somewhere/else", LANG: "en_GB.UTF-8",
    AWS_ACCESS_KEY_ID: "AKIAAMBIENT00000001", AWS_SECRET_ACCESS_KEY: "ambient-secret-key-0001",
    AWS_SESSION_TOKEN: "ambient-session-token", AWS_PROFILE: "operator", AZURE_CLIENT_SECRET: "ambient-azure-secret",
    ARM_CLIENT_SECRET: "ambient-arm-secret", GITHUB_TOKEN: "ghp_ambient", NPM_TOKEN: "npm_ambient",
    ANTHROPIC_API_KEY: "sk-ambient", PULUMI_ACCESS_TOKEN: "pul-ambient", SSH_AUTH_SOCK: "/tmp/agent.sock",
    TF_VAR_db_password: "ambient-password", TF_TOKEN_app_terraform_io: "tf-ambient", KUBECONFIG: "/home/op/.kube/config",
    LD_PRELOAD: "/tmp/evil.so", NODE_OPTIONS: "--require /tmp/evil.js",
  };
  const seen = childEnv(parent);
  assert.deepEqual(Object.keys(seen).sort(), ["CI", "HOME", "LANG", "PATH", "TF_IN_AUTOMATION", "TMPDIR"]);
  assert.equal(seen.LANG, "en_GB.UTF-8");
  assert.equal(seen.PATH, NODE_DIRS.join(":"), "PATH is the approved directories, not the inherited one");
  assert.notEqual(seen.HOME, operatorHome);
  // The strongest check: the child cannot reach the operator's credential file through HOME.
  const reach = run(`const fs=require("fs"),p=require("path").join(process.env.HOME,".aws","credentials");
    process.stdout.write(JSON.stringify({exists:fs.existsSync(p),home:process.env.HOME}))`, parent);
  const outcome = JSON.parse(reach.stdout) as { exists: boolean; home: string };
  assert.equal(outcome.exists, false);
  assert.equal(existsSync(outcome.home), false, "the private HOME is removed after the run");
  assert.equal(JSON.stringify(reach).includes("AKIAOPERATORSECRET"), false);
});

test("credentials arrive only through an explicit, named identity and only if the profile lists them", () => {
  const parent: NodeJS.ProcessEnv = {
    ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: "AKIADISCOVERY000001", ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: "discovery-secret-value",
    ALZ_DISCOVERY_AWS_REGION: "eu-west-1",
    // Not on the aws profile, or never injectable at all:
    ALZ_DISCOVERY_GITHUB_TOKEN: "ghp_nope", ALZ_DISCOVERY_PATH: "/evil", ALZ_DISCOVERY_HOME: "/root",
    ALZ_DISCOVERY_LD_PRELOAD: "/evil.so", ALZ_DISCOVERY_NODE_OPTIONS: "--require /evil.js",
    ALZ_STATE_AWS_ACCESS_KEY_ID: "AKIASTATE0000000001",
  };
  const result = run(PRINT_ENV, parent);
  const seen = JSON.parse(result.stdout) as Record<string, string>;
  // A secret that reaches the child is redacted if the child echoes it, so delivery is proven by fingerprint.
  assert.equal(fingerprint(parent, "AWS_ACCESS_KEY_ID"), sha("AKIADISCOVERY000001"));
  assert.equal(fingerprint(parent, "AWS_SECRET_ACCESS_KEY"), sha("discovery-secret-value"));
  assert.equal(seen.AWS_ACCESS_KEY_ID, "[REDACTED]");
  assert.equal(seen.AWS_REGION, "eu-west-1");
  for (const name of ["GITHUB_TOKEN", "LD_PRELOAD", "NODE_OPTIONS"]) assert.equal(name in seen, false, name);
  assert.equal(seen.PATH, NODE_DIRS.join(":"));
  assert.notEqual(seen.HOME, "/root");
  // The refusals are reported by name so the denial is actionable, never by value.
  assert.deepEqual(result.refusedEnvironment, [
    "ALZ_DISCOVERY_GITHUB_TOKEN", "ALZ_DISCOVERY_HOME", "ALZ_DISCOVERY_LD_PRELOAD",
    "ALZ_DISCOVERY_NODE_OPTIONS", "ALZ_DISCOVERY_PATH",
  ]);
  assert.equal(JSON.stringify(result.refusedEnvironment).includes("/evil"), false);
  // Identities do not bleed into each other.
  assert.equal(fingerprint(parent, "AWS_ACCESS_KEY_ID", "STATE"), sha("AKIASTATE0000000001"));
  assert.equal(fingerprint(parent, "AWS_ACCESS_KEY_ID"), sha("AKIADISCOVERY000001"));
  assert.equal(fingerprint({ ALZ_STATE_AWS_ACCESS_KEY_ID: "AKIASTATE0000000001" }, "AWS_ACCESS_KEY_ID"), "absent");
  assert.throws(() => childEnv(parent, { identity: "bad-name" }), /CHILD_IDENTITY_INVALID/);
});

test("a profile can never make PATH, HOME, loader or interpreter variables injectable", () => {
  const permissive: ProcessProfile = { ...PROFILES.aws,
    injectable: ["PATH", "HOME", "TMPDIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV", "AWS_REGION"],
    injectablePrefixes: ["LD_"] };
  const parent = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "BASH_ENV", "AWS_REGION"]
    .map((name) => ["ALZ_DISCOVERY_" + name, "/evil"]));
  const built = buildChildEnvironment({ profile: permissive, base: parent, toolDirs: ["/usr/bin"], home: "/h", tmp: "/t" });
  assert.deepEqual(Object.keys(built.env).sort(), ["AWS_REGION", "CI", "HOME", "PATH", "TF_IN_AUTOMATION", "TMPDIR"]);
  assert.equal(built.env.PATH, "/usr/bin");
  assert.equal(built.env.HOME, "/h");
  for (const [executable, profile] of Object.entries(PROFILES)) {
    for (const name of profile.injectable) assert.doesNotMatch(name, NEVER_INJECTABLE, executable + ": " + name);
    for (const prefix of profile.injectablePrefixes) assert.doesNotMatch(prefix + "X", NEVER_INJECTABLE, executable + ": " + prefix);
  }
});

test("endpoint and proxy overrides must name an approved host", () => {
  const seen = (extra: NodeJS.ProcessEnv) => childEnv({ ...extra });
  assert.equal(seen({ ALZ_DISCOVERY_AWS_ENDPOINT_URL: "https://sts.eu-west-1.amazonaws.com" }).AWS_ENDPOINT_URL,
    "https://sts.eu-west-1.amazonaws.com");
  assert.equal(seen({ ALZ_DISCOVERY_AWS_ENDPOINT_URL: "http://127.0.0.1:4566" }).AWS_ENDPOINT_URL, "http://127.0.0.1:4566");
  assert.equal("AWS_ENDPOINT_URL" in seen({ ALZ_DISCOVERY_AWS_ENDPOINT_URL: "https://attacker.example" }), false);
  assert.equal("AWS_ENDPOINT_URL" in seen({ ALZ_DISCOVERY_AWS_ENDPOINT_URL: "https://sts.amazonaws.com.attacker.example" }), false);
  // The operator can approve a destination deliberately.
  assert.equal(seen({ ALZ_DISCOVERY_AWS_ENDPOINT_URL: "https://vpce.corp.example.com", ALZ_APPROVED_HOSTS: "*.corp.example.com" })
    .AWS_ENDPOINT_URL, "https://vpce.corp.example.com");
  // Proxy settings come through the network channel, not an identity.
  assert.equal(seen({ ALZ_NETWORK_HTTPS_PROXY: "127.0.0.1:3128" }).HTTPS_PROXY, "127.0.0.1:3128");
  assert.equal("HTTPS_PROXY" in seen({ ALZ_NETWORK_HTTPS_PROXY: "http://proxy.attacker.example:3128" }), false);
  assert.equal("HTTPS_PROXY" in seen({ ALZ_DISCOVERY_HTTPS_PROXY: "127.0.0.1:3128" }), false);
  for (const [value, expected] of [
    ["https://ec2.us-east-1.amazonaws.com", true], ["https://amazonaws.com", false], ["https://evilamazonaws.com", false],
    ["https://x.amazonaws.com.evil.com", false], ["not a url at all %%", false], ["https://[::1]:8443", true],
  ] as const) assert.equal(hostApproved(value, ["*.amazonaws.com"]), expected, value);
});

test("executables resolve only from approved, non-world-writable directories, by bare name", () => {
  const open = mkdtempSync(join(tmpdir(), "alz-open-"));
  chmodSync(open, 0o777);
  const closed = mkdtempSync(join(tmpdir(), "alz-closed-"));
  const dirs = approvedToolDirs({ ALZ_TOOL_DIRS: [open, closed, "relative/dir", "/does/not/exist"].join(":") });
  assert.equal(dirs.includes(open), false, "world-writable directory refused");
  assert.equal(dirs.includes(closed), true);
  assert.equal(dirs.some((d) => d === "relative/dir" || d === "/does/not/exist"), false);
  writeFileSync(join(closed, "tool-a"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(closed, "tool-b"), "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(resolveExecutable("tool-a", [closed]), join(closed, "tool-a"));
  assert.equal(resolveExecutable("tool-b", [closed]), undefined, "not executable");
  for (const name of ["../tool-a", "a/b", "/usr/bin/env", "", "tool a", "tool;a"]) {
    assert.equal(resolveExecutable(name, [closed]), undefined, name);
  }
  // A binary sitting in the working directory is never found: the working directory is not on the lookup path.
  const cwd = mkdtempSync(join(tmpdir(), "alz-cwd-"));
  writeFileSync(join(cwd, "planted"), "#!/bin/sh\n", { mode: 0o755 });
  const planted = runBoundedProcess("terraform_version", "planted", [], cwd, { profile: PROFILES.aws, toolDirs: [closed] });
  assert.equal(planted.ok, false);
  assert.match(planted.stderr, /not found in the approved tool directories.*ALZ_TOOL_DIRS/s);
  assert.deepEqual(planted.command, ["planted"]);
  for (const dir of [open, closed, cwd]) rmSync(dir, { recursive: true, force: true });
});

test("working directory must exist and stay inside the allowed root", () => {
  const options = { profile: PROFILES.aws, toolDirs: NODE_DIRS, root: work };
  assert.match(runBoundedProcess("terraform_version", NODE, ["-v"], join(work, "missing"), options).stderr, /does not exist/);
  const escaped = runBoundedProcess("terraform_version", NODE, ["-v"], resolve(work, ".."), options);
  assert.equal(escaped.blocked, true);
  assert.match(escaped.stderr, /escapes the allowed root/);
  assert.equal(runBoundedProcess("terraform_version", NODE, ["-v"], work, options).ok, true);
});

test("arguments are passed as data: no shell, no interpretation", () => {
  const args = ["; echo pwned", "$(id)", "`id`", "a b", "&& true", "'quoted'"];
  const result = run("process.stdout.write(JSON.stringify(process.argv.slice(1)))", {}, { args });
  assert.deepEqual(JSON.parse(result.stdout), args);
  const source = readFileSync("src/tools/process.ts", "utf8");
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /shell:\s*true|\bexecSync\b|\bexec\(|\bexecFile\(/);
  for (const bad of [{ exe: "../bin/sh", args: [] }, { exe: "sh -c id", args: [] }, { exe: NODE, args: ["a\0b"] }]) {
    const blocked = runBoundedProcess("terraform_version", bad.exe, bad.args, work, { profile: PROFILES.aws, toolDirs: NODE_DIRS });
    assert.equal(blocked.blocked, true, bad.exe);
  }
});

test("a runaway child is stopped by the time limit and the output cap", () => {
  const quick: ProcessProfile = { ...PROFILES.aws, timeoutMs: 400 };
  const slow = run("setTimeout(() => {}, 30000)", {}, { profile: quick });
  assert.equal(slow.ok, false);
  assert.ok(slow.durationMs < 10_000, "killed, not waited for");
  assert.match(slow.stderr, /ETIMEDOUT/);

  const capped: ProcessProfile = { ...PROFILES.aws, maxOutputBytes: 2048 };
  const loud = run('process.stdout.write("x".repeat(500000))', {}, { profile: capped });
  assert.equal(loud.ok, false);
  assert.equal(loud.truncated, true);
  assert.ok(loud.stdout.length <= 2048, "output was " + loud.stdout.length + " bytes");
});

test("injected secrets are redacted from output, and engine tools log no output excerpts", async () => {
  const secret = "super-secret-value-123456";
  const env = { ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: secret };
  const echo = `process.stdout.write(process.env.AWS_SECRET_ACCESS_KEY); process.stderr.write("fail: " + process.env.AWS_SECRET_ACCESS_KEY); process.exit(1)`;
  const plain = await withDebugDiagnosticContext("run-aws", async () => run(echo, env, { profile: PROFILES.aws }));
  assert.equal(plain.value.stdout, "[REDACTED]");
  assert.match(plain.value.stderr, /fail: \[REDACTED\]/);
  assert.equal(JSON.stringify(plain).includes(secret), false);
  const awsEvent = plain.events.find((event) => event.component === "allowlisted-process");
  assert.ok(awsEvent && "stdoutExcerpt" in awsEvent.attributes, "ordinary tools keep (redacted) excerpts");

  const engine = await withDebugDiagnosticContext("run-tf", async () => run(echo, env, { profile: PROFILES.terraform }));
  assert.equal(JSON.stringify(engine).includes(secret), false);
  const tfEvent = engine.events.find((event) => event.component === "allowlisted-process");
  assert.ok(tfEvent);
  assert.equal("stdoutExcerpt" in tfEvent.attributes || "stderrExcerpt" in tfEvent.attributes, false);
  assert.equal(redactSecrets("a " + secret + " b", [secret, "short"]), "a [REDACTED] b");
});

test("every executable an adapter runs has a profile, and an unprofiled executable is refused", () => {
  const used = new Set<string>();
  for (const file of [...readdirSync("src/iac").map((f) => join("src/iac", f)), "src/tools/broker.ts"].filter((f) => f.endsWith(".ts"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/runAllowlistedProcess\(\s*"[^"]+",\s*"([^"]+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 8, "found the adapters' executables: " + [...used].join(", "));
  for (const executable of used) assert.ok(PROFILES[executable], executable + " has no process profile");
  for (const executable of ["sh", "bash", "curl", "wget", "sudo", "node", "python3"]) {
    const result = runAllowlistedProcess("terraform_version", executable, ["-c", "id"], work);
    assert.equal(result.blocked, true, executable);
    assert.equal(result.stdout, "");
  }
});

test("a tool that is not installed still reports exactly the command it would have run", () => {
  const result = runBoundedProcess("terraform_plan", "terraform", ["plan", "-input=false"], work,
    { profile: PROFILES.terraform, toolDirs: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.command, ["terraform", "plan", "-input=false"]);
});

test("private directories are protected and removed", () => {
  const dir = createPrivateDirectory("alz-test-");
  assert.equal(statSync(dir.path).mode & 0o777, 0o700);
  writeFileSync(join(dir.path, "plan.json"), "{}");
  dir.remove();
  dir.remove();
  assert.equal(existsSync(dir.path), false);
  const sandbox = createChildSandbox();
  assert.equal(statSync(sandbox.home).mode & 0o777, 0o700);
  assert.equal(statSync(sandbox.tmp).mode & 0o777, 0o700);
  sandbox.remove();
  assert.equal(existsSync(sandbox.path), false);
});
