import { createPublicKey } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encryptEvidence, ensureEvidenceKey, readEncryptedEvidence } from "../evidence/vault.js";
import type { QualificationRecord } from "../teardown/driver/qualification.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { canonicalJson } from "../teardown/manifest.js";
import { sha256 } from "../util/sha256.js";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";
import { GUID, HASH } from "./constants.js";
import { applyEvidenceProblems, qualificationEvidenceProblems, type QualificationEvidence } from "./evidence.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyRefusalCode, ApplyResult, ApproverEntry, PilotContract, PilotTarget } from "./types.js";

/**
 * The pilot release contract (docs/act-pilot-plan.md, authority model 9). This
 * is the only place ACT is enabled for the pilot: a file the owner writes, never
 * a flag or an environment variable. Anything missing, malformed or unknown is
 * disabled, and an unknown field is refused rather than ignored.
 *
 * The contract is also pinned: its canonical sha256 must equal the committed
 * config/act-pilot-contract.sha256 (empty or absent means disabled), so enabling
 * ACT, or changing a target or an approver, is a reviewed commit. Release
 * admission checks the same pin. Every path is anchored to the repository root
 * found from this module, never to process.cwd(). The same-uid operator holds
 * the working tree and the evidence key and is inside the trust boundary; the
 * pin makes a change reviewable, it does not stop that operator.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Every location the apply path reads or writes by default. The driver and the CLI take them from here. */
export const repoPaths = () => ({
  root: ROOT,
  contract: join(ROOT, "config/act-pilot-contract.json"),
  pin: join(ROOT, "config/act-pilot-contract.sha256"),
  evidence: join(ROOT, ".runs/apply/evidence"),
  qualifications: join(ROOT, ".runs/apply/qualification"),
  nonces: join(ROOT, ".runs/apply"),
});
export const DEFAULT_EVIDENCE_DIR = repoPaths().evidence;

/** ACT_DISABLED: no contract, or one that says enabled: false. CONTRACT_INVALID: a contract is present but malformed, unpinned-by-mismatch or invalid. */
type DisabledContract = { enabled: false; reason: string; code: "ACT_DISABLED" | "CONTRACT_INVALID" };
export type Refusal = Extract<ApplyResult, { ok: false }>;
export type Check = { ok: true } | Refusal;

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

/** Why a contract did not load, as the one refusal every entry point reports (the driver and the CLI). */
export const contractRefusal = (disabled: Pick<DisabledContract, "reason" | "code">): Refusal => refuse(disabled.code,
  disabled.code === "ACT_DISABLED"
    ? "ACT is disabled: " + disabled.reason + ". Only a valid, pinned pilot contract with enabled set to true enables it."
    : "The pilot contract cannot be used (" + disabled.reason + "). ACT stays disabled.");

class Invalid extends Error {}
const bad = (message: string): never => { throw new Invalid(message); };

const WORKSPACE = /^[A-Za-z0-9_-]{1,90}$/;
const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEY_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const ENVIRONMENTS: readonly ApplyEnvironment[] = ["DEV", "PROD"];

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad(path + ": expected an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) bad(path + "." + key + ": unknown field");
  for (const key of keys) if (!Object.hasOwn(record, key)) bad(path + "." + key + ": missing");
  return record;
}

const text = (value: unknown, path: string, ok: (v: string) => boolean): string =>
  typeof value === "string" && ok(value) ? value : bad(path + ": invalid");

