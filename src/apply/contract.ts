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
import { ACT_OPERATIONS, type ActOperation } from "./types.js";
import type { ApplyEnvironment, ApplyEvidence, ApplyRefusalCode, ApplyResult, ApproverEntry, PilotContract, PilotTarget } from "./types.js";

/**
 * The pilot release contract (docs/act-pilot-plan.md, authority model 9). This
 * is the only place ACT is enabled for the pilot: a file the owner writes, never
 * a flag or an environment variable. Anything missing, malformed or unknown is
 * disabled, and an unknown field is refused rather than ignored.
 *
 * The contract is also the default-deny authorization: its `authorize` lists, per environment, the operations ACT may run
 * (APPLY, CLEANUP, REMOVE) for the contract's provider, engine and that environment's account. Absent or empty means
 * disabled. The contract is a tracked file and every command that seals, proposes or runs a change refuses a checkout with
 * uncommitted changes or a contract that differs from the committed file (`resolveSourceCommit`), so enabling
 * ACT, or changing a target, an operation or an approver, is a reviewed commit; the contract's hash and the authorizing
 * entry's hash are derived here and bound into the sealed plan, the approvals, the evidence and release admission. There is
 * no hash file to maintain. Every path is anchored to the repository root found from this module, never to process.cwd().
 * The same-uid operator holds the working tree and the evidence key and is inside the trust boundary; review makes a change
 * visible, it does not stop that operator.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Every location the apply path reads or writes by default. The driver and the CLI take them from here. */
export const repoPaths = () => ({
  root: ROOT,
  contract: join(ROOT, "config/act-pilot-contract.json"),
  evidence: join(ROOT, ".runs/apply/evidence"),
  qualifications: join(ROOT, ".runs/apply/qualification"),
  nonces: join(ROOT, ".runs/apply"),
});
export const DEFAULT_EVIDENCE_DIR = repoPaths().evidence;

/**
 * ACT_DISABLED: no contract, one that says enabled: false, or one that authorizes nothing. CONTRACT_INVALID: a contract is
 * present but malformed or invalid. NOT_IMPLEMENTED: a planned provider and engine whose lane has not landed.
 */
type DisabledContract = { enabled: false; reason: string; code: "ACT_DISABLED" | "CONTRACT_INVALID" | "NOT_IMPLEMENTED" };
export type Refusal = Extract<ApplyResult, { ok: false }>;
export type Check = { ok: true } | Refusal;

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });

