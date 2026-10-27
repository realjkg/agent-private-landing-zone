import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { removeTree } from "../teardown/driver/cleanup.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import { canonicalJson } from "../teardown/manifest.js";
import { consumeApprovals, signRequest, verifyApprovalSet, verifyRequestSignature } from "./approval.js";
import { ENVIRONMENTS, HASH } from "./constants.js";
import { isKillSwitchActive, pilotContractSha256, requireActAuthorized, targetForEnvironment } from "./contract.js";
import { RECOVERY_FILE_NAMES } from "./engine-spec.js";
import { holdsReservation } from "./ledger.js";
import type { NonceStore } from "./nonces.js";
import { REQUESTER_ID, wellFormedRequest } from "./seal.js";
import { PILOT_CHANNELS, type ApplyEnvironment, type PilotChannel, type PilotContract, type SealedRequest, type SignedApproval } from "./types.js";

/**
 * Removing a run's generated working files (owner decision 6443062568 "Unpin the ACT decision", item 2 (b), #39; docs/act-pilot-apply.md,
 * "Removing a run's working files"). Removals go through the same proposal, approval quorum and kill-switch path as cleanup:
 *
 *  1. `propose-removal`: the planner below lists exactly what this run left; the requester (an allowlisted id with that entry's own key)
 *     signs the proposal's hash under the cleanup request domain, and the proposal's hash binds the run, the target, the contract and the list.
 *  2. `approve`: each approver signs the proposal's hash under the cleanup approval domain, with the cleanup quorum for the environment
 *     (in PROD two distinct approvers, neither the requester), through the same checks as a cleanup (src/apply/approval.ts).
 *  3. `remove-workspace`: the requester signature and the approvals are verified, the kill switch and the one AUTHORIZED check
 *     (`authorizeRemoval`) pass, no run is in progress, the run is planned again FROM SCRATCH, and only an item the fresh plan produces
 *     AND the signed proposal lists (and, on a resumed removal, the record lists) is deleted. The person types a phrase over exactly that
 *     list. The approvals are consumed, then the items go one at a time, with the kill switch read again before each.
 *
 * A removal record never widens what is deleted: it can only narrow a resumed removal. An item the fresh plan does not produce (a file
 * that is not this run's, a directory that is not the driver's, another account's, a young one, a link) is never deleted, whatever the
 * proposal or the record says.
 *
 * What a run leaves locally, and what this removes:
 *  - REMOVED: the preparation files `prepare` wrote for the run's manifest (`.runs/pilot/<ENV>/request-<tag>.json`, `manifest-<tag>.json`,
 *    `preparation-<tag>.json`, and any `.partial-<pid>` copy an interrupted write left), where `<tag>` is the first 16 hex digits of the
 *    sealed plan's manifest hash.
 *  - REMOVED: scratch directories the driver left behind after a crash or a SIGKILL (`alz-preview-*`, `alz-snapshot-*`, `alz-child-*` in
 *    its scratch parent, owned by this account and older than an hour, as the stale sweep judges them). They hold the work copy with
 *    `.terraform`, the decrypted plan files and local state copies. Their names do not say which run made them.
 *  - KEPT, always: the evidence directory and everything in it, cleanup and removal proposals, lifecycle reports, logs, the contract,
 *    and the operator's own project folder. A stale scratch directory holding errored.tfstate or crash.log is held for review.
 *  - SKIPPED and reported, never followed or deleted: a link, or a directory with a link anywhere inside it (a planted entry, a plugin
 *    cache link under `.terraform`), and anything another account owns. Such an entry never blocks the rest of the removal.
 */

export type RemovalAuthorizationRequest = { operation: "REMOVE"; contract: PilotContract; environment: ApplyEnvironment; artifactSha256: string };
export type RemovalAuthorization = { authorized: true; basis: string } | { authorized: false; reason: string };

/**
 * THE ONE CALL SITE for the AUTHORIZED check (owner decisions, #39: the reviewed contract's `authorize` entry authorizes each
 * operation, APPLY, CLEANUP or REMOVE). Refused unless the contract lists REMOVE for the environment (`requireActAuthorized`), and
 * while the contract's kill switch is active; nothing else in this module decides authority. The approval quorum and the requester
 * signature are checked separately, by the cleanup machinery, in `removeWorkspace`.
 */