const integer = (value: unknown, path: string, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : bad(path + ": expected an integer from " + min + " to " + max);

function backendOk(value: string): boolean {
  const [account, container, ...key] = value.split("/");
  return STORAGE_ACCOUNT.test(account) && CONTAINER.test(container ?? "") && key.length > 0 && key.every((s) => KEY_SEGMENT.test(s));
}

function target(value: unknown, path: string): PilotTarget {
  const r = object(value, path, ["tenantId", "subscriptionId", "backend", "workspace"]);
  return {
    tenantId: text(r.tenantId, path + ".tenantId", (v) => GUID.test(v)),
    subscriptionId: text(r.subscriptionId, path + ".subscriptionId", (v) => GUID.test(v)),
    backend: text(r.backend, path + ".backend", backendOk),
    workspace: text(r.workspace, path + ".workspace", (v) => WORKSPACE.test(v)),
  };
}

/** The key itself, not its PEM text: the same Ed25519 key written two ways is one key. Throws for anything else. */
export function canonicalPublicKey(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 public key");
  return key.export({ type: "spki", format: "der" }).toString("hex");
}

const APPROVER_ID = /^[A-Za-z0-9._@+-]{1,64}$/;

function approvers(value: unknown, path: string): ApproverEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return bad(path + ": expected a list of 1 to 50 approvers");
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.map((item, index) => {
    const p = path + "[" + index + "]";
    const r = object(item, p, ["id", "publicKeyPem", "environments"]);
    const id = text(r.id, p + ".id", (v) => APPROVER_ID.test(v));
    const publicKeyPem = text(r.publicKeyPem, p + ".publicKeyPem", (v) => { try { canonicalPublicKey(v); return true; } catch { return false; } });
    const environments = r.environments;
    if (!Array.isArray(environments) || environments.length === 0 || new Set(environments).size !== environments.length ||
      environments.some((e) => !ENVIRONMENTS.includes(e as ApplyEnvironment))) {
      bad(p + ".environments: expected distinct DEV and PROD values");
    }
    if (ids.has(id.toLowerCase())) bad(p + ".id: duplicate approver id");
    ids.add(id.toLowerCase());
    const canonical = canonicalPublicKey(publicKeyPem);
    if (keys.has(canonical)) bad(p + ".publicKeyPem: duplicate public key");
    keys.add(canonical);
    return { id, publicKeyPem, environments: environments as ApplyEnvironment[] };
  });
}

function validate(raw: unknown): PilotContract {
  const r = object(raw, "contract", ["schemaVersion", "enabled", "provider", "engine", "targets", "requiredApprovals", "maxApprovalAgeMinutes", "approvers", "killSwitchPath"]);
  if (r.schemaVersion !== 1) bad("schemaVersion: expected 1");
  if (r.provider !== "AZURE" || r.engine !== "TERRAFORM") bad("provider and engine: the pilot is AZURE with TERRAFORM");
  const targets = object(r.targets, "targets", ENVIRONMENTS as string[]);
  const approvals = object(r.requiredApprovals, "requiredApprovals", ENVIRONMENTS as string[]);
  if (r.enabled !== true) bad("enabled: the contract does not enable ACT");
  const contract: PilotContract = {
    schemaVersion: 1,
    enabled: true,
    provider: "AZURE",
    engine: "TERRAFORM",
    targets: { DEV: target(targets.DEV, "targets.DEV"), PROD: target(targets.PROD, "targets.PROD") },
    requiredApprovals: {
      DEV: integer(approvals.DEV, "requiredApprovals.DEV", 1, 10),
      PROD: integer(approvals.PROD, "requiredApprovals.PROD", 2, 10),
    },
    maxApprovalAgeMinutes: integer(r.maxApprovalAgeMinutes, "maxApprovalAgeMinutes", 1, 1440),
    approvers: approvers(r.approvers, "approvers"),
    killSwitchPath: text(r.killSwitchPath, "killSwitchPath", (v) => v.length > 0 && v.length <= 1024 && !v.includes("\0")),
  };
  const { DEV, PROD } = contract.targets;
  if (DEV.subscriptionId.toLowerCase() === PROD.subscriptionId.toLowerCase()) bad("targets: DEV and PROD share a subscription");
  if (DEV.backend.toLowerCase() === PROD.backend.toLowerCase()) bad("targets: DEV and PROD share a backend");
  return contract;
}

