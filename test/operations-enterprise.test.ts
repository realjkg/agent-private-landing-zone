import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { LocalSovereignChangeLedger } from "../src/change-ledger/local.js";
import type { ChangeRequest } from "../src/change-ledger/types.js";
import { buildKnowledgeSnapshot } from "../src/knowledge/ingest.js";
import { sealOperationalPlaybook } from "../src/managed-operations/operations.js";
import { CANDIDATE_MODELS } from "../src/models/candidates.js";
import { MODEL_CATALOG } from "../src/models/catalog.js";
import { parseAlertRules } from "../src/monitoring/alert-rules.js";
import { OPERATIONS } from "../src/operations/registry.js";
import { resolveGroupCommand } from "../src/operations/groups.js";
import { planOperation, runPlanned } from "../src/operations/run.js";
import { enterpriseOperations } from "../src/operations/families/enterprise.js";
import type { OperatorJob } from "../src/operations/types.js";

// Drives each ./alz enterprise entry through the path the server uses
// (planOperation, then runPlanned: private files, argument building, the
// forbidden-word check) and runs the real report script from source. Every
// report is offline, so each one is fast.

const text = (value: unknown) => JSON.stringify(value);
const spec = (sub: string) => enterpriseOperations.find((item) => item.id === "enterprise-" + sub)!;

async function execute(sub: string, inputs: object): Promise<{ code: number | null; out: string; job: OperatorJob }> {
  let result: { code: number | null; out: string; job: OperatorJob } | undefined;
  await runPlanned(planOperation("enterprise-" + sub, text(inputs), OPERATIONS), process.cwd(), async (job) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src", job.script.replace(/\.js$/, ".ts")), ...job.args], { encoding: "utf8" });
    result = { code: run.status, out: run.stdout + run.stderr, job };
    return run.stdout;
  });
  return result!;
}

