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
import { ENVIRONMENTS, HASH } from "./constants.js";
import { ENGINE_IDS, engineSpec, type EngineSpec } from "./engine-spec.js";
import { applyEvidenceProblems, qualificationEvidenceProblems, type QualificationEvidence } from "./evidence.js";
import { accountFieldsOf, PROVIDER_IDS, providerSpec, specOf, type ProviderSpec } from "./provider.js";
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

function object(value: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad(path + ": expected an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) bad(path + "." + key + ": unknown field");
  for (const key of keys) if (!Object.hasOwn(record, key)) bad(path + "." + key + ": missing");
  return record;
}

const text = (value: unknown, path: string, ok: (v: string) => boolean): string =>
  typeof value === "string" && ok(value) ? value : bad(path + ": invalid");

const integer = (value: unknown, path: string, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : bad(path + ": expected an integer from " + min + " to " + max);

/** A target in the contract's provider's shape: its account fields, then the backend and the workspace, and the engine's own fields (CDK: the capabilities it may use). */
function target(value: unknown, path: string, spec: ProviderSpec, engine: EngineSpec): PilotTarget {
  const fields = Object.entries(spec.accountFields);
  const extra = Object.entries(engine.target?.fields ?? {});
  const r = object(value, path, [...fields.map(([name]) => name), "backend", "workspace", ...extra.map(([name]) => name)]);
  const flag = (name: string, ok: (v: unknown) => boolean): unknown => ok(r[name]) ? r[name] : bad(path + "." + name + ": invalid");
  return {
    ...Object.fromEntries(fields.map(([name, ok]) => [name, text(r[name], path + "." + name, ok)])),
    backend: text(r.backend, path + ".backend", engine.target?.backendOk ?? spec.backendOk),
    workspace: text(r.workspace, path + ".workspace", engine.target?.workspaceOk ?? ((v) => WORKSPACE.test(v))),
    ...Object.fromEntries(extra.map(([name, ok]) => [name, flag(name, ok)])),
  } as PilotTarget;
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
      bad(p + ".environments: expected distinct DEV, QA and PROD values");
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
  const r = object(raw, "contract", ["schemaVersion", "enabled", "provider", "engine", "targets", "requiredApprovals", "maxApprovalAgeMinutes", "approvers", "killSwitchPath"], ["embedStateWrite"]);
  if (r.schemaVersion !== 1) bad("schemaVersion: expected 1");
  const unsupported = "provider and engine: the pilot supports " + PROVIDER_IDS.join(", ") + " with " + ENGINE_IDS.join(", ");
  const spec = providerSpec(r.provider) ?? bad(unsupported);
  const engine = engineSpec(r.engine) ?? bad(unsupported);
  if (!engine.providers.includes(spec.id)) bad("engine: " + engine.id + " is valid only with " + engine.providers.join(", "));
  const targets = object(r.targets, "targets", ENVIRONMENTS as string[]);
  const approvals = object(r.requiredApprovals, "requiredApprovals", ENVIRONMENTS as string[]);
  if (r.enabled !== true) bad("enabled: the contract does not enable ACT");
  // Optional and default off. Kept exactly as written (absent stays absent), so a contract that never mentions it hashes as it always did; the pin is over what the file says.
  const embed = r.embedStateWrite;
  if (embed !== undefined && typeof embed !== "boolean") bad("embedStateWrite: expected true or false");
  if (embed === true && !engine.embedsStateWrite) bad("embedStateWrite: valid only with an engine that has a state backend (" + ENGINE_IDS.filter((id) => engineSpec(id)?.embedsStateWrite).join(", ") + "); " + engine.id + " has none");
  const contract: PilotContract = {
    schemaVersion: 1,
    enabled: true,
    provider: spec.id,
    engine: engine.id,
    targets: ENVIRONMENTS.reduce((all, e) => ({ ...all, [e]: target(targets[e], "targets." + e, spec, engine) }), {} as PilotContract["targets"]),
    requiredApprovals: {
      DEV: integer(approvals.DEV, "requiredApprovals.DEV", 1, 10),
      QA: integer(approvals.QA, "requiredApprovals.QA", 1, 10),
      PROD: integer(approvals.PROD, "requiredApprovals.PROD", 2, 10),
    },
    maxApprovalAgeMinutes: integer(r.maxApprovalAgeMinutes, "maxApprovalAgeMinutes", 1, 1440),
    approvers: approvers(r.approvers, "approvers"),
    killSwitchPath: text(r.killSwitchPath, "killSwitchPath", (v) => v.length > 0 && v.length <= 1024 && !v.includes("\0")),
    ...(typeof embed === "boolean" ? { embedStateWrite: embed } : {}),
  };
  ENVIRONMENTS.forEach((a, index) => {
    for (const b of ENVIRONMENTS.slice(index + 1)) {
      if (spec.account(contract.targets[a]).toLowerCase() === spec.account(contract.targets[b]).toLowerCase()) bad("targets: " + a + " and " + b + " share " + (/^[aeiou]/.test(spec.accountNoun) ? "an " : "a ") + spec.accountNoun);
      if (!engine.target?.backendMayRepeat && contract.targets[a].backend.toLowerCase() === contract.targets[b].backend.toLowerCase()) bad("targets: " + a + " and " + b + " share a backend");
    }
  });
  return contract;
}

/**
 * The contract's shape checked as if it were enabled, for the read-only preflight: a person can see that an example or a
 * draft is valid before anyone pins or enables it. The result is never a usable contract (it is not pinned) and nothing
 * here enables ACT.
 */
export function inspectPilotContract(raw: unknown): { ok: true; contract: PilotContract } | { ok: false; reason: string } {
  try {
    return { ok: true, contract: validate({ ...(raw as object), enabled: true }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Invalid ? error.message : "contract is invalid" };
  }
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
 * exactly. `account` is the provider's account identifier (`ProviderSpec.account`),
 * so an approval that binds the target binds the account; the rest of the account
 * fields are bound through this lookup, because the contract (pinned) names them
 * per environment.
 */
export function targetForEnvironment(
  contract: PilotContract,
  env: ApplyEnvironment,
  requested: ResolvedTarget,
): { ok: true; target: PilotTarget } | Refusal {
  const pinned = Object.hasOwn(contract.targets, env) ? contract.targets[env] : undefined;
  if (!pinned || specOf(contract).account(pinned) !== requested?.account || pinned.backend !== requested.backend || pinned.workspace !== requested.workspace) {
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

/** The stage whose successful apply a stage promotes from. DEV promotes from nothing. */
const PROMOTES_FROM: Partial<Record<ApplyEnvironment, ApplyEnvironment>> = { QA: "DEV", PROD: "QA" };

/**
 * Promotion runs DEV, then QA, then PROD. QA needs a successful DEV apply and PROD
 * a successful QA apply (never DEV alone), each recorded for the same
 * target-independent releaseIdentity. DEV needs none. A record that
 * cannot be decrypted, fails validation or sits under another artifact's name
 * is not evidence.
 */
export async function requirePromotionEvidence(
  env: ApplyEnvironment,
  releaseIdentity: string,
  evidenceDir: string = DEFAULT_EVIDENCE_DIR,
): Promise<Check> {
  const from = PROMOTES_FROM[env];
  if (from === undefined) return env === "DEV" ? { ok: true } : refuse("PROMOTION_EVIDENCE_MISSING", "unknown environment");
  const missing = refuse("PROMOTION_EVIDENCE_MISSING", "no successful " + from + " apply is recorded for this release identity");
  if (typeof releaseIdentity !== "string" || releaseIdentity.length === 0) return missing;
  let names: string[];
  try { names = await readdir(evidenceDir); } catch { return missing; }
  for (const name of names.filter((n) => n.endsWith(SUFFIX))) {
    try {
      const record = await readEncryptedEvidence<ApplyEvidence>(join(evidenceDir, name));
      if (applyEvidenceProblems(record).length === 0 && name === record.artifactSha256 + SUFFIX
        && record.environment === from && record.outcome === "SUCCEEDED" && record.releaseIdentity === releaseIdentity) {
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
  spec: ProviderSpec,
  vaultDir: string = repoPaths().qualifications,
): Promise<{ ok: true; evidenceHash: string } | Refusal> {
  const problems = qualificationEvidenceProblems(evidence, spec);
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
async function readQualification(vaultDir: string, hash: string, spec: ProviderSpec): Promise<QualificationEvidence | undefined> {
  const path = join(vaultDir, hash + QUALIFICATION_SUFFIX);
  try {
    const envelope = JSON.parse(await readFile(path, "utf8")) as { plaintextSha256?: unknown };
    if (envelope?.plaintextSha256 !== hash) return undefined;
    const content = await readEncryptedEvidence<unknown>(path);
    return qualificationEvidenceProblems(content, spec).length === 0 ? content as QualificationEvidence : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The qualification records the vault can stand behind. The CLI takes its
 * records from here and never from a file an operator names, so a record exists
 * only where valid, decryptable evidence does.
 */
export async function loadQualificationRecords(spec: ProviderSpec, vaultDir: string = repoPaths().qualifications): Promise<QualificationRecord[]> {
  let names: string[];
  try { names = await readdir(vaultDir); } catch { return []; }
  const records: QualificationRecord[] = [];
  for (const name of names) {
    const hash = name.endsWith(QUALIFICATION_SUFFIX) ? name.slice(0, -QUALIFICATION_SUFFIX.length) : "";
    const evidence = HASH.test(hash) ? await readQualification(vaultDir, hash, spec) : undefined;
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
 * against the contract's DEV account (the provider's account fields), within the last 30 days.
 */
const QUALIFICATION_MAX_AGE_DAYS = 30;

export async function verifyApplyQualification(
  record: QualificationRecord,
  vaultDir: string,
  expected: { adapterVersion: string; argvDigest: string; engineVersion: string },
  /**
   * The contract's DEV target (account fields, backend, workspace), the clock, and what this run would use: the
   * engine binary's hash (`terraformSha256`, the aws CLI's for CDK) and the normalized client ids of the two attested principals (not compared for a QA or PROD run when each environment
   * brings its own principals, `ProviderSpec.principalPerEnvironment`). Evidence is for exactly these, at most 30 days old.
   */
  bound: { dev: PilotTarget; now: Date; terraformSha256: string | undefined; stateWriteClientId: string; applyClientId: string; principalsPerEnvironment?: boolean },
  spec: ProviderSpec,
): Promise<Check> {
  const deny = (why: string): Refusal => refuse("ENGINE_NOT_QUALIFIED", "the qualification record is not backed by real-engine qualification evidence: " + why);
  const hash = record?.evidenceHash;
  if (typeof hash !== "string" || !HASH.test(hash)) return deny("its evidence hash is not a SHA-256 digest");
  const evidence = await readQualification(vaultDir, hash, spec);
  if (!evidence) return deny("no valid evidence file exists for that hash");
  for (const key of ["adapterVersion", "argvDigest", "engineVersion"] as const) {
    if (evidence[key] !== expected[key] || record[key] !== expected[key]) return deny("it was not produced for this " + key);
  }
  const account: Record<string, string> = accountFieldsOf(spec, bound.dev);
  if (Object.entries(account).some(([field, value]) => String((evidence as Record<string, unknown>)[field]).toLowerCase() !== String(value).toLowerCase())) {
    return deny("it was not produced against the contract's DEV " + spec.targetNoun);
  }
  if (evidence.backend !== bound.dev.backend || evidence.workspace !== bound.dev.workspace) {
    return deny("it was not produced against the contract's DEV backend and workspace");
  }
  if (bound.terraformSha256 === undefined || evidence.terraformSha256 !== bound.terraformSha256) return deny("it was not produced with this engine binary");
  if (!bound.principalsPerEnvironment && (bound.stateWriteClientId === "" || evidence.stateWriteClientId !== bound.stateWriteClientId ||
    bound.applyClientId === "" || evidence.applyClientId !== bound.applyClientId)) {
    return deny("it was not produced with these attested client ids");
  }
  const age = bound.now.getTime() - Date.parse(evidence.qualifiedAt);
  if (age < 0) return deny("it is dated in the future");
  if (age > QUALIFICATION_MAX_AGE_DAYS * 86_400_000) return deny("it is older than " + QUALIFICATION_MAX_AGE_DAYS + " days");
  return { ok: true };
}
