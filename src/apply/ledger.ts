import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encryptEvidence, ensureEvidenceKey, readEncryptedEvidence } from "../evidence/vault.js";
import { HASH } from "./constants.js";
import { CLEANUP_SUFFIX, SUFFIX, type Check, type Refusal } from "./contract.js";
import { applyEvidenceProblems, cleanupEvidenceProblems } from "./evidence.js";
import type { ApplyEvidence, ApplyRefusalCode, ApplyResult, CleanupEvidence, CleanupResult } from "./types.js";

/**
 * The applied-artifact ledger's write side (its read side, `requireNotApplied`,
 * is in contract.ts and only asks whether `<hash>.apply.evidence` exists).
 *
 * An artifact is RESERVED with an exclusive create before the engine runs, so
 * two runs holding different approval sets cannot both proceed: one create
 * wins and the other is ARTIFACT_ALREADY_APPLIED. The reservation is replaced
 * by the evidence once the run ends. A process that dies in between leaves the
 * reservation behind, and a reserved artifact is never applied again: an owner
 * reviews the state, the lease and the cloud resources, then seals a new plan.
 * A reservation is not evidence (it does not pass `applyEvidenceProblems`), so
 * it never counts as promotion evidence.
 *
 * A cleanup keeps the same ledger discipline under the proposal's hash with its own suffix (`CLEANUP_SUFFIX`): one
 * reservation before the engine runs, replaced by cleanup evidence after. An apply entry and a cleanup entry never share
 * a name, so neither can stand for the other.
 */
type Reservation = { schemaVersion: 1; state: "RESERVED"; artifactSha256: string; reservedAt: string };
/** Which ledger an entry belongs to. Apply entries are the default everywhere, so every existing caller is unchanged. */
export type LedgerKind = "apply" | "cleanup";
const SUFFIX_OF: Readonly<Record<LedgerKind, string>> = { apply: SUFFIX, cleanup: CLEANUP_SUFFIX };
const RESERVATION_PURPOSE: Readonly<Record<LedgerKind, string>> = { apply: "apply-reservation", cleanup: "cleanup-reservation" };
const TAKEN: Readonly<Record<LedgerKind, { code: ApplyRefusalCode; message: string }>> = {
  apply: { code: "ARTIFACT_ALREADY_APPLIED", message: "this artifact has already been applied, or another run holds it" },
  cleanup: { code: "PROPOSAL_ALREADY_EXECUTED", message: "this cleanup proposal has already been executed, or another run holds it" },
};

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });
const pathOf = (dir: string, artifactSha256: string, kind: LedgerKind = "apply"): string => join(dir, artifactSha256 + SUFFIX_OF[kind]);

async function writableKey() {
  const { key, info } = await ensureEvidenceKey();
  return info.securePermissions ? key : undefined;
}