const refusal = (sub: string, inputs: unknown): string => {
  try {
    planOperation("enterprise-" + sub, text(inputs), OPERATIONS);
  } catch (error) {
    return (error as Error).message;
  }
  return "ACCEPTED";
};

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const change: ChangeRequest = {
  changeRecordId: "change-1", actionId: "ops-0001", actionType: "RESTART_SERVICE", authorityClass: "OPERATE",
  environmentId: "private-01", substrate: "KUBERNETES", resourceIds: ["app-1"], initiatingRef: "alert-01",
  requestorId: "human-01", agentActorId: "agent-01", approval: { mode: "LOCAL", state: "PENDING" },
  policyDecisionId: "policy-001", capabilityLeaseId: "lease-pending",
  playbook: { id: "restart-approved-service", version: "1.0.0", sha256: "a".repeat(64) },
  preconditions: ["service-health-confirmed"], maxTargets: 1, execution: { status: "NOT_EXECUTED" },
  verification: "NOT_RUN", recovery: "NOT_RUN", evidenceRefs: ["evidence://local/alert-01"], relatedChangeRecordIds: [], mode: "DISCONNECTED", externalRefs: [],
};
const ledgerExport = () => {
  const dir = mkdtempSync(join(tmpdir(), "alz-ent-ledger-"));
  try {
    new LocalSovereignChangeLedger(dir).create(change, "2026-10-07T23:12:00.000Z");
    return new LocalSovereignChangeLedger(dir).signedExport(keys.privateKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const playbook = {
  playbookId: "restart-approved-service", version: "1.0.0", operation: "RESTART_SERVICE", providerId: "KUBERNETES",
  environmentId: "private-01", targetResourceId: "service-1", preconditions: ["known-service"], maxTargets: 1,
  approvalMode: "LOCAL", verificationRequired: true, recovery: "REQUIRED", timeoutMs: 1500,
};
const binding = { environmentId: "env-01", provider: "KUBERNETES", runtimeProfile: "GOVERNED_ENTERPRISE_CONNECTED", deployment: "EXTERNAL", origin: "https://k8s.example.test" };

test("the family is the seven read-only enterprise entries, all registered with one group", () => {
  assert.deepEqual(enterpriseOperations.map((item) => item.command?.sub),
    ["ledger", "playbook", "alert-rules", "release-lifecycle", "models", "environment", "knowledge"]);
  for (const item of enterpriseOperations) {
    assert.ok(OPERATIONS.includes(item), item.id);
    assert.equal(item.family, "enterprise");
    assert.equal(item.safety, "READ_ONLY");
    assert.equal(item.handoff, undefined);
    assert.ok(existsSync(item.cliScript!), item.cliScript);
    assert.equal(item.job!.script, "cli/" + item.cliScript!.slice("src/cli/".length).replace(/\.ts$/, ".js"));
    // Pasted JSON or short version numbers only: no path, command or credential field.
    for (const field of item.inputs) assert.ok(["json", "enum", "flag"].includes(field.kind) || item.id === "enterprise-release-lifecycle", item.id + "." + field.name);
  }
});

test("./alz enterprise list shows every entry and each subcommand resolves to its script", () => {
  const listed = resolveGroupCommand("enterprise", ["list"]);
  assert.equal(listed?.kind, "list");
  assert.equal(listed?.kind === "list" && listed.lines.length, 7);
  for (const item of enterpriseOperations) {
    assert.deepEqual(resolveGroupCommand("enterprise", [item.command!.sub, "--input", "x.json"]), { kind: "run", script: item.cliScript, args: ["--input", "x.json"] });
  }
  assert.equal(resolveGroupCommand("enterprise", ["delegation"])?.kind, "unknown-subcommand");
});

test("the report code makes no network call, spawns nothing, writes nothing and reads no environment", () => {
  const files = [...readdirSync("src/cli").filter((file) => file.startsWith("enterprise-")).map((file) => "src/cli/" + file), "src/enterprise/report.ts"];
  assert.equal(files.length, 8);
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /child_process|node:https?|node:net|node:dgram|\bfetch\(|writeFile|appendFile|mkdir|process\.env|\bspawn|\bexec(?:Sync|File)?\(/, file);
  }
});

test("ledger: a verified export is reported, a tampered or wrongly keyed one is rejected", async () => {
  const exported = ledgerExport();
  const ok = await execute("ledger", { ledger: text({ export: exported, trustedPublicKeyPem: publicKey }) });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /LEDGER EXPORT VERIFIED/);
  assert.match(ok.out, /Records: 1/);
  assert.match(ok.out, /REQUESTED 1/);
  assert.match(ok.out, /never authorize ACT/);
  assert.deepEqual(ok.job.args.slice(0, 1), ["--input"]);

  const tampered = structuredClone(exported);
  tampered.payload.records[0]!.actionType = "REPLACED";
  const bad = await execute("ledger", { ledger: text({ export: tampered, trustedPublicKeyPem: publicKey }) });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /EXPORT_SIGNATURE_INVALID/);

  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.equal((await execute("ledger", { ledger: text({ export: exported, trustedPublicKeyPem: otherKey }) })).code, 2);
  assert.equal((await execute("ledger", { ledger: text({ export: exported }) })).code, 1);
  assert.equal((await execute("ledger", { ledger: text({ export: exported, trustedPublicKeyPem: "not a key" }) })).code, 2);
});

test("playbook: valid, listed and hash-checked playbooks are reported and never executed", async () => {
  const sealed = sealOperationalPlaybook(playbook as never);
  const single = await execute("playbook", { playbooks: text(playbook) });
  assert.equal(single.code, 0);
  assert.match(single.out, new RegExp("VALID.*hash computed " + sealed.artifactSha256));
  assert.match(single.out, /Nothing was executed/);

  const list = await execute("playbook", { playbooks: text([sealed, { ...playbook, playbookId: "restore-service", operation: "RESTORE_SERVICE" }]) });
  assert.equal(list.code, 0);
  assert.match(list.out, /#1 .*hash matches/);
  assert.match(list.out, /#2 restore-service/);

  const mismatch = await execute("playbook", { playbooks: text({ ...sealed, timeoutMs: 2000 }) });
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.out, /REJECTED/);

  for (const unbounded of [{ ...playbook, maxTargets: 2 }, { ...playbook, operation: "DELETE_EVERYTHING" }, { ...playbook, timeoutMs: 999999 }]) {
    const run = await execute("playbook", { playbooks: text(unbounded) });
    assert.equal(run.code, 2);
    assert.match(run.out, /MANAGED_OPERATIONS_PLAYBOOK_UNBOUNDED/);
  }
  assert.equal((await execute("playbook", { playbooks: text([]) })).code, 1);
});

test("alert-rules: the shipped file by default, a pasted document on request, gaps and errors rejected", async () => {
  const shipped = await execute("alert-rules", {});
  assert.equal(shipped.code, 0);
  assert.match(shipped.out, /ALERT RULES VALID\n/);
  assert.match(shipped.out, /Production signals with no rule: none/);
  assert.deepEqual(shipped.job.args, []);

  const document = parseAlertRules(readFileSync("config/alert-rules.yaml", "utf8"));
  const pasted = await execute("alert-rules", { rules: text(document) });
  assert.equal(pasted.code, 0);
  assert.match(pasted.out, new RegExp("Rules: " + document.rules.length));

  const partial = await execute("alert-rules", { rules: text({ ...document, rules: document.rules.slice(0, 1) }) });
  assert.equal(partial.code, 2);
  assert.match(partial.out, /INCOMPLETE/);

  for (const broken of [{ ...document, rules: [{ ...document.rules[0], signal: "invented" }] }, { ...document, extra: true },
    { ...document, rules: [{ ...document.rules[0], window: "5 minutes" }] }, { ...document, rules: "none" },
    { ...document, rules: [{ ...document.rules[0], id: "a\nb" }] }]) {
    const run = await execute("alert-rules", { rules: text(broken) });
    assert.equal(run.code, 2, text(broken));
    assert.match(run.out, /ALERT RULES REJECTED/);
  }
});

test("release-lifecycle: plans the steps in order and refuses what the library refuses", async () => {
  const upgrade = await execute("release-lifecycle", { targetVersion: "1.4.0", targetConfigSchema: "3", currentVersion: "1.3.0",
    currentConfigSchema: "2", previousVersion: "1.2.0", uninstallVersion: "1.1.0" });
  assert.equal(upgrade.code, 0);
  const steps = upgrade.out.split("\n").filter((line) => /^\d\./.test(line)).map((line) => line.split(" ")[1]);
  assert.deepEqual(steps, ["UPGRADE", "MIGRATE_CONFIG", "ROLLBACK", "UNINSTALL"]);
  assert.match(upgrade.out, /backup first/);
  assert.match(upgrade.out, /Nothing was installed/);
  assert.deepEqual(upgrade.job.args.slice(0, 4), ["--target-version", "1.4.0", "--target-config-schema", "3"]);

  const fresh = await execute("release-lifecycle", { targetVersion: "1.4.0", targetConfigSchema: "3" });
  assert.match(fresh.out, /CLEAN_INSTALL/);
  assert.match((await execute("release-lifecycle", { targetVersion: "1.3.0", targetConfigSchema: "2", currentVersion: "1.3.0", currentConfigSchema: "2" })).out, /No step needed/);

  const denied = await execute("release-lifecycle", { targetVersion: "1.4.0", targetConfigSchema: "3", currentVersion: "1.3.0", uninstallVersion: "1.3.0" });
  assert.equal(denied.code, 2);
  assert.match(denied.out, /RELEASE_UNINSTALL_CURRENT_DENIED/);
});

test("release-lifecycle: version and schema inputs are refused before any job is built", () => {
  assert.equal(refusal("release-lifecycle", {}), "INPUT_REQUIRED:targetVersion");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0" }), "INPUT_REQUIRED:targetConfigSchema");
  assert.equal(refusal("release-lifecycle", { targetVersion: "--x", targetConfigSchema: "1" }), "INPUT_CHARACTERS:targetVersion");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0; rm", targetConfigSchema: "1" }), "INPUT_PATTERN:targetVersion");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0", targetConfigSchema: "three" }), "INPUT_PATTERN:targetConfigSchema");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0", targetConfigSchema: "1", currentVersion: "x".repeat(41) }), "INPUT_TOO_LONG:currentVersion");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0", targetConfigSchema: "1", path: "/etc" }), "INPUT_UNKNOWN_FIELD");
  assert.equal(refusal("release-lifecycle", { targetVersion: "1.0.0\n", targetConfigSchema: "1" }), "INPUT_CHARACTERS:targetVersion");
  // The word filter also applies at validation: a version that spells a mutation word never reaches a job.
  assert.equal(refusal("release-lifecycle", { targetVersion: "apply-1", targetConfigSchema: "1" }), "INPUT_FORBIDDEN:targetVersion");
});