/** The identity a release names to say which pilot contract it was admitted under, and the value the pin file holds. */
export const pilotContractSha256 = (contract: PilotContract): string => sha256(canonicalJson(contract));

/** The committed pin: a lowercase SHA-256, "absent" for a missing or empty file, "malformed" for anything else. */
function readPin(pinPath: string): string | "absent" | "malformed" {
  let source: string;
  try { source = readFileSync(pinPath, "utf8").trim(); } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "malformed";
  }
  if (source === "") return "absent";
  return /^[0-9a-f]{64}$/i.test(source) ? source.toLowerCase() : "malformed";
}

/** Release admission's check: this contract is the one the committed pin names. */
export const pilotContractPinned = (contract: PilotContract, pinPath: string = repoPaths().pin): boolean =>
  readPin(pinPath) === pilotContractSha256(contract);

/** The validated, pinned contract, or a disabled result with the reason and the refusal code it maps to. Never throws. */
export function loadPilotContract(path: string = repoPaths().contract, pinPath: string = repoPaths().pin): PilotContract | DisabledContract {
  const off = (code: DisabledContract["code"], reason: string): DisabledContract => ({ enabled: false, reason, code });
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? off("ACT_DISABLED", "contract file is missing")
      : off("CONTRACT_INVALID", "contract file is unreadable");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return off("CONTRACT_INVALID", "contract could not be parsed as JSON"); }
  if ((parsed as { enabled?: unknown } | null)?.enabled === false) return off("ACT_DISABLED", "enabled: the contract does not enable ACT");
  let contract: PilotContract;
  try {
    contract = validate(parsed);
  } catch (error) {
    return off("CONTRACT_INVALID", error instanceof Invalid ? error.message : "contract is invalid");
  }
  const pin = readPin(pinPath);
  if (pin === "absent") return off("ACT_DISABLED", "the contract is not pinned: config/act-pilot-contract.sha256 is absent or empty");
  if (pin === "malformed") return off("CONTRACT_INVALID", "the contract pin file is unreadable or is not a SHA-256");
  return pin === pilotContractSha256(contract) ? contract : off("CONTRACT_INVALID", "the contract does not match its committed pin");
}

