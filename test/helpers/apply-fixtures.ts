import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { signApproval } from "../../src/apply/approval.js";
import { writeQualificationEvidence } from "../../src/apply/contract.js";
import { finalizeArtifact, releaseReservation, reserveArtifact } from "../../src/apply/ledger.js";
import type { SealRequest } from "../../src/apply/driver.js";
import { APPLY_ADAPTER } from "../../src/apply/terraform.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyResult, SealedPlan, SignedApproval } from "../../src/apply/types.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../../src/teardown/driver/adapters/terraform.js";
import type { QualificationRecord } from "../../src/teardown/driver/qualification.js";
import type { ResolvedTarget } from "../../src/teardown/driver/types.js";
import { buildManifest, canonicalJson, type ArtifactManifest } from "../../src/teardown/manifest.js";
import { captureProjectFiles } from "../../src/teardown/snapshot.js";

// Shared by test/apply-driver, apply-seal and apply-terraform. Explicit fixtures
// only: no real tenant, subscription, approver or credential. The engine is a
// fake executable, so everything built on it pins logic, NOT real-engine behavior.

export const PLAN_CANARY = "CANARY_PLAN_BYTES_c1";
export const VALUE_CANARY = "CANARY_PLAN_VALUE_c2";
export const STATE_CANARY = "CANARY_STATE_VALUE_c3";
export const OUTPUT_CANARY = "CANARY_APPLY_OUTPUT_c4";
export const CANARIES = [PLAN_CANARY, VALUE_CANARY, STATE_CANARY, OUTPUT_CANARY];

