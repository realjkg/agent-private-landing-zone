import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactAddress } from "../src/cost/status.ts";
import type { CostStatus } from "../src/cost/status.ts";
import { readCostSnapshot, readLocalCostConfig } from "../src/cost/local.ts";
import { acceptanceItems, approvalOf, DIST_MODULES, jsonObjects, pilotEnabled, preparationRecordPath, redactText, secretKinds, sealValues } from "../scripts/mac-acceptance.mjs";

// scripts/mac-acceptance.sh: the owner's guided runner for the first supervised AWS cost-baseline run on the Mac Mini
// (docs/mac-acceptance-runner.md). SYNTHETIC: every product command is a fake `alz`, and `node`, `terraform`, `aws`, `uname` and
// `sw_vers` are shims on a fake PATH. Nothing here reaches a cloud, holds a key or types a phrase. The tests run the script with
// /bin/bash, which is Apple's bash 3.2 in the macOS job (.github/workflows/act-identity-macos.yml) and the system bash elsewhere.

const BASH = "/bin/bash";
const SCRIPT = "scripts/mac-acceptance.sh";
const HELPER = "scripts/mac-acceptance.mjs";
const ACCOUNT = "123456789012";
const BUCKET = "fixture-state-bucket-7f3a";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOmZpeHR1cmUtb3duZXIifQ.c2lnbmF0dXJlLWZpeHR1cmU";
const RECIPIENT = "alerts.owner@example.com";
// Secret-shaped fixture text, assembled here so the file itself never holds a key-shaped literal.
const PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "PRIVATE KEY-----";
const KEY_ID = "AKIA" + "ABCDEFGHIJKLMNOP";
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "alz-mac-acceptance-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const UTIL_LINUX_SCRIPT = spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;

/** A day-one cost status, shaped as src/cost/status.ts types it (CostStatus), with one direct email recipient and the alert topic. */
export function dayOneStatus(): CostStatus {
  const unknown = (reason: string) => ({ label: "UNKNOWN" as const, reason: reason as never });
  return {
    kind: "ALZ_COST_STATUS", source: "AWS_API_READ_ONLY", accountId: ACCOUNT, capturedAt: "2026-11-05T10:00:00.000Z", overall: "INCOMPLETE",
    budget: {
      name: "alz-dev-monthly", state: "PRESENT", budgetCount: { label: "OBSERVED", value: 1 }, budgetType: { label: "OBSERVED", value: "COST" },
      limit: { label: "OBSERVED", value: { amount: "50.0", unit: "USD" } }, period: { label: "OBSERVED", value: "MONTHLY" },
      filters: { label: "OBSERVED", value: {} }, actualSpend: unknown("NOT_YET_CALCULATED"),
      forecastedSpend: unknown("NOT_YET_CALCULATED"), budgetUpdatedAt: { label: "OBSERVED", value: "2026-11-05T09:00:00Z" },
      spendCalculatedAt: unknown("NOT_REPORTED_BY_AWS"),
      notifications: { label: "OBSERVED", value: [{ notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: "80", thresholdType: "PERCENTAGE",
        alarmState: { label: "OBSERVED", value: "OK" },
        subscribers: { label: "OBSERVED", value: [
          { type: "SNS", address: "arn:aws:sns:us-east-2:" + ACCOUNT + ":alz-cost-alerts", confirmation: unknown("NOT_READ") },
          { type: "EMAIL", address: RECIPIENT, confirmation: unknown("NOT_REPORTED_BY_AWS") }] } }] },
      hasActualAlert: { label: "OBSERVED", value: true }, hasForecastAlert: { label: "OBSERVED", value: false }, hardSpendCap: false,
    },
    tags: { state: "ALL_PRESENT", required: ["alz-unit", "cost-center"], coverage: "UNIT_TAGGED_RESOURCES_ONLY",
      resources: { label: "OBSERVED", value: [{ arn: "arn:aws:s3:::alz-cur-" + ACCOUNT, present: ["alz-unit", "cost-center"], missing: [] }] } },
    costAllocationTags: { state: "UNKNOWN", tags: [{ key: "cost-center", status: unknown("TAG_KEY_NOT_YET_IN_BILLING"), lastUpdated: unknown("TAG_KEY_NOT_YET_IN_BILLING") }] },
    export: { state: "WAITING", arn: { label: "OBSERVED", value: "arn:aws:bcm-data-exports:us-east-1:" + ACCOUNT + ":export/alz-cur" }, name: { label: "OBSERVED", value: "alz-cur" },
      configValid: { label: "OBSERVED", value: true }, configProblems: [], destination: { label: "OBSERVED", value: { bucket: "alz-cur-" + ACCOUNT, prefix: "cur", region: "us-east-2" } },
      health: { label: "OBSERVED", value: "HEALTHY" }, createdAt: { label: "OBSERVED", value: "2026-11-05T09:00:00Z" }, lastExecution: unknown("NOT_FOUND"), lastDelivery: unknown("NOT_FOUND") },
    freshness: { state: "WAITING", billingPeriod: { label: "ESTIMATE", value: "2026-11", basis: "capture clock (UTC)" }, latestDelivery: unknown("NOT_FOUND"),
      staleAfterHours: 48, analyticsIngestion: unknown("NOT_SELECTED"), dashboardRefresh: unknown("NOT_SELECTED") },
    advisory: true, actEnabled: false,
  } as CostStatus;
}

// --- the fixture: a checkout with a fake ./alz, a fake build and fake product modules -------------------------------------