/** Creates the ledger entry exclusively, in state RESERVED. */
export async function reserveArtifact(artifactSha256: string, evidenceDir: string, now: Date, kind: LedgerKind = "apply"): Promise<Check> {
  if (!HASH.test(artifactSha256)) return refuse(kind === "apply" ? "ARTIFACT_INVALID" : "PROPOSAL_INVALID", "the " + (kind === "apply" ? "artifact" : "proposal") + " hash is not a SHA-256 digest");
  const key = await writableKey();
  if (!key) return refuse("EVIDENCE_REJECTED", "the evidence key permissions are insecure");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const reservation: Reservation = { schemaVersion: 1, state: "RESERVED", artifactSha256, reservedAt: now.toISOString() };
  try {
    await writeFile(pathOf(evidenceDir, artifactSha256, kind), JSON.stringify(encryptEvidence(RESERVATION_PURPOSE[kind], reservation, key)) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return refuse(TAKEN[kind].code, TAKEN[kind].message);
    throw error;
  }
  return { ok: true };
}

async function isReservation(path: string, artifactSha256: string): Promise<boolean> {
  try {
    const record = await readEncryptedEvidence<Partial<Reservation>>(path);
    return record?.state === "RESERVED" && record.artifactSha256 === artifactSha256;
  } catch {
    return false;
  }
}

/** Gives the artifact back, only while the engine has not run. Removes nothing but our own reservation. */
export async function releaseReservation(artifactSha256: string, evidenceDir: string, kind: LedgerKind = "apply"): Promise<void> {
  const path = pathOf(evidenceDir, artifactSha256, kind);
  if (await isReservation(path, artifactSha256)) await unlink(path).catch(() => undefined);
}

/** Replaces the reservation with the evidence in one rename, so the entry is never missing and never half-written. */
export async function finalizeArtifact(evidence: ApplyEvidence, evidenceDir: string): Promise<ApplyResult> {
  const problems = applyEvidenceProblems(evidence);
  if (problems.length > 0) return refuse("EVIDENCE_REJECTED", problems.slice(0, 8).join("; "));
  const key = await writableKey();
  if (!key) return refuse("EVIDENCE_REJECTED", "the evidence key permissions are insecure");
  const path = pathOf(evidenceDir, evidence.artifactSha256);
  if (!(await isReservation(path, evidence.artifactSha256))) return refuse("EVIDENCE_REJECTED", "the artifact is not reserved by this run");
  // Staged beside the entry and renamed over it. A failed write or rename throws, the artifact stays reserved,
  // and any staging file left behind is encrypted evidence like the entry itself.
  const staged = join(evidenceDir, evidence.artifactSha256 + ".tmp-" + randomBytes(6).toString("hex"));
  await writeFile(staged, JSON.stringify(encryptEvidence("apply", evidence, key)) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(staged, path);
  return { ok: true, evidence };
}

/** The cleanup ledger's finalize: the same one-rename replacement of the reservation under the proposal's hash, with cleanup evidence. */
export async function finalizeCleanup(evidence: CleanupEvidence, evidenceDir: string): Promise<CleanupResult> {
  const problems = cleanupEvidenceProblems(evidence);
  if (problems.length > 0) return refuse("EVIDENCE_REJECTED", problems.slice(0, 8).join("; "));
  const key = await writableKey();
  if (!key) return refuse("EVIDENCE_REJECTED", "the evidence key permissions are insecure");
  const path = pathOf(evidenceDir, evidence.proposalSha256, "cleanup");
  if (!(await isReservation(path, evidence.proposalSha256))) return refuse("EVIDENCE_REJECTED", "the proposal is not reserved by this run");
  const staged = join(evidenceDir, evidence.proposalSha256 + ".tmp-" + randomBytes(6).toString("hex"));
  await writeFile(staged, JSON.stringify(encryptEvidence("cleanup", evidence, key)) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(staged, path);
  return { ok: true, evidence };
}

/** The finished cleanup evidence for a proposal, or undefined when it never ran, is still reserved, or is not evidence. */
export async function readCleanupEvidence(proposalSha256: string, evidenceDir: string): Promise<CleanupEvidence | undefined> {
  if (!HASH.test(proposalSha256)) return undefined;
  try {
    const record = await readEncryptedEvidence<unknown>(pathOf(evidenceDir, proposalSha256, "cleanup"));
    if (cleanupEvidenceProblems(record).length > 0) return undefined;
    const evidence = record as CleanupEvidence;
    return evidence.proposalSha256 === proposalSha256 ? evidence : undefined;
  } catch {
    return undefined;
  }
}

/** True while any ledger entry is a reservation, or cannot be read (unknown counts as held): a run may be in flight or may have died holding scratch state. */
export async function holdsReservation(evidenceDir: string): Promise<boolean> {
  let names: string[];
  try { names = await readdir(evidenceDir); } catch { return false; }
  for (const name of names.filter((entry) => entry.endsWith(SUFFIX) || entry.endsWith(CLEANUP_SUFFIX))) {
    try {
      if ((await readEncryptedEvidence<Partial<Reservation>>(join(evidenceDir, name)))?.state === "RESERVED") return true;
    } catch { return true; }
  }
  return false;
}