test("models: lists candidates with a literal status, filters by role, locality and laptop fit", async () => {
  const all = await execute("models", {});
  assert.equal(all.code, 0);
  assert.match(all.out, new RegExp("MODEL CANDIDATES \\(" + CANDIDATE_MODELS.length + "\\)"));
  assert.deepEqual(all.job.args, []);
  assert.match(all.out, /CANDIDATE ONLY, NOT QUALIFIED/);
  assert.match(all.out, /actEnabled=false/);
  const inCatalog = CANDIDATE_MODELS.filter((model) => MODEL_CATALOG.some((entry) => entry.model === model.runtimeModel)).length;
  assert.equal(all.out.split("IN ACTIVE CATALOG").length - 1, inCatalog);
  assert.equal(all.out.split("CANDIDATE ONLY, NOT QUALIFIED").length - 1, CANDIDATE_MODELS.length - inCatalog);

  const router = await execute("models", { role: "ROUTER", local: true, laptop24: true });
  assert.deepEqual(router.job.args, ["--role", "ROUTER", "--local", "--laptop-24gb"]);
  const lines = router.out.split("\n").filter((line) => /: (CANDIDATE|IN ACTIVE)/.test(line));
  assert.ok(lines.length > 0 && lines.length < CANDIDATE_MODELS.length);
  for (const line of lines) {
    assert.match(line, /ROUTER/);
    assert.doesNotMatch(line, /laptop 24 GB NO|24 GB laptop NO/);
  }
  assert.equal(refusal("models", { role: "ADMIN" }), "INPUT_ENUM:role");
  assert.equal(refusal("models", { role: "ROUTER; x" }), "INPUT_ENUM:role");
});