/** Why a contract did not load, as the one refusal every entry point reports (the driver and the CLI). */
export const contractRefusal = (disabled: Pick<DisabledContract, "reason" | "code">): Refusal => refuse(disabled.code,
  disabled.code === "ACT_DISABLED"
    ? "ACT is disabled: " + disabled.reason + ". Only a valid, committed pilot contract with enabled set to true and an authorize entry enables it."
    : disabled.code === "NOT_IMPLEMENTED" ? "The pilot contract names a path that is not implemented yet (" + disabled.reason + "). ACT stays disabled."
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

/**
 * `authorize`: only environments the contract enables, each with distinct operations. Kept exactly as written (absent stays
 * absent), so a contract that never mentions it hashes as it always did, and loads as disabled.
 */
function authorizeOf(value: unknown, active: readonly ApplyEnvironment[]): PilotContract["authorize"] {
  if (value === undefined) return undefined;
  const r = object(value, "authorize", [], active);
  return Object.fromEntries(Object.entries(r).map(([env, ops]) => {
    if (!Array.isArray(ops) || ops.length === 0 || new Set(ops).size !== ops.length || !ops.every((o) => ACT_OPERATIONS.includes(o as ActOperation))) {
      bad("authorize." + env + ": expected distinct operations from " + ACT_OPERATIONS.join(", "));
    }
    return [env, [...(ops as ActOperation[])]];
  }));
}

/** A path that exists only as an admission-level id until its lane lands (six-path baseline, #39): refused NOT_IMPLEMENTED. */
const PLANNED_PATHS: readonly { provider: string; engine: string; path: string }[] = [
  { provider: "AZURE", engine: "BICEP", path: "path 4" },
  { provider: "GCP", engine: "TERRAFORM", path: "path 5" },
  { provider: "GCP", engine: "GCP_API", path: "path 6" },
];
class NotImplemented extends Invalid {}

function validate(raw: unknown): PilotContract {
  const r = object(raw, "contract", ["schemaVersion", "enabled", "provider", "engine", "targets", "requiredApprovals", "maxApprovalAgeMinutes", "approvers", "killSwitchPath"], ["embedStateWrite", "enabledEnvironments", "policyVersion", "authorize"]);
  if (r.schemaVersion !== 1) bad("schemaVersion: expected 1");
  const unsupported = "provider and engine: the pilot supports " + PROVIDER_IDS.join(", ") + " with " + ENGINE_IDS.join(", ");
  // A planned path is named and refused as NOT_IMPLEMENTED until its lane lands its provider or engine spec (six-path baseline, #39).
  const planned = PLANNED_PATHS.find((p) => p.provider === r.provider && p.engine === r.engine);
  if (planned) throw new NotImplemented("provider and engine: " + planned.provider + " " + planned.engine + " (" + planned.path + ") is a planned path that is not implemented yet");
  const spec = providerSpec(r.provider) ?? bad(unsupported);
  const engine = engineSpec(r.engine) ?? bad(unsupported);
  if (!engine.providers.includes(spec.id)) bad("engine: " + engine.id + " is valid only with " + engine.providers.join(", "));
  // DEV-only is the one narrow exception, one rule for every implemented path (six-path baseline, #39; it folds in #298's Azure
  // Terraform extension); all other subsets are rejected. No QA/PROD target can be synthesized, omitted silently or invoked under
  // this contract, and QA and PROD keep the full three-stage rules.
  const scoped = r.enabledEnvironments;
  if (scoped !== undefined && (!Array.isArray(scoped) || scoped.length !== 1 || scoped[0] !== "DEV")) {
    bad("enabledEnvironments: only the explicit DEV-only pilot is supported; omit for the legacy three-stage contract");
  }
  const active: ApplyEnvironment[] = scoped === undefined ? [...ENVIRONMENTS] : ["DEV"];
  const targets = object(r.targets, "targets", active);
  const approvals = object(r.requiredApprovals, "requiredApprovals", active);
  if (r.enabled !== true) bad("enabled: the contract does not enable ACT");
  // Optional and default off. Kept exactly as written (absent stays absent), so a contract that never mentions it hashes as it always did; the contract hash is over what the file says.
  const embed = r.embedStateWrite;
  // Same character rule as the manifest's policyVersion, so a contract value can never fail the manifest check later.
  const policy = r.policyVersion;
  if (policy !== undefined && (typeof policy !== "string" || !/^[A-Za-z0-9._:/@+=~ -]{1,256}$/.test(policy))) bad("policyVersion: expected 1 to 256 letters, digits or . _ : / @ + = ~ - and spaces");
  if (embed !== undefined && typeof embed !== "boolean") bad("embedStateWrite: expected true or false");
  const authorize = authorizeOf(r.authorize, active);
  if (embed === true && !engine.embedsStateWrite) bad("embedStateWrite: valid only with an engine that has a state backend (" + ENGINE_IDS.filter((id) => engineSpec(id)?.embedsStateWrite).join(", ") + "); " + engine.id + " has none");
  const contract: PilotContract = {
    schemaVersion: 1,
    enabled: true,
    provider: spec.id,
    engine: engine.id,
    targets: Object.fromEntries(active.map((e) => [e, target(targets[e], "targets." + e, spec, engine)])) as PilotContract["targets"],
    requiredApprovals: Object.fromEntries(active.map((e) => [e, integer(approvals[e], "requiredApprovals." + e, e === "PROD" ? 2 : 1, 10)])) as PilotContract["requiredApprovals"],
    ...(scoped !== undefined ? { enabledEnvironments: ["DEV" as const] } : {}),
    maxApprovalAgeMinutes: integer(r.maxApprovalAgeMinutes, "maxApprovalAgeMinutes", 1, 1440),
    approvers: approvers(r.approvers, "approvers"),
    killSwitchPath: text(r.killSwitchPath, "killSwitchPath", (v) => v.length > 0 && v.length <= 1024 && !v.includes("\0")),
    ...(typeof embed === "boolean" ? { embedStateWrite: embed } : {}),
    ...(typeof policy === "string" ? { policyVersion: policy } : {}),
    ...(authorize !== undefined ? { authorize } : {}),
  };
  if (scoped !== undefined && !contract.approvers.some((entry) => entry.environments.includes("DEV"))) {
    bad("approvers: DEV-only pilot requires an authorized DEV approver");
  }
  active.forEach((a, index) => {
    for (const b of active.slice(index + 1)) {
      const left = contract.targets[a]!;
      const right = contract.targets[b]!;
      if (spec.account(left).toLowerCase() === spec.account(right).toLowerCase()) bad("targets: " + a + " and " + b + " share " + (/^[aeiou]/.test(spec.accountNoun) ? "an " : "a ") + spec.accountNoun);
      if (!engine.target?.backendMayRepeat && left.backend.toLowerCase() === right.backend.toLowerCase()) bad("targets: " + a + " and " + b + " share a backend");
    }
  });
  return contract;
}

/**
 * The contract's shape checked as if it were enabled, for the read-only preflight: a person can see that an example or a
 * draft is valid before the owner commits and authorizes it. The result is never a usable contract (its authorize is not consulted) and nothing
 * here enables ACT.
 */
export function inspectPilotContract(raw: unknown): { ok: true; contract: PilotContract } | { ok: false; reason: string } {
  try {
    return { ok: true, contract: validate({ ...(raw as object), enabled: true }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Invalid ? error.message : "contract is invalid" };
  }
}

/** The identity a release, a sealed plan and its evidence name to say which pilot contract they were made under. */
export const pilotContractSha256 = (contract: PilotContract): string => sha256(canonicalJson(contract));

/**
 * The first key that appears twice in one object, at any depth, compared after JSON unescaping (so "\u0041PPLY" and "APPLY"
 * are one key), or undefined. Only called on text JSON.parse accepted, so the scan can rely on its syntax.
 */
export function duplicateKeyOf(source: string): string | undefined {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < source.length && source[j] !== "\"") j += source[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(source.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") { const top = stack[stack.length - 1]; if (top) top.expectKey = true; }
  }
  return undefined;
}

/** The validated contract when it authorizes at least one operation, or a disabled result with the reason and the refusal code it maps to. Never throws. */
export function loadPilotContract(path: string = repoPaths().contract): PilotContract | DisabledContract {
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
  // The reviewed text is the authorization, so it states each field once: JSON.parse keeps the last of two keys silently.
  const duplicate = duplicateKeyOf(source);
  if (duplicate !== undefined) return off("CONTRACT_INVALID", "duplicate key " + JSON.stringify(duplicate) + ": a reviewed contract states each field once");
  if ((parsed as { enabled?: unknown } | null)?.enabled === false) return off("ACT_DISABLED", "enabled: the contract does not enable ACT");
  let contract: PilotContract;
  try {
    contract = validate(parsed);
  } catch (error) {
    return off(error instanceof NotImplemented ? "NOT_IMPLEMENTED" : "CONTRACT_INVALID", error instanceof Invalid ? error.message : "contract is invalid");
  }
  return Object.keys(contract.authorize ?? {}).length > 0 ? contract : off("ACT_DISABLED", "the contract authorizes no environment and operation (authorize is absent or empty)");
}

/** The readable authorizing entry for one environment and its operations; its canonical hash is what approvals sign. */
export type AuthorizationEntry = { provider: PilotContract["provider"]; engine: PilotContract["engine"]; environment: ApplyEnvironment; account: string; operations: ActOperation[] };
export type Authorization = { operation: ActOperation; contractSha256: string; authorizationSha256: string; entry: AuthorizationEntry };

/** The canonical hash of an authorizing entry: what a seal, a proposal, an approval and evidence bind. */
export const authorizationSha256Of = (entry: AuthorizationEntry): string => sha256(canonicalJson(entry as never));

export function authorizationEntryOf(contract: PilotContract, env: ApplyEnvironment): AuthorizationEntry | undefined {
  const operations = contract.authorize?.[env];
  const target = Object.hasOwn(contract.targets, env) ? contract.targets[env] : undefined;
  if (!operations || !target) return undefined;
  return { provider: contract.provider, engine: contract.engine, environment: env, account: specOf(contract).account(target), operations: [...operations] };
}

/**
 * AUTHORIZED, default deny: the contract's `authorize` lists `operation` for `env`. The entry names the contract's own
 * provider, engine and account, so a TERRAFORM contract never authorizes CDK, nor the reverse. The contract's other rules
 * (DEV-only scope, targets, approvals) are judged separately and unchanged. The removal lane calls this for REMOVE.
 */
export function authorizeContract(contract: PilotContract, env: ApplyEnvironment, operation: ActOperation): { ok: true; authorization: Authorization } | Refusal {
  const entry = authorizationEntryOf(contract, env);
  if (!entry || !entry.operations.includes(operation)) {
    return refuse("ACT_NOT_AUTHORIZED", "Not AUTHORIZED: the reviewed pilot contract does not authorize " + operation + " for " + contract.provider + " " + contract.engine + " " + env +
      ". Nothing ran. Only the owner's reviewed commit of the contract's authorize entry can authorize it.");
  }
  return { ok: true, authorization: { operation, contractSha256: pilotContractSha256(contract), authorizationSha256: authorizationSha256Of(entry), entry } };
}

/**
 * The AUTHORIZED check for any operation (the removal lane's REMOVE among them): against a contract the caller already loaded, or
 * one read from a path (default the repository's). Same rule as `authorizeContract`.
 */
export function requireActAuthorized(operation: ActOperation, env: ApplyEnvironment, contract: PilotContract | string = repoPaths().contract): { ok: true; authorization: Authorization } | Refusal {
  const loaded = typeof contract === "string" ? loadPilotContract(contract) : contract;
  return "reason" in loaded ? contractRefusal(loaded) : authorizeContract(loaded, env, operation);
}

/** The contract hash and authorizing entry a seal or proposal bound are still the ones that authorize now; otherwise nothing is consumed. */
export function authorizationChanged(bound: { contractSha256: string; authorizationSha256: string }, now: Authorization): Refusal | undefined {
  return bound.contractSha256 === now.contractSha256 && bound.authorizationSha256 === now.authorizationSha256 ? undefined
    : refuse("ACT_AUTHORIZATION_CHANGED", "The reviewed contract or its authorizing entry changed since this was sealed or proposed. Nothing was consumed. " +
      "Seal (or propose) and approve it again under the current contract.");
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
 * fields are bound through this lookup, because the contract (reviewed, and bound by hash at seal) names them
 * per environment.
 */
export function targetForEnvironment(
  contract: PilotContract,
  env: ApplyEnvironment,
  requested: ResolvedTarget,
): { ok: true; target: PilotTarget } | Refusal {
  if (contract.enabledEnvironments && !contract.enabledEnvironments.includes(env)) {
    return refuse("TARGET_NOT_IN_CONTRACT", "the " + env + " environment is not enabled in this reviewed pilot contract");
  }
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
/** The cleanup ledger: one encrypted record per executed cleanup proposal, named by the proposal's hash, created exclusively. */
export const CLEANUP_SUFFIX = ".cleanup.evidence";

export function requireNotApplied(artifactSha256: string, evidenceDir: string = DEFAULT_EVIDENCE_DIR): Check {
  if (!HASH.test(artifactSha256)) return refuse("ARTIFACT_INVALID", "the artifact hash is not a SHA-256 digest");
  return existsSync(join(evidenceDir, artifactSha256 + SUFFIX))
    ? refuse("ARTIFACT_ALREADY_APPLIED", "this artifact has already been applied")
    : { ok: true };
}

/** A cleanup proposal is executed once, whatever its outcome: retrying needs a new proposal and new approvals. */
export function requireNotExecuted(proposalSha256: string, evidenceDir: string = DEFAULT_EVIDENCE_DIR): Check {
  if (!HASH.test(proposalSha256)) return refuse("PROPOSAL_INVALID", "the proposal hash is not a SHA-256 digest");
  return existsSync(join(evidenceDir, proposalSha256 + CLEANUP_SUFFIX))
    ? refuse("PROPOSAL_ALREADY_EXECUTED", "this cleanup proposal has already been executed")
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
