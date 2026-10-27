import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPLY_ADAPTER,
  APPLY_ARGV,
  APPLY_BACKEND_CONFIG_FILE,
  APPLY_INIT_ARGV,
  applyArgvDigest,
  CLEANUP_APPLY_ARGV,
  CLEANUP_SHOW_ARGV,
  classifyApply,
  cleanupPlanArgv,
  isAllowedApplyArgv,
} from "../src/apply/terraform.js";
import { engineActivation } from "../src/teardown/driver/qualification.js";
import {
  INIT_ARGV, PREVIEW_PLAN_ARGV, SHOW_ARGV, STATE_PULL_ARGV, VERSION_ARGV, WORKSPACE_SHOW_ARGV,
  terraformArgvDigest, workspaceSelectArgv,
} from "../src/teardown/driver/adapters/terraform.js";
import type { EngineAdapter } from "../src/teardown/driver/types.js";
import { PROFILES, TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import { ENGINE_VERSION, applyRecordOf as record } from "./helpers/apply-fixtures.js";

// docs/act-pilot-plan.md, authority items 2 and 5. Pure logic only: the argument
// allowlist, the qualification surface and the outcome classes. These tests
// are not real-engine qualification.

const EXE = "terraform";
const allowed = (args: readonly string[], exe = EXE) => isAllowedApplyArgv(exe, args);

test("apply is exactly: apply -input=false -no-color <the sealed plan file>", () => {
  assert.deepEqual([...APPLY_ARGV], ["apply", "-input=false", "-no-color", "../alz-apply.tfplan"]);
  assert.ok(allowed(["apply", "-input=false", "-no-color", "../alz-apply.tfplan"]));
  assert.match(APPLY_ARGV[3], /^\.\.\/[A-Za-z0-9._-]+\.tfplan$/, "a fixed file one level above the work directory");
});

test("init carries the state writer's backend configuration: a fixed file beside the plan, and no other init is allowed", () => {
  assert.deepEqual([...APPLY_INIT_ARGV], [...INIT_ARGV, "-backend-config=../" + APPLY_BACKEND_CONFIG_FILE]);
  assert.ok(allowed(APPLY_INIT_ARGV));
  // The preview adapter's plain init would leave backend authentication to whatever the apply process holds.
  assert.ok(!allowed(INIT_ARGV));
  for (const extra of ["-backend-config=../other.tfbackend", "-backend-config=/tmp/x.tfbackend", "-backend-config=access_key=abc", "-reconfigure", "-migrate-state", "-upgrade", "-lockfile=false", "-backend=false"]) {
    assert.ok(!allowed([...APPLY_INIT_ARGV, extra]), extra);
    assert.ok(!allowed([...INIT_ARGV, extra]), extra);
  }
  assert.ok(!allowed(APPLY_INIT_ARGV.slice(0, -1).concat("-backend-config=../alz-apply.tfplan")));
});

test("the pinned version, workspace and read-only state pull steps are the only other argument lists", () => {
  // `state pull` is how the driver reads the state serial before and after an apply to classify the outcome.
  for (const args of [VERSION_ARGV, WORKSPACE_SHOW_ARGV, workspaceSelectArgv("pilot"), STATE_PULL_ARGV]) assert.ok(allowed(args), args.join(" "));
  // No plan, show or any other subcommand: the apply adapter cannot generate a plan or edit state.
  for (const args of [PREVIEW_PLAN_ARGV, SHOW_ARGV, ["state", "pull", "-lock=false"], ["state", "push", "x"], ["state", "list"], ["plan", "-input=false"], ["destroy"], ["import", "a", "b"],
    ["force-unlock", "x"], ["taint", "a"], ["state", "rm", "a"], ["output"], ["console"], ["providers", "mirror", "/tmp/x"]]) {
    assert.ok(!allowed(args), args.join(" "));
  }
});

test("every forbidden flag, extra argument, other plan file and other executable is refused", () => {
  const [a, b, c, plan] = APPLY_ARGV;
  const forbidden = [
    [a, b, c, "-auto-approve", plan], [a, b, c, plan, "-auto-approve"], [a, "-auto-approve", b, c, plan],
    [a, b, c, "-target=azurerm_resource_group.pilot", plan], [a, b, c, "-replace=azurerm_resource_group.pilot", plan],
    [a, b, c, "-refresh=false", plan], [a, b, c, "-lock=false", plan], [a, b, c, "-lock-timeout=0s", plan], [a, b, c, "-destroy", plan],
    [a, b, c, "-var=x=1", plan], [a, b, c, "-parallelism=1", plan], [a, b, c, "-state=other.tfstate", plan],
    [a, b, c, "-json", plan], [a, b, c, "-compact-warnings", plan],
    [a, b, c], [a, b, plan], [a, c, b, plan], [a, b, c, plan, plan], [a, b, c, "/tmp/other.tfplan"], [a, b, c, "../other.tfplan"],
    [a, b, c, "alz-apply.tfplan"], [a, b, c, "../../alz-apply.tfplan"], [a, b, c, ""], ["apply"],
    ["apply", "-input=true", c, plan], [a, b, c, plan + " "], [a, b, c, plan + "\0"],
  ];
  for (const args of forbidden) assert.ok(!allowed(args), JSON.stringify(args));
  assert.ok(!allowed(APPLY_ARGV, "tofu"));
  assert.ok(!allowed(APPLY_ARGV, "/usr/bin/terraform"));
  assert.ok(!allowed(APPLY_ARGV, "bash"));
  assert.ok(!allowed([a, b, c, 7 as unknown as string]));
  assert.ok(!allowed(["workspace", "select", "../x"]));
  assert.ok(!allowed(["workspace", "select", "-lock=false"]));
});

test("no allowed argument list anywhere carries a lock, target, replace, refresh or auto-approve switch; the cleanup plan is the one targeted destroy", () => {
  const lists = [APPLY_ARGV, VERSION_ARGV, APPLY_INIT_ARGV, WORKSPACE_SHOW_ARGV, workspaceSelectArgv("pilot"), CLEANUP_SHOW_ARGV, CLEANUP_APPLY_ARGV];
  for (const args of lists) {
    assert.ok(!args.some((arg) => /^-(lock(=|-timeout|$)|target|replace|refresh|auto-approve|destroy)/.test(arg)), args.join(" "));
  }
  // The cleanup adapter's plan (docs/act-pilot-plan.md, "Cleanup of pilot-created resources") is a destroy limited to the
  // addresses of an approved proposal, and the driver compares its change list with that proposal before any approval is
  // consumed. It still carries no lock, replace, refresh or auto-approve switch.
  const plan = cleanupPlanArgv(["aws_s3_bucket.logs"]);
  assert.deepEqual(plan.slice(0, 2), ["plan", "-destroy"]);
  assert.deepEqual(plan.filter((arg) => arg.startsWith("-target=")), ["-target=aws_s3_bucket.logs"]);
  assert.ok(!plan.some((arg) => /^-(lock(=|-timeout|$)|replace|refresh|auto-approve)/.test(arg)), plan.join(" "));
  const source = readFileSync(new URL("../src/apply/terraform.ts", import.meta.url), "utf8");
  assert.ok(!/["'`]-(auto-approve|replace|refresh=false|lock=false)/.test(source), "none of those switches appears as a literal argument");
  assert.equal(source.match(/["'`]-destroy["'`]/g)?.length, 2, "-destroy appears in the cleanup plan builder and its allowlist, and nowhere else");
  assert.equal(source.match(/["'`]-target=["'`]/g)?.length, 1, "-target= is built in one place only, for the approved addresses");
});

test("the qualification surface: a descriptor and a digest that differ from the preview adapter's and move with the argument lists", () => {
  assert.equal(APPLY_ADAPTER.engine, "TERRAFORM");
  assert.equal(APPLY_ADAPTER.argvDigest, applyArgvDigest());
  assert.match(applyArgvDigest(), /^[a-f0-9]{64}$/);
  assert.notEqual(applyArgvDigest(), terraformArgvDigest("TERRAFORM"));
  assert.notEqual(APPLY_ADAPTER.adapterVersion, "1.0.0", "the preview adapter's version is never reused as the apply adapter's");
  assert.equal(applyArgvDigest(), applyArgvDigest(), "deterministic");
});

// engineActivation reads only engine, adapterVersion and argvDigest, which AdapterDescriptor carries.
const adapters = [APPLY_ADAPTER as unknown as EngineAdapter];

test("activation needs a record for this apply adapter version, argv digest and engine version", () => {
  assert.equal(engineActivation("TERRAFORM", [record()], adapters, ENGINE_VERSION).enabled, true);
  assert.equal(engineActivation("TERRAFORM", [], adapters, "1.9.5").enabled, false);
  // A record for the preview adapter (same engine, its own version and digest) activates nothing here.
  const preview = record({ adapterVersion: "1.0.0", argvDigest: terraformArgvDigest("TERRAFORM") });
  assert.equal(engineActivation("TERRAFORM", [preview], adapters, "1.9.5").enabled, false);
  assert.equal(engineActivation("TERRAFORM", [record({ argvDigest: "0".repeat(64) })], adapters, "1.9.5").enabled, false);
  assert.equal(engineActivation("TERRAFORM", [record({ adapterVersion: "0.0.1" })], adapters, "1.9.5").enabled, false);
  assert.equal(engineActivation("TERRAFORM", [record()], adapters, "1.9.6").enabled, false);
});

test("outcomes: success; a failure once the apply began is a partial apply to review; a killed run", () => {
  const base = { stderr: "", serialBefore: "7", serialAfter: "7" };
  assert.deepEqual(classifyApply({ ...base, exitCode: 0, serialAfter: "8" }), { outcome: "SUCCEEDED" });
  // Terraform exits 1 for every apply error, and resources can exist while the state write failed (the serial does not move).
  assert.deepEqual(classifyApply({ ...base, exitCode: 1 }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, stderr: "Error: creating resource: quota" }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, serialAfter: "8" }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  assert.deepEqual(classifyApply({ ...base, exitCode: null }), { outcome: "KILLED" });
  assert.deepEqual(classifyApply({ ...base, exitCode: null, serialAfter: "9" }), { outcome: "KILLED" }, "a kill is reviewed as a kill, whatever state did");
  // A state that cannot be read after a failure is not evidence that nothing changed.
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, serialAfter: undefined }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
});

test("a state lock that was not acquired is FAILED_NO_CHANGE only while state did not move; the text must be an error summary, boxed or not", () => {
  const base = { exitCode: 1, serialBefore: "7", serialAfter: "7" };
  for (const stderr of [
    "Error: Error acquiring the state lock\n\nError message: blob is locked",
    "\u2577\n\u2502 Error: Error acquiring the state lock\n\u2502\n\u2502 Error message: lease already present\n\u2575",
  ]) assert.deepEqual(classifyApply({ ...base, stderr }), { outcome: "FAILED_NO_CHANGE" }, stderr);
  assert.deepEqual(classifyApply({ ...base, stderr: "Error: Error acquiring the state lock", serialAfter: "8" }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  assert.deepEqual(classifyApply({ ...base, stderr: "Error: Error acquiring the state lock", serialAfter: undefined }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  // Words inside another error (a provider quoting a message) are not a refusal.
  for (const stderr of ["Error: creating thing: the Error acquiring the state lock text is quoted", "Warning: Error acquiring the state lock", "azurerm: Error: Saved plan is stale"]) {
    assert.deepEqual(classifyApply({ ...base, stderr }), { outcome: "PARTIAL_REQUIRES_REVIEW" }, stderr);
  }
});

test("a requested stop is KILLED whatever exit code terraform's graceful stop reports, unless the apply had already succeeded", () => {
  const base = { stderr: "", serialBefore: "7", serialAfter: "7", stopped: true };
  assert.deepEqual(classifyApply({ ...base, exitCode: 1 }), { outcome: "KILLED" });
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, serialAfter: "9" }), { outcome: "KILLED" }, "reviewed as a kill, state moved or not");
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, serialAfter: undefined }), { outcome: "KILLED" });
  assert.deepEqual(classifyApply({ ...base, exitCode: 1, stderr: "Error: Saved plan is stale" }), { outcome: "KILLED" });
  assert.deepEqual(classifyApply({ ...base, exitCode: null }), { outcome: "KILLED" });
  assert.deepEqual(classifyApply({ ...base, exitCode: 0, serialAfter: "8" }), { outcome: "SUCCEEDED" }, "it finished before the stop took effect");
  assert.deepEqual(classifyApply({ ...base, stopped: false, exitCode: 1 }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
});

test("a stale plan is PLAN_STALE only when state did not move, and the classification never carries engine text", () => {
  const stale = "Error: Saved plan is stale\n\nThe given plan file can no longer be applied because the state was changed by another operation after the plan was created. CANARY_STALE_77";
  const verdict = classifyApply({ exitCode: 1, stderr: stale, serialBefore: "7", serialAfter: "7" });
  assert.deepEqual(verdict, { stale: true });
  assert.ok(!JSON.stringify(verdict).includes("CANARY"));
  assert.deepEqual(classifyApply({ exitCode: 1, stderr: "\u2502 Error: Saved plan is stale", serialBefore: "7", serialAfter: "7" }), { stale: true }, "boxed");
  // If state moved, something was applied: that is a partial apply to review, whatever the text says.
  assert.deepEqual(classifyApply({ exitCode: 1, stderr: stale, serialBefore: "7", serialAfter: "8" }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
  // Success is success; text alone never downgrades it.
  assert.deepEqual(classifyApply({ exitCode: 0, stderr: stale, serialBefore: "7", serialAfter: "8" }), { outcome: "SUCCEEDED" });
  assert.deepEqual(classifyApply({ exitCode: 1, stderr: "some other failure", serialBefore: "7", serialAfter: "7" }), { outcome: "PARTIAL_REQUIRES_REVIEW" });
});

test("the apply profile drops provider-installation overrides, AZURE_* (az CLI / SDK fallback) static AWS credentials, the AWS endpoint, CA bundle and default region and nothing else; the preview profile is untouched", () => {
  const removed = PROFILES.terraform.injectable.filter((name) => !TERRAFORM_APPLY_PROFILE.injectable.includes(name)).sort();
  assert.deepEqual(removed.filter((name) => !name.startsWith("AZURE_")), [
    "AWS_ACCESS_KEY_ID", "AWS_CA_BUNDLE", "AWS_CONFIG_FILE", "AWS_DEFAULT_REGION", "AWS_EC2_METADATA_DISABLED", "AWS_ENDPOINT_URL", "AWS_PROFILE", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_SHARED_CREDENTIALS_FILE",
    "TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR",
  ]);
  assert.ok(removed.includes("AZURE_CONFIG_DIR") && TERRAFORM_APPLY_PROFILE.injectable.every((name) => !name.startsWith("AZURE_")));
  assert.ok(TERRAFORM_APPLY_PROFILE.injectable.includes("ARM_OIDC_TOKEN_FILE"));
  for (const name of ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_REGION"]) assert.ok(TERRAFORM_APPLY_PROFILE.injectable.includes(name), name);
  for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"]) assert.ok(TERRAFORM_APPLY_PROFILE.injectable.includes(name), name);
  assert.deepEqual(TERRAFORM_APPLY_PROFILE.injectable.filter((name) => /^(GOOGLE|GCLOUD|CLOUDSDK|GCE)_/.test(name)).sort(), ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"], "no other Google variable");
  assert.deepEqual(TERRAFORM_APPLY_PROFILE.fixedEnvironment, {
    AWS_EC2_METADATA_DISABLED: "true", TF_DATA_DIR: ".terraform", GCE_METADATA_HOST: "127.0.0.1:9", GCE_METADATA_IP: "127.0.0.1:9", NO_GCE_CHECK: "True",
  }, "the AWS and Google instance metadata fallbacks are off and the data directory is init's own for every apply child");
  assert.equal(PROFILES.terraform.fixedEnvironment, undefined);
  assert.deepEqual({ ...TERRAFORM_APPLY_PROFILE, injectable: [], fixedEnvironment: undefined }, { ...PROFILES.terraform, injectable: [], fixedEnvironment: undefined });
  assert.ok(PROFILES.terraform.injectable.includes("TF_CLI_CONFIG_FILE"), "the preview adapter keeps its reviewed profile");
});

test("only the first Error: diagnostic can mean stale or lock-refused: a provider error body that quotes either later is a partial apply", () => {
  const base = { exitCode: 1, serialBefore: "7", serialAfter: "7" };
  for (const quoted of ["Error: Saved plan is stale", "Error: Error acquiring the state lock"]) {
    for (const stderr of [
      "Error: creating Resource Group: unexpected status 409\n\nwith azurerm_resource_group.pilot,\n" + quoted + "\nbody follows",
      "╷\n│ Error: creating thing\n│\n│ response body:\n│ " + quoted + "\n╵\n╷\n│ " + quoted + "\n╵",
      "Warning: something first\n\nError: provider crashed\n" + quoted,
    ]) assert.deepEqual(classifyApply({ ...base, stderr }), { outcome: "PARTIAL_REQUIRES_REVIEW" }, stderr);
  }
  // As the first diagnostic they still count, after a warning or other output.
  assert.deepEqual(classifyApply({ ...base, stderr: "Warning: deprecated\n\nError: Saved plan is stale\n\nError: creating thing" }), { stale: true });
  assert.deepEqual(classifyApply({ ...base, stderr: "Warning: x\n│ Error: Error acquiring the state lock\n│ Error: Saved plan is stale" }), { outcome: "FAILED_NO_CHANGE" });
});