export function authorizeRemoval(request: RemovalAuthorizationRequest): RemovalAuthorization {
  const authorized = requireActAuthorized(request.operation, request.environment, request.contract);
  if (!authorized.ok) return { authorized: false, reason: authorized.message };
  if (isKillSwitchActive(request.contract)) return { authorized: false, reason: "the kill switch is active" };
  const { contractSha256, authorizationSha256 } = authorized.authorization;
  return { authorized: true, basis: "AUTHORIZED: REMOVE in " + request.environment + " by contract " + contractSha256.slice(0, 12) + ", entry " + authorizationSha256.slice(0, 12) + "; the kill switch is not active" };
}

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
};
export type SkippedEntry = { path: string; reason: string };
export type RemovalPlan = { items: RemovalItem[]; heldForReview: string[]; skipped: SkippedEntry[] };

/** The removal proposal: what approvers sign, under the cleanup domain, by its hash. */
export type WorkspaceRemovalProposal = {
  schemaVersion: 1;
  kind: "WORKSPACE_REMOVAL_PROPOSAL";
  proposalSha256: string;
  artifactSha256: string;
  manifestHash: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  channel: PilotChannel;
  contractSha256: string;
  createdAt: string;
  items: RemovalItem[];
  heldForReview: string[];
  skipped: SkippedEntry[];
  requesterId: string;
  /** The requester's signature over the proposal's hash (cleanup request domain); null only while it is built. */
  request: SealedRequest | null;
  authorization: { operation: "REMOVE"; subject: "CLEANUP"; requiredApprovals: number };
};

export type RemovalRecordItem = RemovalItem & { removed: boolean };
export type WorkspaceRemoval = {
  proposalSha256: string;
  operatorId: string;
  approvers: string[];
  startedAt: string;
  finishedAt: string | null;
  status: "IN_PROGRESS" | "COMPLETE" | "STOPPED";
  authorization: string;
  items: RemovalRecordItem[];
  heldForReview: string[];
  skipped: SkippedEntry[];
};
export type WorkspaceRemovalRecord = {
  schemaVersion: 1;
  kind: "WORKSPACE_REMOVAL";
  artifactSha256: string;
  environment: ApplyEnvironment;
  kept: string;
  removals: WorkspaceRemoval[];
};

export type RemovalRefusal = { ok: false; code: string; message: string };
export type RemovalResult = { ok: true; record: WorkspaceRemovalRecord; recordPath: string; removal: WorkspaceRemoval; resumed: boolean } | RemovalRefusal;

/** Where a run's working files are: the folders the product owns, and how stale a scratch directory must be. */
export type RemovalLocations = {
  /** `.runs/pilot` in the repository: `prepare` writes `<ENV>/request-<tag>.json` and its siblings here. */
  preparationDir: string;
  /** Where the driver creates its scratch directories (the operating system's temporary directory by default). */
  scratchParent: string;
  evidenceDir: string;
  /** How old a scratch directory must be before it is judged abandoned (one hour, as the stale sweep judges it). */
  staleAfterMs?: number;
};
/** The run, from its sealed plan. */
export type RemovalRun = { artifactSha256: string; manifestHash: string; environment: ApplyEnvironment; target: ResolvedTarget; channel: PilotChannel };

const KEPT = "the evidence directory and everything in it (apply and cleanup evidence, the ledger, sealed plans, run records, the recovery record), cleanup and removal proposals, lifecycle reports, logs, the contract, and the operator's project folder";
const SCRATCH_PREFIXES = ["alz-preview-", "alz-snapshot-", "alz-child-"] as const;
export const REMOVAL_RECORD_SUFFIX = ".workspace-removal.json";
/** The refusals that come after the approvals were consumed: the approvals are spent, and the record says what remains. */
export const REMOVAL_SPENT_CODES: readonly string[] = ["REMOVAL_RECORD_CHANGED", "REMOVAL_STOPPED", "REMOVAL_PATH_CHANGED", "REMOVAL_FAILED"];
const refuse = (code: string, message: string): RemovalRefusal => ({ ok: false, code, message });
const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const directlyIn = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !rel.includes(sep); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class PathRefused extends Error {}

