import { readerOf, unexpectedOf, type ReaderInput, type ResourceCheck } from "../observe/verify.js";
import type { CleanupProposal } from "./cleanup-proposal.js";
import { basesOf, type LeftoverBasis, type LeftoverResource, type LeftoversRecord } from "./run-records.js";
import type { CleanupEvidence } from "./types.js";

/**
 * The independent leftover check after a cleanup (docs/observe-and-cleanup.md): for every resource the approved proposal
 * listed, what the cloud says now, read through the same read-only boundary the observation used (Cloud Control, the
 * DISCOVERY identity) and never through the engine. It deletes nothing and never trusts the cleanup's own exit code:
 * a resource is CONFIRMED_DELETED only when the cloud no longer returns it (or, for a setting Cloud Control cannot read
 * alone, when the resource it belongs to is gone; a data-bearing type is never read and never confirmed this way). COMPLETE is reported only when every proposed deletion is confirmed
 * and a complete deletion-unit sweep found nothing else of this run outside the state: the per-resource checks can only
 * speak for the addresses the state named. When the run carries no unit tag the sweep is NOT_AVAILABLE and the most the
 * record says is KNOWN_ADDRESSES_CONFIRMED, which is not completion (docs/observe-and-cleanup.md; #39, the #235 handoff).
 * Anything pending or unknown keeps the disposition INCOMPLETE and says what a person does next.
 */
export type LeftoversInput = {
  proposal: CleanupProposal;
  /** The finished cleanup evidence, when the cleanup ran; absent before it ran or when it is still reserved. */
  cleanup: CleanupEvidence | undefined;
  cleanupEvidenceSha256: string | null;
  /** The deletion-unit tag of this run (from the proposal, which took it from the blueprint record), or null when the engine sealed none. */
  unitId: string | null;
  /** Every identifier the blueprint record holds for this run's resources (ARNs and ids): what a tag listing may name without being a leftover. */
  knownIdentifiers: readonly string[];
  /**
   * GCP_REST only (#359 review N1): whether an observation of this run passed the sweep's positive control. Absent for the other
   * clouds, whose records are unchanged. False: the record says strays UNPROVEN and is never COMPLETE.
   */
  sweepProven?: boolean;
  /** SHA-256 of the verifier program that ran (the aws CLI), or null when the reader runs in process (Azure) or in a test. */
  verifierBinarySha256: string | null;
  now: Date;
} & ReaderInput;

type Checked = ResourceCheck;

const finished = (cleanup: CleanupEvidence | undefined): boolean => cleanup !== undefined && cleanup.outcome === "SUCCEEDED";

/**
 * A resource the independent reader did not read. A setting (a bucket's versioning) is settled by its parent's confirmed
 * absence. A data-bearing type (a Lambda function, an SSM parameter, a Secrets Manager secret: DATA_BEARING_READ_EXCLUDED)
 * is not a setting and has no parent: its only read returns application data or secret contents, so it is never read, and
 * nothing here confirms its deletion. It stays UNKNOWN, and the record stays INCOMPLETE.
 */
function notCheckableDisposition(check: Checked, parentAbsent: boolean): Pick<LeftoverResource, "disposition" | "basis" | "reason"> {
  if (check.reason === "DATA_BEARING_READ_EXCLUDED") {
    return { disposition: "UNKNOWN", basis: "NOT_INDEPENDENTLY_CHECKABLE", reason: "DATA_BEARING_READ_EXCLUDED: its only read returns application data or secret contents, so the independent reader never reads it, and nothing confirms its deletion" };
  }
  return parentAbsent ? { disposition: "CONFIRMED_DELETED", basis: "PARENT_ABSENT" }
    : { disposition: "UNKNOWN", basis: "NOT_INDEPENDENTLY_CHECKABLE", reason: "a setting the independent reader cannot read alone, and the resource it belongs to is not confirmed gone" };
}

/** One proposed deletion's disposition from its own check and, for a setting, its parent's. */
function dispositionOf(check: Checked, parentAbsent: boolean, cleanup: CleanupEvidence | undefined, bases: { absent: LeftoverBasis; present: LeftoverBasis }): Pick<LeftoverResource, "disposition" | "basis" | "reason"> {
  if (check.existence === "ABSENT") return { disposition: "CONFIRMED_DELETED", basis: bases.absent };
  if (check.existence === "NOT_CHECKABLE") return notCheckableDisposition(check, parentAbsent);
  if (check.existence === "PRESENT") {
    if (check.pendingDeletion) return { disposition: "DELETION_PENDING", basis: bases.present, reason: "the cloud reports the resource scheduled for deletion; it is removed after its waiting period" };
    return finished(cleanup)
      ? { disposition: "STILL_PRESENT", basis: bases.present, reason: "the cleanup reported success but the resource still exists" }
      : { disposition: "DELETION_PENDING", basis: "CLEANUP_NOT_FINISHED", reason: cleanup === undefined ? "the cleanup has not run" : "the cleanup ended " + cleanup.outcome };
  }
  return { disposition: "UNKNOWN", basis: "CHECK_FAILED", reason: check.reason ?? "CLI_ERROR" };
}

