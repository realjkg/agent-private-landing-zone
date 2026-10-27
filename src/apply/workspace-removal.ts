import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { removeTree } from "../teardown/driver/cleanup.js";
import { isKillSwitchActive } from "./contract.js";
import { RECOVERY_FILE_NAMES } from "./engine-spec.js";
import { holdsReservation } from "./ledger.js";
import type { ApplyEnvironment, PilotContract } from "./types.js";

/**
 * Removing a run's generated working files (owner decision "Unpin the ACT decision", item 2 (b), #39; docs/act-pilot-apply.md,
 * "Removing a run's working files"). A person starts it (`./alz apply remove-workspace --sealed SEALED_PLAN`), for one run, after
 * its cleanup or whenever they no longer need the files. It deletes local files only, never a cloud resource, so it needs no approval
 * quorum: the person at the terminal, the kill switch, no run in progress and the one AUTHORIZED check (`authorizeRemoval`) gate it.
 *
 * What a run leaves locally, and what this removes:
 *  - REMOVED: the preparation files `prepare` wrote for the run's manifest (`.runs/pilot/<ENV>/request-<tag>.json`, `manifest-<tag>.json`,
 *    `preparation-<tag>.json`, and any `.partial-<pid>` copy an interrupted write left), where `<tag>` is the first 16 hex digits of the
 *    sealed plan's manifest hash.
 *  - REMOVED: scratch directories the driver left behind after a crash or a SIGKILL (`alz-preview-*`, `alz-snapshot-*`, `alz-child-*` in
 *    its scratch parent, owned by this account and older than an hour, as the stale sweep judges them). They hold the work copy with
 *    `.terraform`, the decrypted plan files and local state copies. A run that ends normally leaves none: the driver deletes its scratch
 *    directory before it returns. Their names do not say which run made them, so any stale one is removed and recorded as such.
 *  - KEPT, always: the evidence directory and everything in it (the apply and cleanup evidence, the ledger and its reservations, the
 *    sealed plan, the blueprint, observation and leftover records, the recovery record), cleanup proposals, lifecycle reports, logs,
 *    the contract and its pin, and the operator's own project folder, which the product did not generate.
 *
 * Every path is judged before anything is removed: it must sit directly in its root by real path, and neither it nor anything under it
 * may be a symbolic link (a link is refused, never followed). The plan and every file's size, and the SHA-256 of each removed plan file
 * and preparation file, go into a removal record in the evidence directory before the first removal (status IN_PROGRESS) and again after
 * the last (COMPLETE). An interrupted removal resumes from that record on the next run of the command.
 */

export type RemovalAuthorizationRequest = {
  operation: "REMOVE";
  contract: PilotContract;
  environment: ApplyEnvironment;
  artifactSha256: string;
};
export type RemovalAuthorization = { authorized: true; basis: string } | { authorized: false; reason: string };
export type RemovalAuthorizer = (request: RemovalAuthorizationRequest) => RemovalAuthorization;

/**
 * THE ONE CALL SITE for the AUTHORIZED check (owner decision, refinement: the reviewed ACT policy authorizes each operation, APPLY,
 * CLEANUP or REMOVE, per cloud, engine, target and environment). The ACT-policy lane replaces the body with its check for operation
 * REMOVE when its change lands; nothing else in this module decides authority. Until then the interim rule holds: the removal is
 * person-initiated (the CLI's typed phrase) and refused while the contract's kill switch is active.
 */
export const authorizeRemoval: RemovalAuthorizer = (request) => isKillSwitchActive(request.contract)
  ? { authorized: false, reason: "the kill switch is active" }
  : { authorized: true, basis: "INTERIM_PERSON_INITIATED: the ACT policy's REMOVE check is not wired yet; a person at the terminal started this removal and the kill switch is not active" };