const FAKE_ALZ = String.raw`#!/bin/bash
# SYNTHETIC ./alz: logs every call, refuses apply commands without a terminal (as the product does), and reads what a person
# would type without ever expecting input from the runner.
LOG="$FAKE_LOG"
t0=no; [ -t 0 ] && t0=yes; t1=no; [ -t 1 ] && t1=yes
printf 'CALL %s tty0=%s tty1=%s\n' "$*" "$t0" "$t1" >> "$LOG"
typed() { local line=""; IFS= read -r -t 1 line; printf 'READ %s [%s]\n' "$1" "$line" >> "$LOG"; }
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$want" ]; then printf '%s' "$2"; return; fi; shift; done; }
json() { node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]), null, 2) + "\n")' "$1"; }
A=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
case "$1" in
  deps)
    printf 'Dependency check\n\nOK  Node 26 — running Node 26.1.0\nOK  Terraform 1.16.4 — installed, checksum verified\nOK  Git — git version 2.50.1\nOK  AWS CLI 2.27.10 — aws-cli/2.27.10\n\nProduct tools (each is needed only by the feature that uses it; none blocks the pilot)\nNOT NEEDED FOR THE PILOT  trivy — not found\n\nAll required dependencies are ready.\n'
    exit 0 ;;
  cost)
    printf 'COSTENV profile=%s identities=%s\n' "\${AWS_PROFILE:-}" "$([ -n "\${ALZ_APPLY_AWS_ROLE_ARN:-}" ] && echo present || echo absent)" >> "$LOG"
    mkdir -p .runs/cost && cp "$FAKE_DIR/cost-status.json" .runs/cost/status.json
    printf 'Cost status: INCOMPLETE (read-only, advisory; a budget alerts and never caps spend)\n  Budget alz-dev-monthly: PRESENT, recipients a***@example.com\n'
    exit 0 ;;
  apply) shift ;;
  *) printf 'FORBIDDEN %s\n' "$*" >> "$LOG"; exit 99 ;;
esac
if [ ! -t 0 ] || [ ! -t 1 ]; then echo "BLOCKED HUMAN_TERMINAL_REQUIRED" >&2; exit 1; fi
sub="$1"; shift
case "$sub" in
  status)
    if [ -n "$(arg --sealed "$@")" ]; then json '{"artifact":{"artifactSha256":"'"$A"'","applied":true}}'
    else json '{"act":"PILOT_ENABLED","contract":{"code":"OK"},"authorized":[{"environment":"DEV","operations":["APPLY","CLEANUP"],"authorizationSha256":"'"$A"'"}]}'; fi ;;
  prepare)
    project="$(arg --project "$@")"
    filled=no; grep -q alzu-0123456789abcdef0123 "$project/terraform.tfvars.json" 2>/dev/null && filled=yes
    printf 'PREPARE %s tags_filled=%s\n' "$project" "$filled" >> "$LOG"
    tag="$(printf '%s' "$project" | cksum | cut -d' ' -f1)"
    mkdir -p .runs/pilot/DEV
    rec="$PWD/.runs/pilot/DEV/preparation-$tag.json"
    for f in request apply-request manifest; do printf '{"projectRoot":"%s"}\n' "$project" > ".runs/pilot/DEV/$f-$tag.json"; done
    node -e 'const [rec, dir, tag, project] = process.argv.slice(1); require("node:fs").writeFileSync(rec, JSON.stringify({ projectRoot: project,
      unit: { unitId: "alzu-0123456789abcdef0123", tags: { "alz-managed-by": "alz", "alz-unit": "alzu-0123456789abcdef0123", "alz-build": "alz-pilot-dev-abcdef012345" } },
      requestFile: dir + "/request-" + tag + ".json", applyRequestFile: dir + "/apply-request-" + tag + ".json", manifestFile: dir + "/manifest-" + tag + ".json" }, null, 2))' "$rec" "$PWD/.runs/pilot/DEV" "$tag" "$project"
    printf '\nPREPARED (LOCAL: local files, not qualification evidence)\n  deletion unit   alzu-0123456789abcdef0123\n\nSaved (private to this account):\n  request        x\n  record         %s\n' "$rec" ;;
  qualify)
    typed qualify
    printf 'Assumed arn:aws:iam::%s:role/alz-pilot-dev-apply with web identity token %s for owner.person@example.com in %s\n' "${ACCOUNT}" "${JWT}" "${BUCKET}"
    if [ -f "$FAKE_DIR/fail-qualify" ]; then echo "BLOCKED ENGINE_NOT_QUALIFIED: the fixture refuses"; exit 2; fi
    json '{"qualified":true}' ;;
  preflight) json '{"ready":true}' ;;
  seal)
    typed seal
    if grep -q canary "$(arg --request "$@")"; then echo "BLOCKED RESOURCE_NOT_IN_LIMITS: type aws_cloudwatch_log_group is not in the provisioning limits"; exit 2; fi
    mkdir -p .runs/apply/sealed
    sealed="$PWD/.runs/apply/sealed/$A.sealed"; : > "$sealed"
    node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ artifactSha256: process.argv[2], environment: "DEV", target: { account: process.argv[3], backend: process.argv[4] + "/pilot/dev.tfstate" },
      changes: [{ address: "aws_budgets_budget.alz", type: "aws_budgets_budget", action: "create" }, { address: "aws_sns_topic.alerts", type: "aws_sns_topic", action: "create" }], unit: { unitId: "alzu-0123456789abcdef0123" } }, null, 2))' "$sealed.review.json" "$A" "${ACCOUNT}" "${BUCKET}"
    json '{"artifactSha256":"'"$A"'","sealedPlanPath":"'"$sealed"'","reviewBundlePath":"'"$sealed.review.json"'","changes":[]}' ;;
  approve)
    typed approve
    json '{"statement":{"schemaVersion":1,"artifactSha256":"'"$A"'","environment":"DEV","approverId":"owner-1"},"signatureBase64":"c2lnbmF0dXJlLW9mLXRoZS1maXh0dXJlLWFwcHJvdmFs"}' ;;
  apply)
    typed apply
    printf 'APPLY_APPROVAL %s\n' "$(arg --approval "$@")" >> "$LOG"
    if [ -f "$FAKE_DIR/fail-apply" ]; then echo "SPENT FAILED_NO_CHANGE"; exit 3; fi
    json '{"outcome":"SUCCEEDED"}' ;;
  observe)
    mkdir -p .runs/apply/reports
    printf '{"verdict":"INCOMPLETE","inventory":"COMPLETE","observedAt":"2026-11-05T10:00:00Z","artifactSha256":"%s"}\n' "$A" > ".runs/apply/reports/$(printf '%s' "$A" | cut -c1-12)-observation.json"
    json '{"verdict":"INCOMPLETE"}' ;;
  *) printf 'FORBIDDEN apply %s %s\n' "$sub" "$*" >> "$LOG"; exit 99 ;;
esac
`;