/** A root folder by real path, not itself a link; undefined when it does not exist. A linked root is refused: the product's own folder was replaced. */
function realRoot(path: string): string | undefined {
  let stat;
  try { stat = lstatSync(path); } catch { return undefined; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PathRefused(path + " is a link or not a directory");
  return realpathSync(path);
}

/** Walks a tree without following anything: counts files and bytes, hashes plan files, and says whether it holds a link or a recovery file. */
function measure(path: string): { bytes: number; files: number; plans: RemovedPlan[]; recovery: boolean; link: boolean } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0, plans: [], recovery: false, link: true };
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (stat.isFile()) return { bytes: stat.size, files: 1, plans: name.endsWith(".tfplan") ? [{ path, bytes: stat.size, sha256: fileSha256(path) }] : [], recovery: RECOVERY_FILE_NAMES.includes(name), link: false };
  if (!stat.isDirectory()) return { bytes: 0, files: 0, plans: [], recovery: false, link: true };
  const total = { bytes: 0, files: 0, plans: [] as RemovedPlan[], recovery: false, link: false };
  for (const child of readdirSync(path).sort()) {
    const sub = measure(join(path, child));
    total.bytes += sub.bytes; total.files += sub.files; total.plans.push(...sub.plans); total.recovery ||= sub.recovery; total.link ||= sub.link;
  }
  return total;
}

/**
 * The one planner: everything this run left that may be removed, judged from the disk as it is now. Filters come before any link
 * judgment, so an entry that is not this run's file and not the driver's own stale directory is never even looked into: another
 * account's entry, a young one or a non-`alz-` name is ignored, and a link or a tree holding one is skipped and reported, never followed.
 */