test("models: the locality and laptop filters also apply when no role is chosen", async () => {
  const laptop = await execute("models", { laptop24: true });
  assert.deepEqual(laptop.job.args, ["--laptop-24gb"]);
  const expected = CANDIDATE_MODELS.filter((model) => model.laptop24Fit !== "NO");
  assert.ok(expected.length < CANDIDATE_MODELS.length, "the fixture must include a candidate that does not fit");
  const lines = laptop.out.split("\n").filter((line) => /: (CANDIDATE|IN ACTIVE)/.test(line));
  assert.equal(lines.length, expected.length);
  assert.match(laptop.out, new RegExp("MODEL CANDIDATES \\(" + expected.length + "\\)"));
  for (const line of lines) assert.doesNotMatch(line, /24 GB laptop NO/);
  const local = await execute("models", { local: true });
  const localCount = CANDIDATE_MODELS.filter((model) => model.substrates.some((id) => id === "OLLAMA_LOCAL" || id === "FOUNDRY_LOCAL")).length;
  assert.match(local.out, new RegExp("MODEL CANDIDATES \\(" + localCount + "\\)"));
});

test("environment: bindings and signed edge manifests are checked without a request or a credential", async () => {
  const ok = await execute("environment", { environment: text({ binding }) });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /ENVIRONMENT BINDING ACCEPTED/);
  assert.match(ok.out, /sent no request and holds no credential/);
  assert.equal((await execute("environment", { environment: text({ binding: { ...binding, authRef: "secret://k8s/reader" } }) })).code, 0);

  const secret = "AKIAIOSFODNN7EXAMPLE";
  const cases: [object, RegExp][] = [
    [{ ...binding, origin: "http://k8s.example.test" }, /ENVIRONMENT_ORIGIN_INVALID/],
    [{ ...binding, origin: "https://user:pw@k8s.example.test" }, /ENVIRONMENT_ORIGIN_INVALID/],
    [{ ...binding, authRef: secret }, /ENVIRONMENT_CREDENTIAL_REF_INVALID/],
    [{ ...binding, token: "abc" }, /ENVIRONMENT_BINDING_FIELD_UNKNOWN/],
    [{ ...binding, runtimeProfile: "PRIVATE_SOVEREIGN_CONNECTED" }, /ENVIRONMENT_SOVEREIGNTY_DENIED/],
    [{ ...binding, runtimeProfile: "PRIVATE_SOVEREIGN_DISCONNECTED", deployment: "SOVEREIGN_DOMAIN" }, /ENVIRONMENT_DISCONNECTED_LOCAL_ONLY/],
    [{ ...binding, environmentId: "-bad id" }, /ENVIRONMENT_ID_INVALID/],
  ];
  for (const [bad, pattern] of cases) {
    const run = await execute("environment", { environment: text({ binding: bad }) });
    assert.equal(run.code, 2, text(bad));
    assert.match(run.out, pattern);
    assert.doesNotMatch(run.out, new RegExp(secret));
  }

  const rawManifest = text({ schemaVersion: 1, environmentId: "edge-01", assets: [{ id: "node-01", kind: "EDGE_NODE", name: "appliance", health: "HEALTHY" }] });
  const edge = { rawManifest, signatureBase64: sign(null, Buffer.from(rawManifest), keys.privateKey).toString("base64"),
    trustedPublicKeyPem: publicKey, runtimeProfile: "PRIVATE_SOVEREIGN_DISCONNECTED" };
  const verified = await execute("environment", { environment: text({ edge }) });
  assert.equal(verified.code, 0);
  assert.match(verified.out, /edge-01: health HEALTHY, 1 assets/);
  assert.match(verified.out, /EDGE_HEALTH_ATTESTED_NOT_LIVE/);
  const forged = await execute("environment", { environment: text({ edge: { ...edge, rawManifest: rawManifest + " " } }) });
  assert.equal(forged.code, 2);
  assert.match(forged.out, /EDGE_SIGNATURE_INVALID/);
  assert.equal((await execute("environment", { environment: text({}) })).code, 2);
});

