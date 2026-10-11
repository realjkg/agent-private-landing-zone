import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encryptEvidence, ensureEvidenceKey, readEncryptedEvidence } from "../evidence/vault.js";
import { HASH } from "./constants.js";
import { SUFFIX, type Check, type Refusal } from "./contract.js";
import { applyEvidenceProblems } from "./evidence.js";
import type { ApplyEvidence, ApplyRefusalCode, ApplyResult } from "./types.js";

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
 */
type Reservation = { schemaVersion: 1; state: "RESERVED"; artifactSha256: string; reservedAt: string };

const refuse = (code: ApplyRefusalCode, message: string): Refusal => ({ ok: false, code, message });
const pathOf = (dir: string, artifactSha256: string): string => join(dir, artifactSha256 + SUFFIX);

async function writableKey() {
  const { key, info } = await ensureEvidenceKey();
  return info.securePermissions ? key : undefined;
}

/** Creates the ledger entry exclusively, in state RESERVED. */
export async function reserveArtifact(artifactSha256: string, evidenceDir: string, now: Date): Promise<Check> {
  if (!HASH.test(artifactSha256)) return refuse("ARTIFACT_INVALID", "the artifact hash is not a SHA-256 digest");
  const key = await writableKey();
  if (!key) return refuse("EVIDENCE_REJECTED", "the evidence key permissions are insecure");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const reservation: Reservation = { schemaVersion: 1, state: "RESERVED", artifactSha256, reservedAt: now.toISOString() };
  try {
    await writeFile(pathOf(evidenceDir, artifactSha256), JSON.stringify(encryptEvidence("apply-reservation", reservation, key)) + "\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return refuse("ARTIFACT_ALREADY_APPLIED", "this artifact has already been applied, or another run holds it");
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
export async function releaseReservation(artifactSha256: string, evidenceDir: string): Promise<void> {
  const path = pathOf(evidenceDir, artifactSha256);
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

/** True while any ledger entry is a reservation, or cannot be read (unknown counts as held): a run may be in flight or may have died holding scratch state. */
export async function holdsReservation(evidenceDir: string): Promise<boolean> {
  let names: string[];
  try { names = await readdir(evidenceDir); } catch { return false; }
  for (const name of names.filter((entry) => entry.endsWith(SUFFIX))) {
    try {
      if ((await readEncryptedEvidence<Partial<Reservation>>(join(evidenceDir, name)))?.state === "RESERVED") return true;
    } catch { return true; }
  }
  return false;
}