export function planWorkspaceRemoval(run: Pick<RemovalRun, "environment" | "manifestHash">, where: RemovalLocations, now: Date): { ok: true; plan: RemovalPlan } | RemovalRefusal {
  try {
    const items: RemovalItem[] = [];
    const heldForReview: string[] = [];
    const skipped: SkippedEntry[] = [];
    const owner = process.getuid?.();
    const evidence = existsSync(where.evidenceDir) ? realpathSync(where.evidenceDir) : undefined;
    const preparation = realRoot(join(where.preparationDir, run.environment));
    const tag = run.manifestHash.slice(0, 16);
    if (preparation !== undefined) {
      const own = new RegExp("^(?:request|manifest|preparation)-" + tag + "\\.json(?:\\.partial-[0-9]+)?$");
      for (const name of readdirSync(preparation).sort()) {
        if (!own.test(name)) continue;
        const path = join(preparation, name);
        const stat = lstatSync(path);
        if (owner !== undefined && stat.uid !== owner) { skipped.push({ path, reason: "owned by another account" }); continue; }
        if (stat.isSymbolicLink() || !stat.isFile()) { skipped.push({ path, reason: "a link or not a regular file; never followed" }); continue; }
        items.push({ path, kind: "PREPARATION_FILE", bytes: stat.size, files: 1, sha256: fileSha256(path), plans: [] });
      }
    }
    const scratch = realRoot(where.scratchParent);
    if (scratch !== undefined) {
      const staleAfter = where.staleAfterMs ?? 60 * 60 * 1000;
      for (const name of readdirSync(scratch).sort()) {
        if (!SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        const path = join(scratch, name);
        const stat = lstatSync(path);
        // Another account's entry (a planted one in a shared temporary directory) is not this command's: ignored before anything else.
        if (owner !== undefined && stat.uid !== owner) continue;
        if (stat.isSymbolicLink()) { skipped.push({ path, reason: "a link; never followed" }); continue; }
        if (!stat.isDirectory() || now.getTime() - stat.mtimeMs < staleAfter) continue;
        const { recovery, link, ...measured } = measure(path);
        if (link) { skipped.push({ path, reason: "holds a link (a plugin cache link under .terraform, or a planted one); never followed, left for a person" }); continue; }
        if (recovery) { heldForReview.push(path); continue; }
        items.push({ path, kind: "SCRATCH_DIRECTORY", ...measured });
      }
    }
    const roots = [preparation, scratch].filter((root): root is string => root !== undefined);
    for (const item of items) {
      const real = realpathSync(item.path);
      if (!roots.some((root) => directlyIn(root, real))) throw new PathRefused(item.path + " is not directly in a folder the product owns");
      if (evidence !== undefined && (real === evidence || real.startsWith(evidence + sep))) throw new PathRefused(item.path + " is in the evidence directory, which is always kept");
    }
    return { ok: true, plan: { items, heldForReview, skipped } };
  } catch (error) {
    if (error instanceof PathRefused) return refuse("REMOVAL_PATH_REFUSED", "A folder the product owns is a link or a working path lies outside it (" + error.message + "). Nothing was removed; a person reviews it.");
    throw error;
  }
}

// --- the proposal -------------------------------------------------------------------------------------------------------------

const PROPOSAL_KEYS = ["schemaVersion", "kind", "proposalSha256", "artifactSha256", "manifestHash", "environment", "target", "channel", "contractSha256", "createdAt", "items", "heldForReview", "skipped", "requesterId", "request", "authorization"];

/** The proposal's identity: every field but itself and the requester's signature, canonically. */
export function removalProposalSha256(proposal: Omit<WorkspaceRemovalProposal, "proposalSha256"> | WorkspaceRemovalProposal): string {
  const { proposalSha256: _self, request: _signature, ...rest } = proposal as WorkspaceRemovalProposal;
  return createHash("sha256").update(canonicalJson(rest as never)).digest("hex");
}

/** Builds the proposal from a fresh plan of the run. Signs nothing; `signRemovalProposal` adds the requester's signature. */
export function buildRemovalProposal(input: { run: RemovalRun; where: RemovalLocations; contract: PilotContract; requesterId: string; now: Date }): { ok: true; proposal: WorkspaceRemovalProposal } | RemovalRefusal {
  const { run, contract } = input;
  const required = contract.requiredApprovals[run.environment];
  if (required === undefined) return refuse("TARGET_NOT_IN_CONTRACT", "The pilot contract does not enable " + run.environment + ".");
  const planned = planWorkspaceRemoval(run, input.where, input.now);
  if (!planned.ok) return planned;
  const fields: Omit<WorkspaceRemovalProposal, "proposalSha256"> = {
    schemaVersion: 1, kind: "WORKSPACE_REMOVAL_PROPOSAL", artifactSha256: run.artifactSha256, manifestHash: run.manifestHash, environment: run.environment, target: { ...run.target },
    channel: run.channel, contractSha256: pilotContractSha256(contract), createdAt: input.now.toISOString(), ...planned.plan, requesterId: input.requesterId, request: null,
    authorization: { operation: "REMOVE", subject: "CLEANUP", requiredApprovals: required },
  };
  return { ok: true, proposal: { ...fields, proposalSha256: removalProposalSha256(fields) } };
}

/** The requester's signature, under the cleanup request domain: the same check a cleanup's requester passes. */
export function signRemovalProposal(proposal: WorkspaceRemovalProposal, privateKeyPem: string): WorkspaceRemovalProposal {
  return { ...proposal, request: signRequest({ schemaVersion: 1, requesterId: proposal.requesterId, artifactSha256: proposal.proposalSha256, environment: proposal.environment, nonce: randomBytes(16).toString("hex") }, privateKeyPem, "CLEANUP_REQUEST") };
}

const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const itemOk = (x: unknown): x is RemovalItem => isRecord(x) && text(x.path) && (x.kind === "PREPARATION_FILE" || x.kind === "SCRATCH_DIRECTORY") && Number.isInteger(x.bytes) && Number.isInteger(x.files) &&
  (x.sha256 === undefined || (typeof x.sha256 === "string" && HASH.test(x.sha256))) && Array.isArray(x.plans) &&
  x.plans.every((p) => isRecord(p) && text(p.path) && Number.isInteger(p.bytes) && typeof p.sha256 === "string" && HASH.test(p.sha256));
const skippedOk = (x: unknown): boolean => isRecord(x) && text(x.path) && text(x.reason, 512);

/** Proves a removal proposal is well formed, hashes to its own identity and carries a requester signature over that hash. */
export function verifyRemovalProposal(value: unknown): { ok: true; proposal: WorkspaceRemovalProposal } | RemovalRefusal {
  const bad = (why: string) => refuse("PROPOSAL_INVALID", "The removal proposal is malformed: " + why + ". Propose the removal again.");
  if (!isRecord(value)) return bad("not an object");
  if (Object.keys(value).sort().join() !== [...PROPOSAL_KEYS].sort().join()) return bad("its fields are not a removal proposal's");
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 1 || p.kind !== "WORKSPACE_REMOVAL_PROPOSAL") return bad("not a schemaVersion 1 WORKSPACE_REMOVAL_PROPOSAL");
  if (![p.proposalSha256, p.artifactSha256, p.manifestHash, p.contractSha256].every((h) => typeof h === "string" && HASH.test(h))) return bad("a hash is not a SHA-256 digest");
  if (!ENVIRONMENTS.includes(p.environment as ApplyEnvironment) || !PILOT_CHANNELS.includes(p.channel as PilotChannel)) return bad("environment or channel is unknown");
  const target = p.target;
  if (!isRecord(target) || Object.keys(target).sort().join() !== "account,backend,workspace" || !["account", "backend", "workspace"].every((k) => text(target[k], 512))) return bad("target");
  if (!text(p.createdAt, 64) || Number.isNaN(Date.parse(p.createdAt))) return bad("createdAt");
  if (!Array.isArray(p.items) || !p.items.every(itemOk) || !Array.isArray(p.heldForReview) || !p.heldForReview.every((x) => text(x)) || !Array.isArray(p.skipped) || !p.skipped.every(skippedOk)) return bad("the item lists");
  if (typeof p.requesterId !== "string" || !REQUESTER_ID.test(p.requesterId) || !wellFormedRequest(p.request)) return bad("the requester or the requester's signature");
  const a = p.authorization;
  if (!isRecord(a) || Object.keys(a).sort().join() !== "operation,requiredApprovals,subject" || a.operation !== "REMOVE" || a.subject !== "CLEANUP" || !Number.isInteger(a.requiredApprovals) || (a.requiredApprovals as number) < 1) return bad("authorization");
  const proposal = value as WorkspaceRemovalProposal;
  if (removalProposalSha256(proposal) !== proposal.proposalSha256) return refuse("PROPOSAL_INVALID", "The removal proposal does not match its own hash; it was altered after it was made. Propose the removal again.");
  const s = (proposal.request as SealedRequest).statement;
  if (s.artifactSha256 !== proposal.proposalSha256 || s.environment !== proposal.environment || s.requesterId !== proposal.requesterId) {
    return refuse("PROPOSAL_INVALID", "The removal proposal's requester signature names another proposal, environment or requester. Propose the removal again.");
  }
  return { ok: true, proposal };
}