const FAKE_LOCAL = `import { existsSync, readFileSync } from "node:fs";
export function readLocalCostConfig(path) {
  if (!existsSync(path)) return { state: "NONE" };
  const value = JSON.parse(readFileSync(path, "utf8"));
  return value.invalid ? { state: "INVALID", issues: [{ path: "budget.limit", code: "REQUIRED" }] } : { state: "OK", config: value };
}
export function readCostSnapshot(path) {
  if (!existsSync(path)) return { state: "NONE" };
  const file = JSON.parse(readFileSync(path, "utf8"));
  return file.kind === "ALZ_COST_STATUS_SNAPSHOT" ? { state: "OK", status: file.status } : { state: "UNREADABLE" };
}
`;
const FAKE_STATUS = `export function redactAddress(type, address) { if (type === "SNS") return address; const at = address.lastIndexOf("@"); return at <= 0 ? "***" : address[0] + "***" + address.slice(at); }
export function redactCostStatus(status) {
  const copy = JSON.parse(JSON.stringify(status));
  for (const n of copy.budget.notifications.value ?? []) for (const s of n.subscribers.value ?? []) s.address = redactAddress(s.type, s.address);
  return copy;
}
`;
const FAKE_BUILD = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
appendFileSync(process.env.FAKE_LOG, "BUILD profile=" + (process.env.AWS_PROFILE ?? "") + " identities=" + (process.env.ALZ_APPLY_AWS_ROLE_ARN ? "present" : "absent") +
  " region=" + process.env.TF_VAR_aws_region + " allow=" + process.env.ALZ_ALLOW_REAL_PRIVATE_BUILD + process.env.ALZ_ALLOW_TERRAFORM_PLAN + " args=" + process.argv.slice(2).join(" ") + "\\n");