export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const H = (char: string): string => char.repeat(64);
export const LOCK = '# lock\nprovider "registry.terraform.io/hashicorp/azurerm" {\n  version = "4.10.0"\n}\n';
export const TENANT = "11111111-1111-4111-8111-111111111111";
export const DEV_TARGET: ResolvedTarget = { account: "22222222-2222-4222-8222-222222222222", backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default" };
export const PROD_TARGET: ResolvedTarget = { account: "33333333-3333-4333-8333-333333333333", backend: "fixtureprodstore/tfstate/prod.tfstate", workspace: "default" };
export const targetOf = (environment: ApplyEnvironment): ResolvedTarget => (environment === "DEV" ? DEV_TARGET : PROD_TARGET);
export const NOW = new Date("2026-10-11T12:00:00.000Z");
export const POLICY = "2026-10-11.1";
export const OPERATOR = "operator.fixture";
export const ENGINE_VERSION = "1.9.5";

// --- the fake engine ---------------------------------------------------------------------------

/** Behaviors are read from behavior.json beside the executable, so each test chooses how the engine acts. */
export type Behavior = {
  version?: string; workspace?: string; failOn?: string; planSalt?: string;
  initWrites?: Array<{ path: string; content: string }>;
  applyExit?: number; applyStderr?: string; applyAdvance?: boolean; applyKill?: boolean;
  /** Creates this file as soon as the named subcommand starts (a kill switch appearing mid-run). */
  touchKillOn?: string;
  /** The apply waits until this file exists (or is stopped), so a test can act while it runs. */
  applyWaitFor?: string;
  /** SIGINT is ignored, so only the final kill ends the apply. */
  ignoreSigint?: boolean;
  /** Plants this text in stderr of the named failing subcommand. */
  failStderr?: string;
  /** Sends this signal to the process that started the engine as soon as the named subcommand starts (a person closing the terminal mid-run). */
  signalParentOn?: { cmd: string; signal: string };
  /** The apply leaves these files in its working directory before it ends (errored.tfstate, crash.log). */
  applyWrites?: Array<{ path: string; content: string }>;
  /** `show` reports one more resource than the plan the seal listed. */
  showExtra?: boolean;
  /** Raw `resource_changes` entries (imports, moves, forgets, hostile addresses), `output_changes` and `configuration.provider_config` that `show` adds. */
  showResources?: unknown[];
  showOutputChanges?: Record<string, unknown>;
  showProviderConfig?: Record<string, unknown>;
  /** What `init` saves in .terraform/terraform.tfstate. Default: the azurerm backend of the target whose subscription init runs under; null saves none. */
  savedBackend?: unknown;
};

const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const dir = __dirname;
const b = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const args = process.argv.slice(2);
const [cmd, sub] = args;
const serialFile = path.join(dir, "serial.txt");
const serial = () => Number(fs.readFileSync(serialFile, "utf8"));
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), env: process.env, ...extra }) + "\\n");
const backend = () => { const a = args.find((x) => x.startsWith("-backend-config=")); return a ? fs.readFileSync(path.resolve(process.cwd(), a.slice(16)), "utf8") : undefined; };
if (b.touchKillOn === cmd) fs.writeFileSync(b.killPath, "stop");
if (b.signalParentOn && b.signalParentOn.cmd === cmd) process.kill(process.ppid, b.signalParentOn.signal);
if (b.failOn === cmd) { log({}); process.stderr.write(b.failStderr || "boom ${VALUE_CANARY}"); process.exit(1); }
if (cmd === "version") { log({}); process.stdout.write(JSON.stringify({ terraform_version: b.version })); }
else if (cmd === "init") {
  fs.mkdirSync(".terraform", { recursive: true });
  if (b.savedBackend !== null) {
    const def = (${JSON.stringify({ [DEV_TARGET.account]: DEV_TARGET.backend, [PROD_TARGET.account]: PROD_TARGET.backend })})[process.env.ARM_SUBSCRIPTION_ID];
    const [account, container, ...key] = (def || "").split("/");
    const backend = b.savedBackend || { type: "azurerm", config: { storage_account_name: account, container_name: container, key: key.join("/") } };
    fs.writeFileSync(path.join(".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
  }
  for (const w of b.initWrites || []) { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.content); }
  log({ backendConfig: backend() });
}
else if (cmd === "workspace") { log({}); if (sub === "show") process.stdout.write(b.workspace + "\\n"); }
else if (cmd === "state" && sub === "pull") { log({}); process.stdout.write(JSON.stringify({ version: 4, serial: serial(), resources: [{ attributes: { password: "${STATE_CANARY}" } }] })); }
else if (cmd === "plan") {
  const p = path.resolve(process.cwd(), args.find((a) => a.startsWith("-out=")).slice(5));
  fs.writeFileSync(p, "BINARY-PLAN ${PLAN_CANARY} " + (b.planSalt || ""));
  log({ planPath: p });
}
else if (cmd === "show") {
  log({});
  process.stdout.write(JSON.stringify({
    format_version: "1.2", errored: false, variables: { db_password: { value: "${VALUE_CANARY}" } },
    resource_changes: [
      { address: "azurerm_resource_group.pilot", type: "azurerm_resource_group", change: { actions: ["create"], before: null, after: { tags: { k: "${VALUE_CANARY}" } } } },
      { address: "azurerm_log_analytics_workspace.pilot", type: "azurerm_log_analytics_workspace", change: { actions: ["update"], before: {}, after: {} } },
      ...(b.showExtra ? [{ address: "azurerm_key_vault.extra", type: "azurerm_key_vault", change: { actions: ["delete"], before: {}, after: null } }] : []),
      ...(b.showResources || []),
    ],
    output_changes: b.showOutputChanges || {},
    configuration: { provider_config: b.showProviderConfig || { azurerm: { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm", expressions: { subscription_id: { references: ["var.subscription_id"] } } } } },
  }));
}
else if (cmd === "apply") {
  for (const w of b.applyWrites || []) fs.writeFileSync(w.path, w.content);
  const p = path.resolve(process.cwd(), args[3]);
  const bytes = fs.readFileSync(p);
  log({ planSha: crypto.createHash("sha256").update(bytes).digest("hex"), planMode: fs.statSync(p).mode & 0o777, planText: bytes.toString("utf8"), planDir: path.dirname(p), pid: process.pid });
  const finish = () => {
    if (b.applyAdvance) fs.writeFileSync(serialFile, String(serial() + 1));
    process.stdout.write("APPLY-OUTPUT ${OUTPUT_CANARY}");
    if (b.applyKill) process.kill(process.pid, "SIGKILL");
    if (b.applyStderr) process.stderr.write(b.applyStderr);
    process.exit(b.applyExit || 0);
  };
  if (b.applyWaitFor) {
    process.on("SIGINT", () => { if (b.ignoreSigint) return; fs.appendFileSync(path.join(dir, "signals.txt"), "SIGINT\\n"); process.exit(1); });
    process.on("SIGTERM", () => { fs.appendFileSync(path.join(dir, "signals.txt"), "SIGTERM\\n"); process.exit(1); });
    const tick = () => { if (fs.existsSync(b.applyWaitFor)) finish(); else setTimeout(tick, 20); };
    tick();
  } else finish();
}
else { log({ unexpected: true }); process.exit(2); }
`;

export function installFakeTerraform(toolDir: string): void {
  writeFileSync(join(toolDir, "terraform"), FAKE, { mode: 0o755 });
  chmodSync(join(toolDir, "terraform"), 0o755);
}

export function behave(toolDir: string, killPath: string, behavior: Behavior = {}): void {
  writeFileSync(join(toolDir, "behavior.json"), JSON.stringify({ version: ENGINE_VERSION, workspace: "default", killPath, ...behavior }));
  writeFileSync(join(toolDir, "serial.txt"), "7");
  for (const name of ["calls.jsonl", "signals.txt"]) rmSync(join(toolDir, name), { force: true });
  rmSync(killPath, { force: true });
}

export type Call = {
  args: string[]; cwd: string; env: Record<string, string>; backendConfig?: string; planPath?: string;
  planSha?: string; planMode?: number; planText?: string; planDir?: string; pid?: number;
};
export const callsOf = (toolDir: string): Call[] => existsSync(join(toolDir, "calls.jsonl"))
  ? readFileSync(join(toolDir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Call)
  : [];
export const signalsOf = (toolDir: string): string[] => existsSync(join(toolDir, "signals.txt"))
  ? readFileSync(join(toolDir, "signals.txt"), "utf8").trim().split("\n") : [];

// --- identities --------------------------------------------------------------------------------

/** The four identities for one environment's tenant and subscription, plus the operator's own ambient credentials (never to reach a child). */
export const identityEnv = (environment: ApplyEnvironment): NodeJS.ProcessEnv => {
  const place = (name: string) => ({
    ["ALZ_" + name + "_ARM_TENANT_ID"]: TENANT, ["ALZ_" + name + "_ARM_SUBSCRIPTION_ID"]: targetOf(environment).account,
  });
  return {
    HOME: "/home/operator", ARM_CLIENT_SECRET: "operator-ambient-secret", AZURE_CLIENT_SECRET: "operator-azure-secret",
    ALZ_DISCOVERY_ARM_CLIENT_ID: "discovery-client-1", ALZ_DISCOVERY_ARM_CLIENT_SECRET: "discovery-secret-aaaa", ...place("DISCOVERY"),
    ALZ_STATE_ARM_CLIENT_ID: "state-client-2", ALZ_STATE_ARM_CLIENT_SECRET: "state-secret-bbbb", ...place("STATE"),
    ALZ_STATE_WRITE_ARM_CLIENT_ID: "statewrite-client-3", ALZ_STATE_WRITE_ARM_CLIENT_SECRET: "statewrite-secret-cccc", ...place("STATE_WRITE"),
    ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: "/run/fixture/statewrite-oidc-token",
    ALZ_APPLY_ARM_CLIENT_ID: "apply-client-4", ALZ_APPLY_ARM_CLIENT_SECRET: "apply-secret-dddd", ...place("APPLY"),
  } as NodeJS.ProcessEnv;
};
export const ENV = identityEnv("DEV");

// --- approvers and the pinned contract ----------------------------------------------------------

const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
export const keys = { alice: newKey(), bob: newKey(), carol: newKey(), mallory: newKey() };
export const approvers = [
  { id: "alice", publicKeyPem: keys.alice.pub, environments: ["DEV", "PROD"] },
  { id: "bob", publicKeyPem: keys.bob.pub, environments: ["DEV", "PROD"] },
  { id: "carol", publicKeyPem: keys.carol.pub, environments: ["DEV"] },
];

export const contractJson = (killPath: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, enabled: true, provider: "AZURE", engine: "TERRAFORM",
  targets: {
    DEV: { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default" },
    PROD: { tenantId: TENANT, subscriptionId: PROD_TARGET.account, backend: PROD_TARGET.backend, workspace: "default" },
  },
  requiredApprovals: { DEV: 1, PROD: 2 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: killPath, ...over,
});

/** The committed pin the contract is loaded against: its canonical sha256, in `<path>.sha256`. */
export const pinPathOf = (contractPath: string): string => contractPath + ".sha256";
export function writePinnedContract(contractPath: string, contract: unknown): void {
  writeFileSync(contractPath, JSON.stringify(contract));
  writeFileSync(pinPathOf(contractPath), sha(canonicalJson(contract as never)) + "\n");
}

// --- qualification -------------------------------------------------------------------------------

/** The shape of an apply qualification record. `evidenceHash` is a bare hash unless the caller wrote evidence for it. */
export const applyRecordOf = (over: Partial<QualificationRecord> = {}): QualificationRecord => ({
  engine: "TERRAFORM", adapterVersion: APPLY_ADAPTER.adapterVersion, engineVersion: ENGINE_VERSION, argvDigest: APPLY_ADAPTER.argvDigest,
  qualifiedAt: "2026-10-11T00:00:00.000Z", evidenceHash: H("e"), ...over,
});

const forgedEvidenceForTests = (adapterVersion: string, argvDigest: string) => ({
  schemaVersion: 1 as const, engine: "TERRAFORM" as const, realEngine: true as const, backendIdentitySeparated: true as const,
  tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default",
  stateWriteClientId: "statewrite-client-3", applyClientId: "apply-client-4", terraformSha256: sha(FAKE),
  adapterVersion, argvDigest, engineVersion: ENGINE_VERSION,
  qualifiedAt: "2026-10-11T00:00:00.000Z",
});

/**
 * TEST FIXTURE. FORGES qualification evidence: it attests `realEngine` and `backendIdentitySeparated` without any real
 * engine run or cloud-log check, which `./alz apply qualify` only does after a person's attestation. Production code
 * must never call it; it lives under test/, which nothing in src/ imports.
 * Writes into `vaultDir`, where the driver reads its records from: the apply adapter's, the preview adapter's, or both.
 * A vault holding only one shows the other adapter is not qualified.
 */
export async function testFixtureForgeQualificationEvidence(vaultDir: string, only?: "apply" | "preview"): Promise<{ applyRecord: QualificationRecord; previewRecord: QualificationRecord }> {
  const write = async (adapterVersion: string, argvDigest: string, skip: boolean): Promise<string> => {
    const evidence = forgedEvidenceForTests(adapterVersion, argvDigest);
    if (skip) return sha(canonicalJson(evidence as never));
    const written = await writeQualificationEvidence(evidence, vaultDir);
    if (!written.ok) throw new Error("fixture qualification evidence rejected");
    return written.evidenceHash;
  };
  const applyHash = await write(APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest, only === "preview");
  const previewHash = await write(ADAPTER_VERSION, terraformArgvDigest("TERRAFORM"), only === "apply");
  return {
    applyRecord: applyRecordOf({ evidenceHash: applyHash }),
    previewRecord: {
      engine: "TERRAFORM", adapterVersion: ADAPTER_VERSION, engineVersion: ENGINE_VERSION, argvDigest: terraformArgvDigest("TERRAFORM"),
      qualifiedAt: "2026-10-11T00:00:00.000Z", evidenceHash: previewHash,
    },
  };
}

// --- projects and approvals ----------------------------------------------------------------------

export type Project = { projectRoot: string; manifest: ArtifactManifest; resolved: SealRequest["resolved"] };
export function writeProject(projectRoot: string, target: ResolvedTarget, mainTf = 'resource "azurerm_resource_group" "pilot" {}\n'): Project {
  writeFileSync(join(projectRoot, "main.tf"), mainTf);
  writeFileSync(join(projectRoot, ".terraform.lock.hcl"), LOCK);
  const resolved: SealRequest["resolved"] = {
    engineVersion: ENGINE_VERSION, providers: [{ source: "registry.terraform.io/hashicorp/azurerm", version: "4.10.0" }],
    lockFileSha256: sha(LOCK), dependencies: [], inputs: [{ name: "region", identity: H("f") }],
  };
  const manifest = buildManifest({
    engine: "TERRAFORM", mode: "PROJECT", target, unitHash: H("1"), files: captureProjectFiles(projectRoot), policyVersion: POLICY, ...resolved,
  });
  return { projectRoot, manifest, resolved };
}

export const human = (target: ResolvedTarget, operatorId = OPERATOR) => ({
  operatorId, interactiveSession: true as const, confirmedTarget: { ...target }, confirmedAt: NOW.toISOString(),
});

export const approvalFor = (sealed: SealedPlan, who: keyof typeof keys, over: Partial<SignedApproval["statement"]> = {}): SignedApproval =>
  signApproval({
    schemaVersion: 1, artifactSha256: sealed.artifactSha256, environment: sealed.environment, target: sealed.target, approverId: who,
    issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
    nonce: randomBytes(16).toString("hex"), ...over,
  }, keys[who].priv);

/** Records an applied artifact the way a run does: reserve it, then replace the reservation with the evidence. A rejected record leaves nothing behind. */
export async function recordApplied(evidence: ApplyEvidence, evidenceDir: string): Promise<ApplyResult> {
  const reserved = await reserveArtifact(evidence.artifactSha256, evidenceDir, NOW);
  if (!reserved.ok) return reserved;
  const written = await finalizeArtifact(evidence, evidenceDir);
  if (!written.ok) await releaseReservation(evidence.artifactSha256, evidenceDir);
  return written;
}