// --- the record ---------------------------------------------------------------------------------------------------------------

/** Undefined when there is none; INVALID for anything that is not exactly a removal record of this run (never a TypeError). */
function readRecord(path: string, run: RemovalRun): WorkspaceRemovalRecord | undefined | "INVALID" {
  let stat;
  try { stat = lstatSync(path); } catch { return undefined; }
  if (stat.isSymbolicLink() || !stat.isFile()) return "INVALID";
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return "INVALID"; }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "WORKSPACE_REMOVAL" || value.artifactSha256 !== run.artifactSha256 || value.environment !== run.environment ||
    typeof value.kept !== "string" || !Array.isArray(value.removals)) return "INVALID";
  const removalOk = (r: unknown): boolean => isRecord(r) && typeof r.proposalSha256 === "string" && HASH.test(r.proposalSha256) && ["IN_PROGRESS", "COMPLETE", "STOPPED"].includes(r.status as string) &&
    Array.isArray(r.items) && r.items.every((i) => itemOk(i) && typeof (i as { removed?: unknown }).removed === "boolean") && Array.isArray(r.approvers) && Array.isArray(r.heldForReview) && Array.isArray(r.skipped);
  return value.removals.every(removalOk) ? value as WorkspaceRemovalRecord : "INVALID";
}