const dir = resolve(".runs/qualification/real-private-build", randomUUID(), "project");
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/main.tf", "");
writeFileSync(dir + "/terraform.tfvars.example.json", JSON.stringify({ aws_region: "us-east-2", unit_tags: { "alz-managed-by": "REPLACE-WITH-PREPARE-OUTPUT", "alz-unit": "REPLACE-WITH-PREPARE-OUTPUT", "alz-build": "REPLACE-WITH-PREPARE-OUTPUT" } }, null, 2));
console.log("Pilot project (next: ./alz apply prepare --environment DEV --project <it>): " + dir);
`;

type Fixture = { root: string; dir: string; log: string; env: Record<string, string>; key: string; canary: string };
let counter = 0;
function fixture(): Fixture {
  const dir = join(scratch, "f" + ++counter);
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const tokens = join(dir, "delivery", "aws-terraform");
  for (const d of [root, bin, home, tokens, join(root, "scripts"), join(root, "config"), join(root, "dist", "cost"), join(root, "dist", "cli")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  copyFileSync(SCRIPT, join(root, SCRIPT));
  chmodSync(join(root, SCRIPT), 0o755);
  copyFileSync(HELPER, join(root, HELPER));
  writeFileSync(join(root, "alz"), FAKE_ALZ.replace(/\$\{ACCOUNT\}/g, ACCOUNT).replace(/\$\{JWT\}/g, JWT).replace(/\$\{BUCKET\}/g, BUCKET).replace(/\\\$\{/g, "${"), { mode: 0o755 });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }) + "\n");
  writeFileSync(join(root, ".gitignore"), "dist/\n.runs/\nconfig/cost.json\n");
  writeFileSync(join(root, "config", "tool-pins.json"), JSON.stringify({ schemaVersion: 1, node: { major: 26 } }) + "\n");
  writeFileSync(join(root, "config", "act-pilot-contract.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, provider: "AWS", engine: "TERRAFORM", enabledEnvironments: ["DEV"],
    targets: { DEV: { accountId: ACCOUNT, region: "us-east-2", backend: BUCKET + "/pilot/dev.tfstate", workspace: "default", limits: { resources: [] } } },
    approvers: [{ id: "owner-1", publicKeyPem: "PUBLIC", environments: ["DEV"] }], killSwitchPath: ".runs/apply/KILL", authorize: { DEV: ["APPLY", "CLEANUP"] },
  }, null, 2) + "\n");
  writeFileSync(join(root, "config", "cost.json"), JSON.stringify({ owner: "fixture" }) + "\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(root, "dist", ".alz-build-complete"), JSON.stringify({ schemaVersion: 1, sourceCommit: head }, null, 2) + "\n");
  writeFileSync(join(root, "dist", "cost", "local.js"), FAKE_LOCAL);
  writeFileSync(join(root, "dist", "cost", "status.js"), FAKE_STATUS);
  writeFileSync(join(root, "dist", "cli", "real-private-build.js"), FAKE_BUILD);
  writeFileSync(join(dir, "cost-status.json"), JSON.stringify({ schemaVersion: 1, kind: "ALZ_COST_STATUS_SNAPSHOT", status: dayOneStatus() }, null, 2));

  const shim = (name: string, body: string) => writeFileSync(join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  shim("uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac');
  shim("sw_vers", "echo 15.7.1");
  shim("node", 'if [ "$1" = "--version" ]; then echo "${FAKE_NODE_VERSION:-v26.1.0}"; exit 0; fi\nexec "' + process.execPath + '" "$@"');
  shim("terraform", 'echo "Terraform v1.16.4"');
  shim("aws", 'case "$1" in --version) echo "aws-cli/2.27.10 Python/3.13 Darwin/24 source/arm64" ;; configure) echo default; echo acceptance-ro ;; *) echo "FORBIDDEN aws $*" >> "$FAKE_LOG"; exit 99 ;; esac');

  const env: Record<string, string> = { PATH: bin + ":/usr/bin:/bin", HOME: home, TMPDIR: dir, LANG: "C", TERM: "xterm", FAKE_LOG: join(dir, "calls.log"), FAKE_DIR: dir };
  for (const id of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
    const token = join(tokens, id + ".jwt");
    writeFileSync(token, JWT + "\n", { mode: 0o600 });
    env["ALZ_" + id + "_AWS_ROLE_ARN"] = "arn:aws:iam::" + ACCOUNT + ":role/alz-pilot-dev-" + id.toLowerCase().replace("_", "-");
    env["ALZ_" + id + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = token;
    env["ALZ_" + id + "_AWS_REGION"] = "us-east-2";
  }
  const key = join(dir, "keys", "owner-1.pem");
  mkdirSync(join(dir, "keys"), { mode: 0o700 });
  writeFileSync(key, PEM_BEGIN + "\nFIXTURE-NOT-A-KEY\n" + PEM_END + "\n", { mode: 0o600 });
  const canary = join(dir, "canary-copy");
  mkdirSync(canary);
  writeFileSync(join(canary, "main.tf"), "# canary\n");
  writeFileSync(join(canary, "terraform.tfvars.json"), JSON.stringify({ region: "us-east-2", canary_name: "/alz/act-dev-1/canary-01", owner: "owner-1" }) + "\n");
  writeFileSync(join(canary, "terraform.tfvars.example.json"), "{}\n");
  writeFileSync(env.FAKE_LOG, "");
  return { root, dir, log: env.FAKE_LOG, env, key, canary };
}

const baseArgs = (f: Fixture) => ["--readonly-profile", "acceptance-ro", "--requester-key", f.key];
/** The script without a terminal (stdin is /dev/null). */
function plain(f: Fixture, args: string[], env: Record<string, string> = f.env): SpawnSyncReturns<string> {
  return spawnSync(BASH, [join(f.root, SCRIPT), ...args], { cwd: f.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
/** The script on a pseudo-terminal, as at Terminal.app, with nothing ever written to its input. */
function onTerminal(f: Fixture, args: string[]): { status: number | null; out: string } {
  const argv = [BASH, join(f.root, SCRIPT), ...args];
  const result = UTIL_LINUX_SCRIPT
    ? spawnSync("script", ["-q", "-e", "-c", argv.map(quote).join(" "), "/dev/null"], { cwd: f.root, env: { ...f.env, SHELL: "/bin/bash" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 })
    : spawnSync("script", ["-q", "/dev/null", ...argv], { cwd: f.root, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return { status: result.status, out: (result.stdout + result.stderr).replace(/\r/g, "") };
}
const calls = (f: Fixture) => readFileSync(f.log, "utf8").split("\n").filter(Boolean);
const count = (f: Fixture, pattern: RegExp) => calls(f).filter((line) => pattern.test(line)).length;
const runDir = (f: Fixture) => join(f.root, ".runs", "mac-acceptance", readFileSync(join(f.root, ".runs", "mac-acceptance", "current"), "utf8").trim());
const mode = (path: string) => statSync(path).mode & 0o777;

// --- the script, end to end on fakes ---------------------------------------------------------------------------------------

test("dry run: a ready host passes the preflight and prints every step's exact command, without running a step or writing run state", () => {
  const f = fixture();
  const result = plain(f, ["--dry-run", ...baseArgs(f)]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Preflight passed\./);
  assert.match(result.stdout, /PASS +macOS +15\.7\.1 \(arm64\)/);
  assert.match(result.stdout, /PASS +Node +26\.1\.0 \(the repository pins 26\.x/);
  assert.match(result.stdout, /PASS +ACT status for DEV +\.\/alz apply status: PILOT_ENABLED, DEV authorizes APPLY,CLEANUP/);
  assert.match(result.stdout, /PASS +config\/cost\.json +valid/);
  assert.match(result.stdout, /PASS +Terraform 1\.16\.4/);
  assert.match(result.stdout, /INFO +D4 identity proof +planned on the MacBook Pro runner; if this Mac Mini is the execution host, repeat it here first/);
  for (const command of [
    "node dist/cli/real-private-build.js --live-aws-read-only --scenario cost-baseline", "./alz apply prepare --environment DEV --project <COST_PROJECT>",
    "./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>", "./alz apply preflight --environment DEV",
    "./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester owner-1 --key <REQUESTER_KEY.pem>",
    "./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver owner-1",
    "./alz apply apply --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>",
    "./alz apply observe --sealed <SEALED_PLAN>", "AWS_PROFILE=acceptance-ro ./alz cost status --account " + ACCOUNT + " --unit <UNIT_ID> --region us-east-2",
  ]) assert.ok(result.stdout.includes(command), command);
  assert.ok(!result.stdout.includes(f.key), "the key path is never printed");
  assert.ok(!result.stdout.includes(JWT));
  assert.deepEqual(calls(f).map((l) => l.replace(/ tty0=.*/, "")), ["CALL deps", "CALL apply status --environment DEV"], "only the read-only checks ran");
  assert.ok(!existsSync(join(f.root, ".runs", "mac-acceptance")), "a dry run writes no run state");
});

test("preflight failures are reported in one checklist, each with its exact fix, and nothing runs", () => {
  const f = fixture();
  writeFileSync(join(f.root, "stray.txt"), "dirty\n");
  mkdirSync(join(f.root, ".runs", "apply"), { recursive: true });
  writeFileSync(join(f.root, ".runs", "apply", "KILL"), "");
  rmSync(join(f.root, "config", "cost.json"));
  chmodSync(f.key, 0o644);
  const env = { ...f.env, FAKE_NODE_VERSION: "v24.3.0", AWS_PROFILE: "admin", AWS_SECRET_ACCESS_KEY: "do-not-print-this-value" };
  delete (env as Record<string, string | undefined>).ALZ_APPLY_AWS_REGION;
  const result = plain(f, ["--dry-run", ...baseArgs(f)], env);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const out = result.stdout;
  const fails: Array<[RegExp, RegExp]> = [
    [/FAIL +Node +running 24\.3\.0, needs 26\.x/, /Fix: install Node 26\.x/],
    [/FAIL +Clean worktree +1 uncommitted/, /Fix: commit or stash them/],
    [/FAIL +No fallback credentials +set in this shell: (?=.*AWS_PROFILE)(?=.*AWS_SECRET_ACCESS_KEY)/, /Fix: unset them/],
    [/FAIL +Kill switch +\.runs\/apply\/KILL exists/, /Fix: review why it was set; only you remove it/],
    [/FAIL +config\/cost\.json +missing/, /Fix: cp config\/cost\.example\.json config\/cost\.json/],
    [/FAIL +Pilot identity variables +not set: ALZ_APPLY_AWS_REGION/, /Fix: export the twelve ALZ_\* variables/],
    [/FAIL +REQUESTER key file +missing, a link, or readable by others/, /Fix: chmod 600 <key file>/],
  ];
  for (const [line, fix] of fails) { assert.match(out, line); assert.match(out, fix); }
  assert.match(out, /PREFLIGHT FAILED: \d+ item\(s\) above need a fix\. Nothing was run against the cloud\./);
  assert.ok(!out.includes("do-not-print-this-value"), "a variable's value is never printed");
  assert.equal(count(f, /apply (prepare|qualify|seal|approve|apply)|BUILD/), 0);
});

test("a live run refuses without an interactive terminal, before any step or run state", () => {
  const f = fixture();
  const result = plain(f, baseArgs(f));
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /FAIL +Interactive terminal +stdin or stdout is not a terminal/);
  assert.equal(count(f, /BUILD|apply prepare/), 0);
  assert.ok(!existsSync(join(f.root, ".runs", "mac-acceptance")));
});

test("the stage runner stops at a failed step; --resume skips the completed steps, answers no gate, never cleans up, and bundles redacted evidence", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "fail-qualify"), "");
  const first = onTerminal(f, baseArgs(f));
  assert.equal(first.status, 1, first.out);
  assert.match(first.out, /STOPPED at 06-qualify: qualify exited 2/);
  assert.match(first.out, /Next: read the code above \(brief step 4, Stop\)/);
  assert.equal(count(f, /^BUILD profile=acceptance-ro identities=absent region=us-east-2 allow=11 args=--live-aws-read-only --scenario cost-baseline$/), 1, "the build runs with the read-only profile and no pilot identity");
  assert.equal(count(f, /^PREPARE .* tags_filled=no$/), 1);
  assert.equal(count(f, /^PREPARE .* tags_filled=yes$/), 1, "the second prepare sees the unit tags the first printed");
  assert.equal(count(f, /^CALL apply seal/), 0, "nothing runs past the failed step");
  const run = runDir(f);
  assert.match(readFileSync(join(run, "steps", "06-qualify.env"), "utf8"), /^EXIT=2$/m);
  assert.ok(!existsSync(join(run, "steps", "06-qualify.done")));

  // A second fresh run is refused while this one is in progress.
  const again = plain(f, ["--readonly-profile", "acceptance-ro"]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /a run is already in progress .* Continue it with --resume/);

  rmSync(join(f.dir, "fail-qualify"));
  const second = onTerminal(f, ["--resume", ...baseArgs(f)]);
  assert.equal(second.status, 0, second.out);
  for (const done of ["01-build", "02-tfvars", "03-prepare-1", "04-unit-tags", "05-prepare-2"]) assert.match(second.out, new RegExp("STEP " + done + ": done at .*, skipped"));
  assert.equal(count(f, /^BUILD/), 1, "the build is not repeated");
  assert.equal(count(f, /^PREPARE/), 2, "prepare is not repeated");
  assert.equal(count(f, /^CALL apply qualify/), 2);
  for (const sub of ["seal", "approve", "apply", "observe"]) assert.equal(count(f, new RegExp("^CALL apply " + sub + " ")), 1, sub);
  assert.equal(count(f, /^COSTENV profile=acceptance-ro identities=absent$/), 1, "cost status reads with the read-only profile and no pilot identity");
  assert.equal(count(f, new RegExp("^APPLY_APPROVAL " + run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/approval-apply\\.json$")), 1, "apply gets the approval the product printed");

  // Human gates: every product command had the person's terminal, and nothing was ever typed for them.
  for (const line of calls(f).filter((l) => l.startsWith("CALL apply"))) assert.match(line, /tty0=yes tty1=yes$/, line);
  const reads = calls(f).filter((l) => l.startsWith("READ "));
  assert.equal(reads.length, 5, "qualify twice, then seal, approve and apply");
  for (const line of reads) assert.match(line, /^READ \w+ \[\]$/, "no input was fed: " + line);
  // Never a cleanup, and never an unknown command.
  assert.equal(count(f, /cleanup|FORBIDDEN/), 0);
  assert.match(second.out, /RETENTION: the disposition is RETAIN/);

  // The bundle: owner-only folder, tar.gz with its checksum, a manifest that verifies, the report, and no secret.
  const bundle = join(run, "bundle");
  assert.equal(mode(bundle), 0o700);
  const archive = readdirSync(run).find((n) => n.endsWith(".tar.gz"))!;
  assert.equal(mode(join(run, archive)), 0o600);
  const sum = readFileSync(join(run, archive + ".sha256"), "utf8");
  assert.equal(sum, createHash("sha256").update(readFileSync(join(run, archive))).digest("hex") + "  " + archive + "\n");
  const manifest = readFileSync(join(bundle, "MANIFEST.sha256"), "utf8").trim().split("\n");
  assert.ok(manifest.some((l) => l.endsWith("  acceptance-report.md")));
  for (const line of manifest) {
    const [digest, file] = line.split("  ");
    assert.equal(createHash("sha256").update(readFileSync(join(bundle, file))).digest("hex"), digest, file);
  }
  const listed = spawnSync("tar", ["-tzf", join(run, archive)], { encoding: "utf8" }).stdout;
  assert.match(listed, /bundle\/MANIFEST\.sha256/);
  assert.match(listed, /bundle\/acceptance-report\.md/);
  const texts = walk(bundle).map((p) => readFileSync(p, "utf8"));
  const all = texts.join("\n");
  for (const secret of [JWT, RECIPIENT, "owner.person@example.com", ACCOUNT, BUCKET, f.key, PEM_BEGIN]) assert.ok(!all.includes(secret), "the bundle never holds " + secret);
  assert.ok(all.includes("a***@example.com") && all.includes("o***@example.com"), "emails are masked as the product masks them");
  assert.ok(all.includes("<ACCOUNT>") && all.includes("<STATE_BUCKET>") && all.includes("<REDACTED TOKEN>"));
  for (const text of texts) assert.deepEqual(secretKinds(text), []);
  const report = readFileSync(join(bundle, "acceptance-report.md"), "utf8");
  assert.match(report, /LIVE evidence collected by the owner, on the owner's own host/);
  assert.match(report, /not CI evidence and\nnot agent-collected\. It does not by itself certify acceptance/);
  assert.match(report, /\| 2 \| .* \| NEEDS_OWNER_CHECK \|/);
  assert.match(report, /\| 7 \| .* \| NOT_APPLICABLE \|/);
  assert.match(report, /\| 5 \| .* \| WAITING \|/);
  assert.match(report, /\| 6 \| .* \| NEEDS_OWNER_CHECK \| Allowed: the cost project's seal succeeded/);
  assert.match(report, /\| Disposition \| \*\*RETAIN\*\*/);
  assert.match(report, /Account id \| masked as `<ACCOUNT>`/);

  // Resuming a finished run runs nothing again and rewrites the bundle.
  const third = onTerminal(f, ["--resume", ...baseArgs(f)]);
  assert.equal(third.status, 0, third.out);
  assert.equal(count(f, /^CALL apply apply /), 1, "the apply never runs twice");
  assert.equal(count(f, /^CALL apply seal /), 1);
});

test("an apply that was attempted and spent is never retried on resume", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "fail-apply"), "");
  const first = onTerminal(f, baseArgs(f));
  assert.equal(first.status, 1, first.out);
  assert.match(first.out, /STOPPED at 10-apply: apply ended SPENT \(exit 3\)/);
  assert.match(first.out, /Next: do not retry\. Follow 'When an apply fails'/);
  rmSync(join(f.dir, "fail-apply"));
  const second = onTerminal(f, ["--resume", ...baseArgs(f)]);
  assert.equal(second.status, 1, second.out);
  assert.match(second.out, /STOPPED at 10-apply: an apply of this sealed plan was already attempted \(exit 3\)/);
  assert.equal(count(f, /^CALL apply apply /), 1);
  // A partial bundle can still be written on request, and it is redacted the same way.
  const bundle = plain(f, ["--bundle", ...baseArgs(f)]);
  assert.equal(bundle.status, 0, bundle.stdout + bundle.stderr);
  assert.match(readFileSync(join(runDir(f), "bundle", "acceptance-report.md"), "utf8"), /\| 1 \| .* \| UNKNOWN \| No saved cost status/);
});

test("the opt-in refused example records RESOURCE_NOT_IN_LIMITS, and --include-account-id keeps the account in the bundle", () => {
  const f = fixture();
  const result = onTerminal(f, [...baseArgs(f), "--refused-example", f.canary, "--include-account-id"]);
  assert.equal(result.status, 0, result.out);
  assert.equal(count(f, new RegExp("^PREPARE " + f.canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " ")), 2);
  const run = runDir(f);
  assert.match(readFileSync(join(run, "steps", "17-refused-seal.env"), "utf8"), /^REFUSAL=RESOURCE_NOT_IN_LIMITS$/m);
  const report = readFileSync(join(run, "bundle", "acceptance-report.md"), "utf8");
  assert.match(report, /\| 6 \| .* \| OBSERVED \| .*Refused: the canary copy's seal stopped with RESOURCE_NOT_IN_LIMITS/);
  assert.match(report, /Account id \| included \(owner opted in\)/);
  assert.ok(walk(join(run, "bundle")).some((p) => readFileSync(p, "utf8").includes(ACCOUNT)));
  assert.equal(count(f, /cleanup|FORBIDDEN/), 0);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return lstatSync(full).isDirectory() ? walk(full) : [full];
  });
}

// --- the script's text: portability, human gates and retention ---------------------------------------------------------------

const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("the script stays portable to Apple's bash 3.2 and BSD tools, parses under /bin/bash, and the macOS job runs this test there", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /^#!\/bin\/bash\n/);
  const syntax = spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const [pattern, what] of [
    [/\brealpath\b/, "realpath"], [/readlink -f/, "readlink -f"], [/\bmapfile\b|\breadarray\b/, "mapfile (bash 4)"],
    [/declare -A|local -A/, "associative arrays (bash 4)"], [/\$\{[A-Za-z_]+(?:,,|\^\^)\}/, "case conversion (bash 4)"], [/\|&|&>>/, "bash 4 redirections"],
    [/--sort|--mtime|-printf|sed -i|cp -a|stat -c|--null|xargs -r|date -d|grep -P/, "GNU-only flags"], [/\$EPOCHSECONDS|\$\{[A-Za-z_]+\[-1\]\}|coproc|wait -n/, "bash 4+ features"],
    [/\b(?:chmod|chown|chgrp)\s+\S+\s+--(?:\s|$)/, "an option terminator after a BSD mode or owner"],
  ] as const) assert.doesNotMatch(code, pattern, what);
  const mac = readFileSync(".github/workflows/act-identity-macos.yml", "utf8");
  assert.match(mac, /npx tsx --test test\/mac-acceptance\.test\.ts/);
  for (const path of [SCRIPT, HELPER, "test/mac-acceptance.test.ts"]) assert.ok(mac.includes("      - " + path + "\n"), path + " starts the macOS job");
});

test("the script never feeds a product prompt, never names a cleanup command, and hands each gate to the person's terminal", () => {
  for (const [pattern, what] of [
    [/<<<|\byes\s*\||\bexpect\b|\| *"\$ALZ"|\|\s*\.\/alz|printf[^\n]*\|\s*(?:"\$ALZ"|in_terminal)/, "input fed to a command"],
    [/propose-cleanup|verify-cleanup|apply cleanup|cleanup --proposal|remove-workspace|propose-removal|force-unlock|TEAR DOWN/, "a cleanup or removal command"],
    [/>\s*"?[^\n]*act-pilot-contract|record-live|record-recovery/, "a write of the contract or a live record"],
  ] as const) assert.doesNotMatch(code, pattern, what);
  // Every ./alz apply command goes through terminal_step (script(1), the person's own stdin), never captured_step.
  const joined = code.replace(/\\\n/g, " ");
  for (const line of joined.split("\n").filter((l) => /"\$ALZ" apply /.test(l))) assert.match(line, /terminal_step|in_terminal/, line);
  assert.match(code, /if \[ ! -t 0 \] \|\| \[ ! -t 1 \]; then stop/);
});

// --- the helper, on the real product functions -----------------------------------------------------------------------------

test("the helper loads the product's own validator and redaction from dist/, and those exports exist in src/", () => {
  assert.deepEqual(DIST_MODULES, { local: "dist/cost/local.js", status: "dist/cost/status.js" });
  assert.equal(typeof readLocalCostConfig, "function");
  assert.equal(typeof readCostSnapshot, "function");
  const status = readFileSync("src/cost/status.ts", "utf8");
  for (const name of ["redactCostStatus", "redactAddress"]) assert.match(status, new RegExp("export function " + name + "\\("));
  // The product output the script reads, by text: a change to any of them must keep the runner working.
  const apply = readFileSync("src/cli/apply.ts", "utf8");
  assert.match(apply, /"\\n {2}record {9}" \+ written\.record/);
  assert.match(apply, /sealedPlanPath: result\.path, reviewBundlePath/);
  assert.match(apply, /out\.say\(JSON\.stringify\(signApproval\(\{/);
  assert.match(readFileSync("src/apply/approval.ts", "utf8"), /return \{ statement, signatureBase64: /);
  const prepare = readFileSync("src/apply/prepare.ts", "utf8");
  assert.match(prepare, /requestFile: paths\.request, applyRequestFile: paths\.applyRequest, manifestFile: paths\.manifest/);
  assert.match(readFileSync("src/cli/real-private-build.ts", "utf8"), /console\.log\("Pilot project \(next: \.\/alz apply prepare --environment DEV --project <it>\): " \+ project\.projectRoot\)/);
  assert.match(apply, /record\.artifactSha256\.slice\(0, 12\) \+ "-observation\.json"/);
});

test("transcripts are parsed as the product prints them", () => {
  const transcript = "\u001b[1mPREPARED\u001b[0m\r\n  record         /r/.runs/pilot/DEV/preparation-ab.json\r\napprove> APPROVE DEV abcdef012345\r\n{\r\n  \"statement\": {\r\n    \"artifactSha256\": \"" + "a".repeat(64) +
    "\"\r\n  },\r\n  \"signatureBase64\": \"c2ln\"\r\n}\r\n{\n  \"artifactSha256\": \"" + "a".repeat(64) + "\",\n  \"sealedPlanPath\": \"/s\",\n  \"reviewBundlePath\": \"/s.review.json\"\n}\n";
  assert.equal(preparationRecordPath(transcript), "/r/.runs/pilot/DEV/preparation-ab.json");
  assert.equal(jsonObjects(transcript).length, 2);
  assert.deepEqual(approvalOf(transcript, "a".repeat(64)), { statement: { artifactSha256: "a".repeat(64) }, signatureBase64: "c2ln" });
  assert.equal(approvalOf(transcript, "b".repeat(64)), undefined, "an approval of another artifact is never taken");
  assert.deepEqual(sealValues(transcript), { SEALED: "/s", REVIEW_BUNDLE: "/s.review.json", ARTIFACT: "a".repeat(64) });
  assert.deepEqual(pilotEnabled('{\n  "act": "DISABLED"\n}\n'), { ok: false, reason: "act is DISABLED" });
  assert.equal(pilotEnabled('{\n  "act": "PILOT_ENABLED",\n  "authorized": [{"environment": "DEV", "operations": ["CLEANUP"]}]\n}\n').ok, false);
});

test("redaction removes keys and tokens, masks emails with the product's own rule and the account unless kept", () => {
  const mask = (address: string) => redactAddress("EMAIL", address);
  const text = "to alerts.owner@example.com via arn:aws:sns:us-east-2:" + ACCOUNT + ":t and arn:aws:iam::999988887777:role/x\n" + JWT + " " + KEY_ID + "\n" +
    "SecretAccessKey: abcdefghijklmnopqrstuvwxyz012345\n" + PEM_BEGIN + "\nAAAA\n" + PEM_END + "\nbucket " + BUCKET;
  const out = redactText(text, { account: ACCOUNT, masks: [[BUCKET, "<STATE_BUCKET>"]], maskEmail: mask });
  assert.ok(out.includes(redactAddress("EMAIL", RECIPIENT)) && out.includes("a***@example.com"));
  for (const gone of [RECIPIENT, ACCOUNT, "999988887777", JWT, KEY_ID, "abcdefghijklmnopqrstuvwxyz012345", PEM_BEGIN, BUCKET]) assert.ok(!out.includes(gone), gone);
  assert.deepEqual(secretKinds(out), []);
  assert.ok(redactText("arn:aws:iam::" + ACCOUNT + ":role/x", { account: ACCOUNT, keepAccount: true }).includes(ACCOUNT));
  assert.deepEqual(secretKinds(text).sort(), ["AWS_ACCESS_KEY_ID", "AWS_SECRET", "JWT", "PRIVATE_KEY", "UNMASKED_EMAIL"]);
});

test("acceptance items 1 to 8 map from the cost status as read; item 2 is always the owner's and item 7 never applies", () => {
  const status = dayOneStatus();
  const byItem = (items: ReturnType<typeof acceptanceItems>) => Object.fromEntries(items.map((i) => [i.item, i.state]));
  assert.deepEqual(byItem(acceptanceItems({ cost: status, seal: { ok: true, changes: 12 }, refused: { exit: "2", code: "RESOURCE_NOT_IN_LIMITS" } })),
    { 1: "NEEDS_OWNER_CHECK", 2: "NEEDS_OWNER_CHECK", 3: "OBSERVED", 4: "WAITING", 5: "WAITING", 6: "OBSERVED", 7: "NOT_APPLICABLE", 8: "OBSERVED" });
  assert.deepEqual(byItem(acceptanceItems({ cost: undefined, seal: undefined, refused: undefined })),
    { 1: "UNKNOWN", 2: "NEEDS_OWNER_CHECK", 3: "UNKNOWN", 4: "UNKNOWN", 5: "UNKNOWN", 6: "UNKNOWN", 7: "NOT_APPLICABLE", 8: "UNKNOWN" });
  // A failed or missing read is never upgraded.
  const worse = dayOneStatus();
  worse.budget.state = "MISSING";
  worse.tags.state = "NO_RESOURCES_FOUND";
  worse.export.state = "STALE";
  worse.costAllocationTags = { state: "INACTIVE", tags: [{ key: "cost-center", status: { label: "OBSERVED", value: "Inactive" }, lastUpdated: { label: "OBSERVED", value: "2026-11-05" } }] };
  const items = acceptanceItems({ cost: worse, seal: { ok: true, changes: 12 }, refused: { exit: "2", code: "ARTIFACT_INVALID" } });
  assert.deepEqual(byItem(items), { 1: "UNKNOWN", 2: "NEEDS_OWNER_CHECK", 3: "UNKNOWN", 4: "OBSERVED", 5: "UNKNOWN", 6: "NEEDS_OWNER_CHECK", 7: "NOT_APPLICABLE", 8: "OBSERVED" });
  assert.match(items[2].evidence, /NO_RESOURCES_FOUND is not a pass/);
  assert.match(items[5].evidence, /not RESOURCE_NOT_IN_LIMITS; an earlier gate may have refused first/);
});

test("the owner's page has a one-page run section, the D4 note for the Mac Mini, the retention default and the label", () => {
  const doc = readFileSync("docs/mac-acceptance-runner.md", "utf8");
  assert.match(doc, /^## Run this$/m);
  assert.match(doc, /scripts\/mac-acceptance\.sh --dry-run --readonly-profile/);
  assert.match(doc, /scripts\/mac-acceptance\.sh --resume/);
  assert.match(doc, /D4 identity-delivery proof was planned for the MacBook Pro runner[\s\S]*must be repeated on the Mac Mini/);
  assert.match(doc, /RETAIN/);
  assert.match(doc, /not CI evidence and not agent-collected/);
  assert.match(doc, /does not by itself certify acceptance/);
  assert.match(doc, /shellcheck/);
});