/** Active when the file exists, and when its state cannot be determined: a switch that cannot be read is not off. A relative path is under the repository root, never the working directory. */
export function isKillSwitchActive(contract: Pick<PilotContract, "killSwitchPath">): boolean {
  try {
    lstatSync(resolve(ROOT, contract.killSwitchPath));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

/**
 * The contract's own target for `env`, only when the requested target matches it
 * exactly. `account` is the Azure subscription id, so an approval that binds the
 * target binds the subscription; the tenant is bound through this lookup, because
 * the contract (pinned) names one tenant per environment.
 */
export function targetForEnvironment(
  contract: PilotContract,
  env: ApplyEnvironment,
  requested: ResolvedTarget,
): { ok: true; target: PilotTarget } | Refusal {
  const pinned = Object.hasOwn(contract.targets, env) ? contract.targets[env] : undefined;
  if (!pinned || pinned.subscriptionId !== requested?.account || pinned.backend !== requested.backend || pinned.workspace !== requested.workspace) {
    return refuse("TARGET_NOT_IN_CONTRACT", "the requested target is not the contract's " + env + " target");
  }
  return { ok: true, target: pinned };
}

/**
 * The applied-artifact ledger is the evidence directory itself: one encrypted
 * record per artifact, named by its hash and created exclusively. A record
 * existing, whatever its outcome, means the sealed plan was used. Retrying
 * needs a new preview and new approvals.
 */
export const SUFFIX = ".apply.evidence";

export function requireNotApplied(artifactSha256: string, evidenceDir: string = DEFAULT_EVIDENCE_DIR): Check {
  if (!HASH.test(artifactSha256)) return refuse("ARTIFACT_INVALID", "the artifact hash is not a SHA-256 digest");
  return existsSync(join(evidenceDir, artifactSha256 + SUFFIX))
    ? refuse("ARTIFACT_ALREADY_APPLIED", "this artifact has already been applied")
    : { ok: true };
}

/**
 * Production promotes a qualified release: it needs a successful DEV apply
 * recorded for the same target-independent releaseIdentity. A record that
 * cannot be decrypted, fails validation or sits under another artifact's name
 * is not evidence.
 */
export async function requirePromotionEvidence(
  env: ApplyEnvironment,
  releaseIdentity: string,
  evidenceDir: string = DEFAULT_EVIDENCE_DIR,
): Promise<Check> {
  if (env === "DEV") return { ok: true };
  const missing = refuse("PROMOTION_EVIDENCE_MISSING", "no successful DEV apply is recorded for this release identity");
  if (typeof releaseIdentity !== "string" || releaseIdentity.length === 0) return missing;
  let names: string[];
  try { names = await readdir(evidenceDir); } catch { return missing; }
  for (const name of names.filter((n) => n.endsWith(SUFFIX))) {
    try {
      const record = await readEncryptedEvidence<ApplyEvidence>(join(evidenceDir, name));
      if (applyEvidenceProblems(record).length === 0 && name === record.artifactSha256 + SUFFIX
        && record.environment === "DEV" && record.outcome === "SUCCEEDED" && record.releaseIdentity === releaseIdentity) {
        return { ok: true };
      }
    } catch { /* unreadable evidence is not evidence */ }
  }
  return missing;
}

/**
 * Qualification evidence lives in the vault, one encrypted file per document,
 * named by the hash of its plaintext. A QualificationRecord's `evidenceHash`
 * must name such a file: a bare hex string proves nothing.
 */
const QUALIFICATION_SUFFIX = ".qualification.evidence";

/** Validates, encrypts and stores qualification evidence. Returns the hash a QualificationRecord carries as `evidenceHash`. */
export async function writeQualificationEvidence(
  evidence: QualificationEvidence,
  vaultDir: string = repoPaths().qualifications,
): Promise<{ ok: true; evidenceHash: string } | Refusal> {
  const problems = qualificationEvidenceProblems(evidence);
  if (problems.length > 0) return refuse("EVIDENCE_REJECTED", problems.slice(0, 8).join("; "));
  const { key, info } = await ensureEvidenceKey();
  if (!info.securePermissions) return refuse("EVIDENCE_REJECTED", "the evidence key permissions are insecure");
  await mkdir(vaultDir, { recursive: true, mode: 0o700 });
  const envelope = encryptEvidence("qualification", evidence, key);
  try {
    await writeFile(join(vaultDir, envelope.plaintextSha256 + QUALIFICATION_SUFFIX), JSON.stringify(envelope) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    // The name is the plaintext hash, so an existing file is this same evidence.
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return { ok: true, evidenceHash: envelope.plaintextSha256 };
}

/** The evidence a vault file holds, or undefined: the name must be the plaintext hash, and the content must be valid qualification evidence. */
async function readQualification(vaultDir: string, hash: string): Promise<QualificationEvidence | undefined> {
  const path = join(vaultDir, hash + QUALIFICATION_SUFFIX);
  try {
    const envelope = JSON.parse(await readFile(path, "utf8")) as { plaintextSha256?: unknown };
    if (envelope?.plaintextSha256 !== hash) return undefined;
    const content = await readEncryptedEvidence<unknown>(path);
    return qualificationEvidenceProblems(content).length === 0 ? content as QualificationEvidence : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The qualification records the vault can stand behind. The CLI takes its
 * records from here and never from a file an operator names, so a record exists
 * only where valid, decryptable evidence does.
 */
export async function loadQualificationRecords(vaultDir: string = repoPaths().qualifications): Promise<QualificationRecord[]> {
  let names: string[];
  try { names = await readdir(vaultDir); } catch { return []; }
  const records: QualificationRecord[] = [];
  for (const name of names) {
    const hash = name.endsWith(QUALIFICATION_SUFFIX) ? name.slice(0, -QUALIFICATION_SUFFIX.length) : "";
    const evidence = HASH.test(hash) ? await readQualification(vaultDir, hash) : undefined;
    if (evidence) {
      records.push({
        engine: evidence.engine, adapterVersion: evidence.adapterVersion, engineVersion: evidence.engineVersion,
        argvDigest: evidence.argvDigest, qualifiedAt: evidence.qualifiedAt, evidenceHash: hash,
      });
    }
  }
  return records;
}

/**
 * The qualification gate for apply: the record's evidenceHash resolves to an
 * existing encrypted file in the vault whose plaintext hash is that hash, and
 * whose content says the real engine ran with separated backend identities for
 * exactly the adapter version, argv digest and engine version being run,
 * against the contract's DEV tenant and subscription, within the last 30 days.
 */
const QUALIFICATION_MAX_AGE_DAYS = 30;

/**
 * SHA-256 of the terraform binary a run would execute: the same lookup the
 * runner does (approved tool directories only). Undefined when there is none.
 * The same-uid operator who can replace the binary after this read is inside the
 * trust boundary (docs/act-pilot-apply.md); this refuses an honest upgrade.
 */
export function terraformBinarySha256(toolDirs: readonly string[] | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const path = resolveExecutable("terraform", toolDirs ?? approvedToolDirs(env));
  try { return path ? sha256(readFileSync(path)) : undefined; } catch { return undefined; }
}

export async function verifyApplyQualification(
  record: QualificationRecord,
  vaultDir: string,
  expected: { adapterVersion: string; argvDigest: string; engineVersion: string },
  /**
   * The contract's DEV target (tenant, subscription, backend, workspace), the clock, and what this run would use: the
   * terraform binary's hash and the normalized STATE_WRITE and APPLY client ids. Evidence is for exactly these, at most 30 days old.
   */
  bound: { dev: PilotTarget; now: Date; terraformSha256: string | undefined; stateWriteClientId: string; applyClientId: string },
): Promise<Check> {
  const deny = (why: string): Refusal => refuse("ENGINE_NOT_QUALIFIED", "the qualification record is not backed by real-engine qualification evidence: " + why);
  const hash = record?.evidenceHash;
  if (typeof hash !== "string" || !HASH.test(hash)) return deny("its evidence hash is not a SHA-256 digest");
  const evidence = await readQualification(vaultDir, hash);
  if (!evidence) return deny("no valid evidence file exists for that hash");
  for (const key of ["adapterVersion", "argvDigest", "engineVersion"] as const) {
    if (evidence[key] !== expected[key] || record[key] !== expected[key]) return deny("it was not produced for this " + key);
  }
  if (evidence.tenantId.toLowerCase() !== bound.dev.tenantId.toLowerCase() || evidence.subscriptionId.toLowerCase() !== bound.dev.subscriptionId.toLowerCase()) {
    return deny("it was not produced against the contract's DEV tenant and subscription");
  }
  if (evidence.backend !== bound.dev.backend || evidence.workspace !== bound.dev.workspace) {
    return deny("it was not produced against the contract's DEV backend and workspace");
  }
  if (bound.terraformSha256 === undefined || evidence.terraformSha256 !== bound.terraformSha256) return deny("it was not produced with this terraform binary");
  if (bound.stateWriteClientId === "" || evidence.stateWriteClientId !== bound.stateWriteClientId ||
    bound.applyClientId === "" || evidence.applyClientId !== bound.applyClientId) {
    return deny("it was not produced with these STATE_WRITE and APPLY client ids");
  }
  const age = bound.now.getTime() - Date.parse(evidence.qualifiedAt);
  if (age < 0) return deny("it is dated in the future");
  if (age > QUALIFICATION_MAX_AGE_DAYS * 86_400_000) return deny("it is older than " + QUALIFICATION_MAX_AGE_DAYS + " days");
  return { ok: true };
}