export type RemovedPlan = { path: string; bytes: number; sha256: string };
export type RemovalItem = {
  path: string;
  kind: "PREPARATION_FILE" | "SCRATCH_DIRECTORY";
  bytes: number;
  files: number;
  /** A preparation file's own SHA-256; absent for a directory. */
  sha256?: string;
  /** Plan files found in a scratch directory, each with its SHA-256. */
  plans: RemovedPlan[];
  removed: boolean;
};
export type WorkspaceRemoval = {
  operatorId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "IN_PROGRESS" | "COMPLETE";
  authorization: string;
  items: RemovalItem[];
  /** Stale scratch directories kept for a person: they hold errored.tfstate or crash.log, which can be the only record of what an apply did. */
  heldForReview: string[];
};
export type WorkspaceRemovalRecord = {
  schemaVersion: 1;
  kind: "WORKSPACE_REMOVAL";
  artifactSha256: string;
  environment: ApplyEnvironment;
  /** What is never removed, said in the record so a reader does not have to infer it. */
  kept: string;
  removals: WorkspaceRemoval[];
};

export type RemovalRefusal = { ok: false; code: "REMOVAL_NOT_AUTHORIZED" | "REMOVAL_RUN_IN_PROGRESS" | "REMOVAL_PATH_REFUSED" | "REMOVAL_RECORD_INVALID" | "REMOVAL_FAILED"; message: string };
export type RemovalResult = { ok: true; record: WorkspaceRemovalRecord; recordPath: string; removal: WorkspaceRemoval; resumed: boolean } | RemovalRefusal;

export type WorkspaceRemovalInput = {
  contract: PilotContract;
  environment: ApplyEnvironment;
  artifactSha256: string;
  manifestHash: string;
  operatorId: string;
  /** `.runs/pilot` in the repository: `prepare` writes `<ENV>/request-<tag>.json` and its siblings here. */
  preparationDir: string;
  /** Where the driver creates its scratch directories (the operating system's temporary directory by default). */
  scratchParent: string;
  evidenceDir: string;
  now: Date;
  /** How old a scratch directory must be before it is judged abandoned, as the stale sweep judges it. */
  staleAfterMs?: number;
  authorize?: RemovalAuthorizer;
  /** TEST-ONLY SEAM: removes one path; a test makes it fail part-way to prove the removal resumes. */
  removePath?: (path: string) => void;
};

const KEPT = "the evidence directory and everything in it (apply and cleanup evidence, the ledger, sealed plans, run records, the recovery record), cleanup proposals, lifecycle reports, logs, the contract and its pin, and the operator's project folder";
const SCRATCH_PREFIXES = ["alz-preview-", "alz-snapshot-", "alz-child-"] as const;
const HEX = /^[0-9a-f]{64}$/;
export const REMOVAL_RECORD_SUFFIX = ".workspace-removal.json";
const refuse = (code: RemovalRefusal["code"], message: string): RemovalRefusal => ({ ok: false, code, message });
const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !rel.includes(sep) && !rel.startsWith(sep); };

class PathRefused extends Error {}

/** A real directory, by real path, that is not itself a link; undefined when it does not exist. */
function realRoot(path: string): string | undefined {
  let stat;
  try { stat = lstatSync(path); } catch { return undefined; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PathRefused(path + " is a link or not a directory");
  return realpathSync(path);
}

/** Walks a tree without following anything: counts files and bytes and hashes plan files; any link anywhere refuses the whole removal. */
function measure(path: string): { bytes: number; files: number; plans: RemovedPlan[]; recovery: boolean } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new PathRefused(path + " is a symbolic link");
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (stat.isFile()) return { bytes: stat.size, files: 1, plans: name.endsWith(".tfplan") ? [{ path, bytes: stat.size, sha256: fileSha256(path) }] : [], recovery: RECOVERY_FILE_NAMES.includes(name) };
  if (!stat.isDirectory()) throw new PathRefused(path + " is not a regular file or directory");
  const total = { bytes: 0, files: 0, plans: [] as RemovedPlan[], recovery: false };
  for (const child of readdirSync(path).sort()) {
    const sub = measure(join(path, child));
    total.bytes += sub.bytes; total.files += sub.files; total.plans.push(...sub.plans); total.recovery ||= sub.recovery;
  }
  return total;
}