test("knowledge: the baseline is listed, and a pasted snapshot is accepted or rejected with reasons", async () => {
  const baseline = await execute("knowledge", {});
  assert.equal(baseline.code, 0);
  assert.match(baseline.out, /KNOWLEDGE SOURCES/);
  assert.match(baseline.out, /TERRAFORM_REGISTRY: ACCEPTED/);
  assert.match(baseline.out, /registered, no baseline snapshot/);
  assert.match(baseline.out, /Nothing was fetched or ingested/);
  assert.equal((await execute("knowledge", { privateSovereign: true })).code, 0);

  const snapshot = buildKnowledgeSnapshot({
    sourceId: "TERRAFORM_REGISTRY", sourceUri: "https://registry.terraform.io/", retrievedAt: "2026-10-08T02:15:00.000Z",
    contentType: "application/json", records: [{ recordId: "r1", kind: "SOURCE_FACT", title: "Fact", metadata: {} }],
  });
  const accepted = await execute("knowledge", { snapshot: text(snapshot) });
  assert.equal(accepted.code, 0);
  assert.match(accepted.out, /TERRAFORM_REGISTRY: ACCEPTED \(1 records/);
  const needsMirror = await execute("knowledge", { snapshot: text(snapshot), privateSovereign: true });
  assert.equal(needsMirror.code, 2);
  assert.match(needsMirror.out, /approved local mirror/);
  assert.deepEqual(needsMirror.job.args.slice(-1), ["--private-sovereign"]);

  const rejects: [object, RegExp][] = [
    [{ ...snapshot, records: [{ ...snapshot.records[0], title: "Changed" }] }, /hash mismatch/],
    [{ ...snapshot, sourceUri: "https://evil.example.test/" }, /canonical source/],
    [{ ...snapshot, records: [] }, /no records/],
    [{ ...snapshot, records: [snapshot.records[0], snapshot.records[0]] }, /unique/],
    [buildKnowledgeSnapshot({ ...snapshot, records: [{ recordId: "r1", kind: "SOURCE_FACT", title: "Fact", metadata: { apiKey: "x" } }] }), /credential-like/],
  ];
  for (const [bad, pattern] of rejects) {
    const run = await execute("knowledge", { snapshot: text(bad) });
    assert.equal(run.code, 2, text(bad).slice(0, 80));
    assert.match(run.out, pattern);
  }
});

test("every JSON entry refuses missing, oversize, malformed and unknown input through the shared validator", () => {
  for (const [sub, field] of [["ledger", "ledger"], ["playbook", "playbooks"], ["environment", "environment"]] as const) {
    assert.equal(refusal(sub, {}), "INPUT_REQUIRED:" + field);
    assert.equal(refusal(sub, { [field]: "{not json" }), "INPUT_JSON_INVALID:" + field);
    assert.equal(refusal(sub, { [field]: text("x".repeat(64 * 1024)) }), "INPUT_TOO_LARGE:" + field);
    assert.equal(refusal(sub, { [field]: 5 }), "INPUT_TYPE:" + field);
    assert.equal(refusal(sub, { [field]: "{}", file: "/etc/passwd" }), "INPUT_UNKNOWN_FIELD");
  }
  for (const [sub, field] of [["alert-rules", "rules"], ["knowledge", "snapshot"]] as const) {
    assert.equal(refusal(sub, { [field]: "{not json" }), "INPUT_JSON_INVALID:" + field);
    assert.equal(refusal(sub, { [field]: text("x".repeat(64 * 1024)) }), "INPUT_TOO_LARGE:" + field);
    assert.equal(refusal(sub, {}), "ACCEPTED");
  }
  assert.equal(refusal("knowledge", { privateSovereign: "yes" }), "INPUT_TYPE:privateSovereign");
  assert.throws(() => planOperation("enterprise-delegation", "{}", OPERATIONS), /UNSUPPORTED_OPERATION/);
});