/** Reads every proposed resource and writes nothing; the caller stores the record. */
export async function verifyLeftovers(input: LeftoversInput): Promise<LeftoversRecord> {
  const { proposal, cleanup } = input;
  const reader = readerOf(input);
  const bases = basesOf(reader.verifier);
  const checks = new Map<string, Checked>();
  for (const item of proposal.deletes) {
    checks.set(item.address, await reader.check({ address: item.address, type: item.type, arn: item.identifier?.startsWith("arn:") ? item.identifier : null,
      id: item.identifier !== null && !item.identifier.startsWith("arn:") ? item.identifier : null, origin: "IN_PLAN" }));
  }
  // A setting (a bucket's versioning, a role's policy attachment) shares its parent's identifier: when a checkable resource with the same identifier is gone, so is the setting.
  const absentIdentifiers = new Set([...checks.values()].filter((check) => check.existence === "ABSENT" && check.identifier !== null).map((check) => check.identifier as string));
  const resources: LeftoverResource[] = [];
  for (const item of proposal.deletes) {
    const check = checks.get(item.address)!;
    const parentAbsent = item.identifier !== null && absentIdentifiers.has(item.identifier);
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, ...dispositionOf(check, parentAbsent, cleanup, bases) });
  }
  // A resource that was already gone when the cleanup was proposed is read again, with the same rules: a check that never
  // ran (a setting the independent reader cannot read alone) proves nothing by itself, only its parent's confirmed absence does.
  for (const item of proposal.alreadyAbsent) {
    const check = await reader.check({ address: item.address, type: item.type, arn: item.identifier?.startsWith("arn:") ? item.identifier : null,
      id: item.identifier !== null && !item.identifier.startsWith("arn:") ? item.identifier : null, origin: "IN_PLAN" });
    const parentAbsent = item.identifier !== null && absentIdentifiers.has(item.identifier);
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, ...(check.existence === "ABSENT" ? { disposition: "CONFIRMED_DELETED" as const, basis: bases.absent }
      : check.existence === "NOT_CHECKABLE" ? notCheckableDisposition(check, parentAbsent)
      : check.existence === "PRESENT" ? { disposition: "STILL_PRESENT" as const, basis: bases.present, reason: "it was absent when the cleanup was proposed and exists again" }
      : { disposition: "UNKNOWN" as const, basis: "CHECK_FAILED" as const, reason: check.reason ?? "CLI_ERROR" }) });
  }
  // Everything the proposal kept is a retention decision with an owner and a reason: a protected object (a resource group, an
  // identity or grant, deployment history, the state backend) is the pilot owner's; a resource this run did not create is the
  // environment owner's. Neither is ever read as deleted, and the record never says the environment is gone.
  for (const item of proposal.excluded) {
    // A resource of an unreviewed type (TYPE_UNREVIEWED) is retained and named too, on its own basis: a person still decides about it, so it keeps the record INCOMPLETE.
    resources.push({ address: item.address, type: item.type, identifier: item.identifier, disposition: "INTENTIONALLY_RETAINED", basis: item.ownership === "TYPE_UNREVIEWED" ? "UNREVIEWED_TYPE" : "RETENTION_DECISION", reason: item.ownership + ": " + item.reason, owner: item.retainedBy });
  }
  // Resources outside the engine's state: only findable by the run's unit tag, which the pilot apply does not set yet.
  let sweep: LeftoversRecord["sweep"] = "NOT_AVAILABLE";
  if (input.unitId !== null) {
    const known = { entries: [
      ...proposal.deletes.concat(proposal.alreadyAbsent as never[], proposal.excluded as never[]).map((x) => ({ address: x.address, type: x.type, arn: x.identifier?.startsWith("arn:") ? x.identifier : null,
        id: x.identifier !== null && !x.identifier.startsWith("arn:") ? x.identifier : null, origin: "IN_PLAN" as const })),
      // The blueprint knows a resource by ARN and id; the proposal names one of them, the tagging API the other.
      ...input.knownIdentifiers.map((identifier) => ({ address: "(blueprint)", type: "known", arn: identifier.startsWith("arn:") ? identifier : null, id: identifier.startsWith("arn:") ? null : identifier, origin: "IN_PLAN" as const })),
    ], missing: [] };
    const listed = unexpectedOf(known, await reader.listTagged(input.unitId), reader.verifier);
    sweep = listed.complete ? "COMPLETE" : "INCOMPLETE";
    for (const arn of listed.unexpected) resources.push({ address: "(not in state)", type: "tagged", identifier: arn, disposition: "STILL_PRESENT", basis: bases.present, reason: "carries this run's tag and is not in the state" });
  }
  const known = resources.length > 0 && resources.every((x) => x.disposition === "CONFIRMED_DELETED" || x.disposition === "INTENTIONALLY_RETAINED");
  // COMPLETE needs both: every named resource settled, and a complete sweep by the run's unit tag that found nothing else.
  const unreviewed = resources.filter((x) => x.basis === "UNREVIEWED_TYPE");
  // GCP_REST: an empty sweep proves "no strays" only after an observation showed the sweep listing the run's own topic (#359 review N1).
  const strays: LeftoversRecord["strays"] = reader.verifier !== "GCP_REST" ? undefined : input.sweepProven === true ? "PROVEN" : "UNPROVEN";
  const unproven = strays === "UNPROVEN" && known && unreviewed.length === 0 && sweep === "COMPLETE";
  const disposition: LeftoversRecord["disposition"] = !known || unreviewed.length > 0 || unproven ? "INCOMPLETE" : sweep === "COMPLETE" ? "COMPLETE" : sweep === "NOT_AVAILABLE" ? "KNOWN_ADDRESSES_CONFIRMED" : "INCOMPLETE";
  const open = resources.filter((x) => x.disposition !== "CONFIRMED_DELETED" && x.disposition !== "INTENTIONALLY_RETAINED");
  const retained = resources.filter((x) => x.disposition === "INTENTIONALLY_RETAINED");
  // COMPLETE says only what the record shows: how many listed resources are confirmed gone, whether an approved cleanup ran at all, what was kept (left in
  // place, not read), and that the environment is not retired. No cloud's list of protected kinds is recited (review 6411551942, N7 and N8).
  const gone = resources.filter((x) => x.disposition === "CONFIRMED_DELETED").length;
  const nextAction = disposition === "COMPLETE" ? (gone === 0 ? "Nothing was on the delete list, so nothing was deleted, and nothing else carries this run's tag."
      : cleanup === undefined ? "No cleanup ran; the " + gone + " listed resource(s) are confirmed gone anyway, and nothing else carries this run's tag."
      : "Approved resources deleted: every listed resource (" + gone + ") is confirmed gone and nothing else carries this run's tag.") +
      (retained.length > 0 ? " Protected or pre-existing objects intentionally retained (" + retained.length + ", kept by " + [...new Set(retained.map((x) => x.owner))].sort().join(" and ") + "); they were never on the list, were left in place and were not read." : "") +
      " Full environment retirement is a separate, reviewed action and remains outstanding; this record does not claim the environment retired."
    : unproven
      ? "Every proposed resource is confirmed gone and the sweep by the run's labels listed nothing, but \"no strays\" is UNPROVEN: no observation of this run ever showed the sweep listing the run's own topic, so an empty sweep may only mean the query matches nothing (GF3). This is not a clean leftovers result. Record it as a GF3 finding; a person confirms by hand (Cloud Asset or the console) that nothing else carries the run's labels."
    : disposition === "KNOWN_ADDRESSES_CONFIRMED"
      ? "Every proposed resource is confirmed gone, but resources outside the engine's state were not searched for: this run carries no deletion-unit tag, so the cleanup is not independently complete. A person confirms by hand that nothing else of this run remains, or the run is applied with its unit tag so the sweep can run."
    : open.some((x) => x.disposition === "DELETION_PENDING" && x.basis === "CLEANUP_NOT_FINISHED") ? (cleanup === undefined
      ? "Run the approved cleanup, then verify leftovers again."
      : "The cleanup ended " + cleanup.outcome + ". A person reviews the state and the cloud resources by hand (docs/act-pilot-apply.md); do not propose a second cleanup until that review is done.")
    : open.some((x) => x.disposition === "DELETION_PENDING") ? "Wait for the deletion window to pass, then verify leftovers again."
    : open.some((x) => x.disposition === "STILL_PRESENT") ? "The cleanup did not remove everything it was approved for. A person reviews the listed resources by hand; a new proposal is needed for anything still to delete."
    : unreviewed.length > 0 ? "The run created " + unreviewed.length + " resource(s) of a type not on the reviewed leaf allowlist (" + [...new Set(unreviewed.map((x) => x.type))].sort().join(", ") + "). They were kept and never deleted; a person deletes or keeps them by hand, and a type joins the allowlist only by review. Then verify leftovers again."
    : sweep === "INCOMPLETE" ? "The tag listing was incomplete; verify leftovers again when the tagging API answers completely."
    : open.every((x) => x.disposition === "UNKNOWN" && x.basis === "NOT_INDEPENDENTLY_CHECKABLE")
      ? "The remaining resources cannot be read independently (a setting, or a type the reader cannot address) and no confirmed-gone parent speaks for them. A person confirms by hand that they are gone; the record never assumes it."
    : "Fix the DISCOVERY identity's access or the verifier, then verify leftovers again.";
  return {
    schemaVersion: 1, kind: "LEFTOVERS", proposalSha256: proposal.proposalSha256, artifactSha256: proposal.artifactSha256, applyEvidenceSha256: proposal.applyEvidenceSha256,
    cleanupEvidenceSha256: input.cleanupEvidenceSha256, environment: proposal.environment, target: { ...proposal.target }, sourceCommit: proposal.sourceCommit, contractSha256: proposal.contractSha256,
    verifier: reader.verifier, verifierBinarySha256: input.verifierBinarySha256, resources, disposition, sweep, nextAction, observedAt: input.now.toISOString(),
    ...(strays ? { strays } : {}),
  };
}