/** Re-judges one planned path right before it is removed: still directly in its root by real path, and not a link. */
function stillSafe(path: string, roots: readonly string[]): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new PathRefused(path + " is a symbolic link");
  const real = realpathSync(path);
  if (!roots.some((root) => inside(root, real))) throw new PathRefused(path + " is not directly in a folder the product owns");
  if (stat.isDirectory() && measure(path).recovery) throw new PathRefused(path + " now holds errored.tfstate or crash.log, which a person reviews first");
}

/** Everything the run left that this removes, judged; throws PathRefused on any link or escape. */
function planItems(input: WorkspaceRemovalInput): { items: RemovalItem[]; roots: string[]; heldForReview: string[] } {
  const roots: string[] = [];
  const items: RemovalItem[] = [];
  const heldForReview: string[] = [];
  const evidence = existsSync(input.evidenceDir) ? realpathSync(input.evidenceDir) : undefined;
  const preparation = realRoot(join(input.preparationDir, input.environment));
  const tag = input.manifestHash.slice(0, 16);
  if (preparation !== undefined) {
    roots.push(preparation);
    const own = new RegExp("^(?:request|manifest|preparation)-" + tag + "\\.json(?:\\.partial-[0-9]+)?$");
    for (const name of readdirSync(preparation).sort()) {
      if (!own.test(name)) continue;
      const path = join(preparation, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new PathRefused(path + " is a link or not a regular file");
      items.push({ path, kind: "PREPARATION_FILE", bytes: stat.size, files: 1, sha256: fileSha256(path), plans: [], removed: false });
    }
  }
  const scratch = realRoot(input.scratchParent);
  if (scratch !== undefined) {
    roots.push(scratch);
    const owner = process.getuid?.();
    const staleAfter = input.staleAfterMs ?? 60 * 60 * 1000;
    for (const name of readdirSync(scratch).sort()) {
      if (!SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(scratch, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new PathRefused(path + " is a symbolic link");
      // Another account's directory, or one young enough to belong to a run in another terminal, is not this command's to judge.
      if (!stat.isDirectory() || (owner !== undefined && stat.uid !== owner) || input.now.getTime() - stat.mtimeMs < staleAfter) continue;
      const { recovery, ...measured } = measure(path);
      if (recovery) { heldForReview.push(path); continue; }
      items.push({ path, kind: "SCRATCH_DIRECTORY", ...measured, removed: false });
    }
  }
  for (const item of items) {
    const real = realpathSync(item.path);
    if (!roots.some((root) => inside(root, real))) throw new PathRefused(item.path + " is not directly in a folder the product owns");
    if (evidence !== undefined && (real === evidence || real.startsWith(evidence + sep))) throw new PathRefused(item.path + " is in the evidence directory, which is always kept");
  }
  return { items, roots, heldForReview };
}

/** What a removal would take, judged exactly as the removal judges it, for the person to read before typing the phrase. Writes nothing. */
export function previewWorkspaceRemoval(input: WorkspaceRemovalInput): { ok: true; items: RemovalItem[]; heldForReview: string[] } | RemovalRefusal {
  try {
    const planned = planItems(input);
    return { ok: true, items: planned.items, heldForReview: planned.heldForReview };
  } catch (error) {
    if (error instanceof PathRefused) return refuse("REMOVAL_PATH_REFUSED", "A working path is a link or lies outside the folders the product owns (" + error.message + "). Nothing was removed; a person reviews it.");
    throw error;
  }
}

function readRecord(path: string): WorkspaceRemovalRecord | undefined | "INVALID" {
  if (!existsSync(path)) return undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return "INVALID";
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkspaceRemovalRecord;
    return value?.schemaVersion === 1 && value.kind === "WORKSPACE_REMOVAL" && Array.isArray(value.removals) ? value : "INVALID";
  } catch { return "INVALID"; }
}

/** Whole-file replace: a reader sees the old record or the new one, never half of one. */
function writeRecord(path: string, record: WorkspaceRemovalRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".partial-" + process.pid;
  writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Removes one run's generated working files, or says why not. Resumes an interrupted removal from its record. Removes nothing until
 * every path has been judged and the record names them.
 */
export async function removeWorkspace(input: WorkspaceRemovalInput): Promise<RemovalResult> {
  if (!HEX.test(input.artifactSha256) || !HEX.test(input.manifestHash)) return refuse("REMOVAL_RECORD_INVALID", "The run is not named by a SHA-256 artifact and manifest hash.");
  const decision = (input.authorize ?? authorizeRemoval)({ operation: "REMOVE", contract: input.contract, environment: input.environment, artifactSha256: input.artifactSha256 });
  if (!decision.authorized) return refuse("REMOVAL_NOT_AUTHORIZED", "Removing this run's working files is not authorized: " + decision.reason + ". Nothing was removed.");
  if (await holdsReservation(input.evidenceDir)) {
    return refuse("REMOVAL_RUN_IN_PROGRESS", "An apply or cleanup is in progress (or its ledger entry cannot be read), and its working files may be in use. Nothing was removed; run this again when it has ended.");
  }
  const recordPath = join(input.evidenceDir, input.artifactSha256 + REMOVAL_RECORD_SUFFIX);
  const existing = readRecord(recordPath);
  if (existing === "INVALID") return refuse("REMOVAL_RECORD_INVALID", "The removal record " + recordPath + " cannot be read. Nothing was removed; a person reviews it.");
  if (existing !== undefined && (existing.artifactSha256 !== input.artifactSha256 || existing.environment !== input.environment)) {
    return refuse("REMOVAL_RECORD_INVALID", "The removal record names another run. Nothing was removed; a person reviews it.");
  }
  const record: WorkspaceRemovalRecord = existing ?? { schemaVersion: 1, kind: "WORKSPACE_REMOVAL", artifactSha256: input.artifactSha256, environment: input.environment, kept: KEPT, removals: [] };
  let removal = record.removals.at(-1);
  const resumed = removal?.status === "IN_PROGRESS";
  let roots: string[];
  try {
    const planned = planItems(input);
    roots = planned.roots;
    if (!resumed) {
      removal = { operatorId: input.operatorId, startedAt: input.now.toISOString(), finishedAt: null, status: "IN_PROGRESS", authorization: decision.basis, items: planned.items, heldForReview: planned.heldForReview };
      record.removals.push(removal);
    }
  } catch (error) {
    if (error instanceof PathRefused) return refuse("REMOVAL_PATH_REFUSED", "A working path is a link or lies outside the folders the product owns (" + error.message + "). Nothing was removed; a person reviews it.");
    throw error;
  }
  const current = removal!;
  writeRecord(recordPath, record);
  const remove = input.removePath ?? ((path: string) => { if (lstatSync(path).isDirectory()) removeTree(path); else rmSync(path); });
  try {
    for (const item of current.items) {
      if (item.removed) continue;
      if (!existsSync(item.path) && !isDanglingLink(item.path)) { item.removed = true; continue; }
      stillSafe(item.path, roots);
      remove(item.path);
      item.removed = true;
      writeRecord(recordPath, record);
    }
  } catch (error) {
    writeRecord(recordPath, record);
    const left = current.items.filter((item) => !item.removed).length;
    if (error instanceof PathRefused) return refuse("REMOVAL_PATH_REFUSED", "A working path changed into a link or moved out of the product's folders (" + error.message + "). " + left + " path(s) were not removed; the record says which. A person reviews them.");
    return refuse("REMOVAL_FAILED", "The removal stopped part-way (" + ((error as NodeJS.ErrnoException).code ?? "ERROR") + "). " + left + " path(s) remain; run the command again to resume from the record.");
  }
  current.status = "COMPLETE";
  current.finishedAt = input.now.toISOString();
  writeRecord(recordPath, record);
  return { ok: true, record, recordPath, removal: current, resumed };
}

function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