/** Whole-file replace: a reader sees the old record or the new one, never half of one. */
function writeRecord(path: string, record: WorkspaceRemovalRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".partial-" + process.pid;
  writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

// --- the removal --------------------------------------------------------------------------------------------------------------

export type RemovalInput = {
  proposal: unknown;
  approvals: SignedApproval[];
  run: RemovalRun;
  contract: PilotContract;
  where: RemovalLocations;
  nonces: NonceStore;
  operatorId: string;
  now: Date;
};
/** TEST-ONLY SEAMS: function parameters only, never reachable from the command line, a file or the environment. */
export type RemovalTestSeams = { removePath?: (path: string) => void };

export type RemovalReady = { ok: true; proposal: WorkspaceRemovalProposal; approvers: string[]; requesterId: string; deletes: RemovalItem[]; resumed: boolean; recordPath: string; plan: RemovalPlan };

/** Same file, same content: a preparation file by its hash; a scratch directory by its path (its contents are measured again and recorded). */
const sameItem = (a: RemovalItem, b: RemovalItem): boolean => a.path === b.path && a.kind === b.kind && (a.kind === "SCRATCH_DIRECTORY" || a.sha256 === b.sha256);

/**
 * Every gate short of consuming the approvals, and the exact list that would be deleted: the fresh plan, narrowed to what the signed
 * proposal lists and, when an interrupted removal of the same proposal is resumed, to what its record lists. Writes and consumes
 * nothing. The CLI shows this list for the typed phrase, and `removeWorkspace` refuses if the list it computes again differs.
 */
export async function prepareRemoval(input: RemovalInput): Promise<RemovalReady | RemovalRefusal> {
  const opened = verifyRemovalProposal(input.proposal);
  if (!opened.ok) return opened;
  const { proposal } = opened;
  const { run, contract } = input;
  if (proposal.artifactSha256 !== run.artifactSha256 || proposal.manifestHash !== run.manifestHash || proposal.environment !== run.environment || proposal.channel !== run.channel) {
    return refuse("PROPOSAL_INVALID", "The removal proposal is not for this sealed plan's run or channel. Nothing was removed.");
  }
  if (proposal.contractSha256 !== pilotContractSha256(contract)) return refuse("PROPOSAL_INVALID", "The removal proposal was made under another pilot contract. Nothing was removed.");
  const pinned = targetForEnvironment(contract, proposal.environment, proposal.target);
  if (!pinned.ok) return refuse(pinned.code, pinned.message);
  if (proposal.target.account !== run.target.account || proposal.target.backend !== run.target.backend || proposal.target.workspace !== run.target.workspace) {
    return refuse("PROPOSAL_INVALID", "The removal proposal names another target than the run. Nothing was removed.");
  }
  const decision = authorizeRemoval({ operation: "REMOVE", contract, environment: run.environment, artifactSha256: run.artifactSha256 });
  if (!decision.authorized) return refuse("REMOVAL_NOT_AUTHORIZED", "Removing this run's working files is not authorized: " + decision.reason + ". Nothing was removed.");
  if (await holdsReservation(input.where.evidenceDir)) {
    return refuse("REMOVAL_RUN_IN_PROGRESS", "An apply or cleanup is in progress (or its ledger entry cannot be read), and its working files may be in use. Nothing was removed; run this again when it has ended.");
  }
  const requested = verifyRequestSignature({ request: proposal.request, artifactSha256: proposal.proposalSha256, environment: proposal.environment, requesterId: proposal.requesterId, contract, subject: "CLEANUP_REQUEST" });
  if (!requested.ok) return refuse(requested.code, requested.message + " Nothing was removed.");
  const verdict = verifyApprovalSet({ approvals: input.approvals, artifactSha256: proposal.proposalSha256, environment: proposal.environment, target: proposal.target, contract, now: input.now, nonces: input.nonces,
    subject: "CLEANUP", requester: { requesterId: requested.requesterId, publicKeyCanonical: requested.publicKeyCanonical } });
  if (!verdict.ok) return refuse(verdict.code, verdict.message + " Nothing was removed.");
  const recordPath = join(input.where.evidenceDir, run.artifactSha256 + REMOVAL_RECORD_SUFFIX);
  const existing = readRecord(recordPath, run);
  if (existing === "INVALID") return refuse("REMOVAL_RECORD_INVALID", "The removal record " + recordPath + " is not a removal record of this run. Nothing was removed; a person reviews it.");
  const last = existing?.removals.at(-1);
  if (last?.status === "IN_PROGRESS" && last.proposalSha256 !== proposal.proposalSha256) {
    return refuse("REMOVAL_RECORD_INVALID", "An interrupted removal of another proposal (" + last.proposalSha256.slice(0, 12) + ") is in the record. Finish that one first, with new approvals for it. Nothing was removed.");
  }
  const resumed = last?.status === "IN_PROGRESS" || last?.status === "STOPPED" ? last.proposalSha256 === proposal.proposalSha256 : false;
  const planned = planWorkspaceRemoval(run, input.where, input.now);
  if (!planned.ok) return planned;
  const deletes = planned.plan.items.filter((item) => proposal.items.some((p) => sameItem(p, item)) && (!resumed || last!.items.some((r) => !r.removed && sameItem(r, item))));
  return { ok: true, proposal, approvers: verdict.approvers.map((a) => a.approverId), requesterId: requested.requesterId, deletes, resumed, recordPath, plan: planned.plan };
}

/**
 * Removes one run's working files under an approved removal proposal, or says why not. `expected` is the list the person confirmed
 * (`prepareRemoval().deletes`): when the list computed here differs, nothing is consumed or removed.
 */
export async function removeWorkspace(input: RemovalInput & { expected: readonly string[] }, seams: RemovalTestSeams = {}): Promise<RemovalResult> {
  const ready = await prepareRemoval(input);
  if (!ready.ok) return ready;
  const paths = ready.deletes.map((item) => item.path);
  if (paths.length !== input.expected.length || paths.some((path, index) => path !== input.expected[index])) {
    return refuse("REMOVAL_SCOPE_CHANGED", "What would be removed changed after it was shown. Nothing was removed and no approval was consumed; run the command again to see the current list.");
  }
  const consumed = consumeApprovals(input.nonces, input.approvals);
  if (!consumed.ok) return refuse(consumed.code, consumed.message + " Nothing was removed.");
  const run = input.run;
  const existing = readRecord(ready.recordPath, run);
  if (existing === "INVALID") return refuse("REMOVAL_RECORD_INVALID", "The removal record changed while the removal was prepared. Nothing was removed; the approvals are spent.");
  const record: WorkspaceRemovalRecord = existing ?? { schemaVersion: 1, kind: "WORKSPACE_REMOVAL", artifactSha256: run.artifactSha256, environment: run.environment, kept: KEPT, removals: [] };
  const removal: WorkspaceRemoval = {
    proposalSha256: ready.proposal.proposalSha256, operatorId: input.operatorId, approvers: ready.approvers, startedAt: input.now.toISOString(), finishedAt: null, status: "IN_PROGRESS",
    authorization: "requester " + ready.requesterId + "; " + ready.approvers.length + " approval(s) (" + ready.approvers.join(", ") + ") under the cleanup domain; kill switch inactive",
    items: ready.deletes.map((item) => ({ ...item, removed: false })), heldForReview: ready.plan.heldForReview, skipped: ready.plan.skipped,
  };
  // A resumed removal of the same proposal ends its predecessor: the new entry carries on with what is left.
  const last = record.removals.at(-1);
  if (ready.resumed && last) last.status = "STOPPED";
  record.removals.push(removal);
  writeRecord(ready.recordPath, record);
  const remove = seams.removePath ?? ((path: string) => { if (lstatSync(path).isDirectory()) removeTree(path); else rmSync(path); });
  const roots = [join(input.where.preparationDir, run.environment), input.where.scratchParent].map((root) => { try { return realpathSync(root); } catch { return root; } });
  try {
    for (const item of removal.items) {
      // The kill switch is read again before each item: a person can stop a removal part-way.
      if (isKillSwitchActive(input.contract)) {
        removal.status = "STOPPED";
        writeRecord(ready.recordPath, record);
        const left = removal.items.filter((i) => !i.removed).length;
        return refuse("REMOVAL_STOPPED", "The kill switch became active during the removal. " + left + " path(s) remain, named in the record; the approvals are spent. Propose and approve again to finish.");
      }
      // Judged again right before it goes: still not a link, still directly in its folder, still no link or recovery file inside.
      const stat = lstatSync(item.path);
      if (stat.isSymbolicLink()) throw new PathRefused(item.path + " became a link");
      if (!roots.some((root) => directlyIn(root, realpathSync(item.path)))) throw new PathRefused(item.path + " moved out of the product's folders");
      if (stat.isDirectory()) { const m = measure(item.path); if (m.link || m.recovery) throw new PathRefused(item.path + " now holds a link or a recovery file"); }
      remove(item.path);
      item.removed = true;
      writeRecord(ready.recordPath, record);
    }
  } catch (error) {
    writeRecord(ready.recordPath, record);
    const left = removal.items.filter((item) => !item.removed).length;
    if (error instanceof PathRefused) return refuse("REMOVAL_PATH_CHANGED", "A working path changed into a link or moved (" + error.message + "). " + left + " path(s) were not removed; the record says which. A person reviews them.");
    return refuse("REMOVAL_FAILED", "The removal stopped part-way (" + ((error as NodeJS.ErrnoException).code ?? "ERROR") + "). " + left + " path(s) remain; the approvals are spent. Obtain new approvals for the same proposal and run the command again: it resumes from the record and removes only what is left.");
  }
  removal.status = "COMPLETE";
  removal.finishedAt = input.now.toISOString();
  writeRecord(ready.recordPath, record);
  return { ok: true, record, recordPath: ready.recordPath, removal, resumed: ready.resumed };
}
